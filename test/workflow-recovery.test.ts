import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pipeline } from "../src/workflow/pipeline.js";
import { Scheduler } from "../src/workflow/scheduler.js";
import { requirementsSchema, taskEnvelopeSchema, taskResultSchema } from "../src/workflow/contracts.js";
import type { CapabilityReport, EvidenceBundle, WorkflowAdapter } from "../src/workflow/adapters.js";

/**
 * P9 item 3: failure recovery.
 *
 * Three things a pipeline has to survive: the child crashing, the child
 * timing out, and a stage that blocked. Each has a defined outcome here,
 * because "it hung" is not an outcome.
 */

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "one criterion",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "the check passes",
        kind: "automated",
        verification_command: "node --test",
      },
    ],
  },
]);

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-1",
  role: "developer",
  objective: "do the work",
  repo_path: "C:/repo",
  base_revision: "init",
  allowed_paths: ["src"],
  deliverables: ["src/x.js"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --test", expect_exit: 0 }],
  timeout_seconds: 60,
});

const good = taskResultSchema.parse({
  task_id: "T-1",
  status: "succeeded",
  summary: "done",
  changed_files: ["src/x.js"],
  commands: [{ command: "node --test", exit_code: 0 }],
  test_results: [{ name: "check", outcome: "passed", acceptance_ids: ["AC-1"] }],
});

function stub(behaviour: "crash" | "timeout" | "ok"): WorkflowAdapter {
  return {
    id: `stub-${behaviour}`,
    label: "stub",
    capabilityCheck: async (): Promise<CapabilityReport> => ({
      adapter_id: "stub",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: true,
      can_resume: true,
      detail: "",
    }),
    execute: async () => {
      if (behaviour === "crash") throw new Error("child crashed");
      if (behaviour === "timeout") throw new Error("child timed out");
      return good;
    },
    resume: async () => {
      if (behaviour === "crash") throw new Error("child crashed again");
      if (behaviour === "timeout") throw new Error("child timed out again");
      return good;
    },
    cancel: async () => {},
    collectEvidence: async (): Promise<EvidenceBundle> => ({
      task_id: "T-1",
      changed_files: ["src/x.js"],
      command_records: [],
      artifact_paths: [],
    }),
    observedChanges: () => [{ path: "src/x.js", kind: "modified" as const }],
    claimDiscrepancies: () => [],
  };
}

test("a child that crashes is reported as an adapter error, and the stage stays put", async () => {
  const pipeline = new Pipeline("IMPLEMENT");
  const scheduler = new Scheduler({ adapter: stub("crash"), requirements, pipeline, maxAttempts: 2 });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.reason, "adapter-error");
  assert.match(outcome.failure!.detail, /crashed/);
  assert.equal(pipeline.stage, "IMPLEMENT", "a crash must not move the stage");
});

test("a timeout is reported separately from a crash", async () => {
  const pipeline = new Pipeline("IMPLEMENT");
  const scheduler = new Scheduler({ adapter: stub("timeout"), requirements, pipeline, maxAttempts: 1 });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.failure?.reason, "adapter-error");
  assert.match(outcome.failure!.detail, /timed out/);
});

test("a blocked stage returns to the stage that blocked it", () => {
  const pipeline = new Pipeline("REVIEW");
  const blocked = pipeline.advance({ to: "BLOCKED", note: "reviewer unavailable" });
  assert.equal(blocked.ok, true);
  assert.equal(pipeline.stage, "BLOCKED");
  assert.equal(pipeline.isBlocked, true);

  const unnamed = pipeline.advance({ to: "VERIFY" });
  assert.equal(unnamed.ok, false);
  assert.equal(unnamed.refused?.reason, "illegal-transition");

  const wrong = pipeline.advance({ to: "VERIFY", blockedFrom: "IMPLEMENT" });
  assert.equal(wrong.ok, false);

  const resumed = pipeline.advance({ to: "REVIEW", blockedFrom: "REVIEW" });
  assert.equal(resumed.ok, true);
  assert.equal(pipeline.stage, "REVIEW");
  assert.equal(pipeline.isBlocked, false);
});

test("a blocked pipeline can still take the rework edge after resuming", () => {
  const pipeline = new Pipeline("VERIFY");
  pipeline.advance({ to: "BLOCKED", note: "test rig down" });
  pipeline.advance({ to: "VERIFY", blockedFrom: "VERIFY" });
  const rework = pipeline.advance({ to: "IMPLEMENT" });
  assert.equal(rework.ok, true, "rework must be available again after resume");
  assert.equal(pipeline.stage, "IMPLEMENT");
});

test("a refusal does not corrupt the history, and a later success is recorded cleanly", async () => {
  const pipeline = new Pipeline("IMPLEMENT");
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/x.js"],
  });

  let calls = 0;
  const adapter: WorkflowAdapter = {
    ...stub("ok"),
    execute: async () => {
      calls += 1;
      return thin;
    },
    resume: async () => {
      calls += 1;
      return good;
    },
  };
  const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 2 });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, true);
  assert.equal(calls, 2);
  assert.equal(outcome.attempts.length, 2);
  assert.notEqual(outcome.attempts[0]?.refusal, undefined);
  assert.equal(outcome.attempts[1]?.refusal, undefined);
  assert.equal(pipeline.history.length, 0, "runTask must not write stage history");
});

test("a persisted failure survives a restart of the scheduler object", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-state-"));
  const pipeline = new Pipeline("IMPLEMENT");
  const scheduler = new Scheduler({ adapter: stub("crash"), requirements, pipeline, maxAttempts: 1, stateDir });
  await scheduler.runTask(envelope);

  const failureFile = path.join(stateDir, "tasks", "T-1", "failure.json");
  assert.equal(fs.existsSync(failureFile), true, "the failure must be on disk");
  const parsed = JSON.parse(fs.readFileSync(failureFile, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.reason, "adapter-error");
  assert.match(String(parsed.detail), /crashed/);
  assert.equal(parsed.taskId, "T-1");
  fs.rmSync(stateDir, { recursive: true, force: true });
});
