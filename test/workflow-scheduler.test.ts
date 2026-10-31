import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../src/workflow/scheduler.js";
import { Pipeline } from "../src/workflow/pipeline.js";
import { requirementsSchema, taskEnvelopeSchema, taskResultSchema } from "../src/workflow/contracts.js";
import type { TaskEnvelope, TaskResult } from "../src/workflow/contracts.js";
import type { CapabilityReport, EvidenceBundle, WorkflowAdapter } from "../src/workflow/adapters.js";

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "parser reads the fixture",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "fixture parses",
        kind: "automated",
        verification_command: "node --test fixture/parser.test.js",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "output reads correctly",
        kind: "manual",
        manual_check: { owner: "He", procedure: "read fixture/out.txt" },
      },
    ],
  },
]);

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-1",
  role: "developer",
  objective: "write the parser",
  repo_path: "C:/repo",
  base_revision: "abc",
  allowed_paths: ["src"],
  deliverables: ["src/parser.js"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --test fixture/parser.test.js", expect_exit: 0 }],
});

const goodResult = taskResultSchema.parse({
  task_id: "T-1",
  status: "succeeded",
  summary: "parser written",
  changed_files: ["src/parser.js"],
  commands: [{ command: "node --test fixture/parser.test.js", exit_code: 0 }],
  test_results: [{ name: "fixture", outcome: "passed", acceptance_ids: ["AC-1"] }],
});

/** A scripted adapter: each call pops the next scripted result. */
function scriptedAdapter(script: {
  results?: Array<TaskResult | Error>;
  observed?: string[];
  discrepancies?: Array<{ command: string; problems: string[] }>;
}): WorkflowAdapter & {
  executeCount: number;
  resumeCount: number;
} {
  let index = 0;
  const adapter = {
    id: "scripted",
    label: "scripted",
    executeCount: 0,
    resumeCount: 0,
    capabilityCheck: async (): Promise<CapabilityReport> => ({
      adapter_id: "scripted",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: true,
      can_resume: true,
      detail: "",
    }),
    execute: async (): Promise<TaskResult> => {
      adapter.executeCount += 1;
      const next = script.results?.[index] ?? goodResult;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    resume: async (): Promise<TaskResult> => {
      adapter.resumeCount += 1;
      const next = script.results?.[index] ?? goodResult;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    cancel: async (): Promise<void> => {},
    collectEvidence: async (): Promise<EvidenceBundle> => ({
      task_id: "T-1",
      changed_files: script.observed ?? ["src/parser.js"],
      command_records: [],
      artifact_paths: [],
    }),
    observedChanges: () => script.observed?.map((p) => ({ path: p, kind: "modified" as const })),
    claimDiscrepancies: () => script.discrepancies ?? [],
  };
  return adapter;
}

const fixedClock = () => new Date("2026-10-31T14:00:00Z");

test("a passing task advances the pipeline and records the attempt", async () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, true);
  assert.equal(pipeline.stage, "IMPLEMENT", "a task run does not move the stage");
  assert.equal(outcome.attempts.length, 1);
  assert.equal(outcome.attempts[0]?.refusal, undefined);
});

test("advanceStage is the only thing that moves the pipeline, and only on a passing gate", async () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  await scheduler.runTask(envelope);

  const good = scheduler.advanceStage("REVIEW", {
    requirements,
    tasks: [envelope],
    envelope,
    result: goodResult,
    deliveredArtifact: "abc",
    changedFiles: ["src/parser.js"],
  });
  assert.equal(good.ok, true);
  assert.equal(pipeline.stage, "REVIEW");
});

test("advanceStage refuses when the combined evidence does not clear the gate", () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.js"],
  });
  const refused = scheduler.advanceStage("REVIEW", {
    requirements,
    tasks: [envelope],
    envelope,
    result: thin,
    deliveredArtifact: "abc",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused?.verdict?.gate, "G2");
  assert.equal(pipeline.stage, "IMPLEMENT");
});

test("advanceStage forwards review findings to G3 instead of dropping them", () => {
  const pipeline = new Pipeline("REVIEW", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  // An explicit empty review means "reviewed and clean". If advanceStage
  // dropped the field, G3 would see undefined and report "no review supplied".
  const outcome = scheduler.advanceStage("VERIFY", { reviewFindings: [] });
  assert.equal(outcome.ok, true, outcome.refused?.detail);
  assert.equal(outcome.record?.gate, "G3");
});

test("advanceStage forwards verifications to G4 instead of dropping them", () => {
  const pipeline = new Pipeline("VERIFY", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = scheduler.advanceStage("INTEGRATE", {
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "node --test exit 0", at: "2026-10-31T13:00:00Z" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output", at: "2026-10-31T13:05:00Z" },
    ],
  });
  assert.equal(outcome.ok, true, outcome.refused?.detail);
  assert.equal(outcome.record?.gate, "G4");
});

test("advanceStage forwards a recorded acceptance to G5 instead of dropping it", () => {
  const pipeline = new Pipeline("ACCEPT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = scheduler.advanceStage("DELIVER", {
    requirements,
    deliveredArtifact: "build-abc",
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "node --test exit 0", at: "2026-10-31T13:00:00Z" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output", at: "2026-10-31T13:05:00Z" },
    ],
    recorded: {
      G5: {
        by: "He",
        at: "2026-10-31T13:20:00Z",
        note: "read the test output and the diff",
        artifact: "build-abc",
        accepted_ac_ids: ["AC-1", "AC-2"],
      },
    },
  });
  assert.equal(outcome.ok, true, outcome.refused?.detail);
  assert.equal(outcome.record?.gate, "G5");
});

test("a refused task is retried and the retry sees the refusal", async () => {
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.js"],
  });
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const adapter = scriptedAdapter({ results: [thin, goodResult] });
  const scheduler = new Scheduler({ adapter, requirements, pipeline, now: fixedClock, maxAttempts: 2 });

  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, true, "the second attempt should pass");
  assert.equal(adapter.executeCount, 1);
  assert.equal(adapter.resumeCount, 1, "the retry must go through resume, not a fresh execute");
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.attempts[0]?.refusal === undefined, false);
  assert.equal(outcome.attempts[1]?.refusal === undefined, true);
  assert.match(outcome.attempts[1]!.envelope.background, /Previous refusal/);
});

test("exhausting attempts reports a failure with the last refusal", async () => {
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.js"],
  });
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({ results: [thin, thin] }),
    requirements,
    pipeline,
    now: fixedClock,
    maxAttempts: 2,
  });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.reason, "attempts-exhausted");
  assert.match(outcome.failure!.detail, /verification command was not run|no test result/i);
  assert.equal(pipeline.stage, "IMPLEMENT", "the stage must not move");
  assert.equal(pipeline.history.length, 0);
});

test("an adapter that throws is reported as an adapter error, not a gate refusal", async () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({ results: [new Error("binary not found")] }),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.reason, "adapter-error");
  assert.match(outcome.failure!.detail, /binary not found/);
});

test("observed changes from the adapter are what the gate judges", async () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({ observed: ["src/parser.js", "README.md"] }),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, false, "a write outside src/ must be refused");
  assert.match(outcome.attempts[0]!.refusal ?? "", /README\.md/);
});

test("transcript discrepancies block the attempt even when the result looks clean", async () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({
      discrepancies: [{ command: "(stdout)", problems: ["the output shows 3 failing, but a pass was claimed"] }],
    }),
    requirements,
    pipeline,
    now: fixedClock,
  });
  const outcome = await scheduler.runTask(envelope);
  assert.equal(outcome.ok, false);
  assert.match(outcome.attempts[0]!.refusal ?? "", /3 failing/);
});

test("runPlan runs tasks in dependency order", async () => {
  const order: string[] = [];
  const pipeline = new Pipeline("PLAN", fixedClock);
  const t1 = taskEnvelopeSchema.parse({ ...envelope, task_id: "A", acceptance_ids: ["AC-1"] });
  const t2 = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "B",
    acceptance_ids: ["AC-2"],
    dependencies: ["A"],
  });

  const adapter: WorkflowAdapter = {
    id: "ordered",
    label: "ordered",
    capabilityCheck: async () => ({
      adapter_id: "ordered",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: true,
      can_resume: true,
      detail: "",
    }),
    execute: async (env: TaskEnvelope) => {
      order.push(env.task_id);
      // The result must answer the envelope it was given, including which
      // acceptance criteria it claims to satisfy.
      return {
        ...goodResult,
        task_id: env.task_id,
        changed_files: env.deliverables,
        test_results: env.acceptance_ids.map((ac) => ({
          name: `check ${ac}`,
          outcome: "passed" as const,
          acceptance_ids: [ac],
        })),
      };
    },
    resume: async () => goodResult,
    cancel: async () => {},
    collectEvidence: async () => ({
      task_id: "x",
      changed_files: ["src/parser.js"],
      command_records: [],
      artifact_paths: [],
    }),
  };

  const scheduler = new Scheduler({ adapter, requirements, pipeline, now: fixedClock });
  // Both tasks aim at DISPATCH, which is gated by G1. Supply the whole plan so
  // G1 sees both tasks and their ordering.
  const result = await scheduler.runPlan([t1, t2]);
  assert.deepEqual(order, ["A", "B"], "B must not run before A");
  assert.ok(result.completed.includes("A"));
  assert.ok(result.completed.includes("B"));
});

test("runPlan skips a task whose dependency failed", async () => {
  const pipeline = new Pipeline("PLAN", fixedClock);
  const t1 = taskEnvelopeSchema.parse({ ...envelope, task_id: "A" });
  const t2 = taskEnvelopeSchema.parse({ ...envelope, task_id: "B", dependencies: ["A"] });
  const failing: WorkflowAdapter = {
    id: "failing",
    label: "failing",
    capabilityCheck: async () => ({
      adapter_id: "failing",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: false,
      can_resume: false,
      detail: "",
    }),
    execute: async () => {
      throw new Error("cannot run");
    },
    resume: async () => {
      throw new Error("cannot run");
    },
    cancel: async () => {},
    collectEvidence: async () => ({
      task_id: "x",
      changed_files: [],
      command_records: [],
      artifact_paths: [],
    }),
  };
  const scheduler = new Scheduler({ adapter: failing, requirements, pipeline, now: fixedClock });
  const result = await scheduler.runPlan([t1, t2]);
  assert.ok(result.failed.some((f) => f.taskId === "A"));
  assert.ok(result.skipped.some((s) => s.taskId === "B" && /dependency A failed/.test(s.because)));
});

test("attempts are persisted when a state directory is configured", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-state-"));
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({}),
    requirements,
    pipeline,
    now: fixedClock,
    stateDir,
  });
  await scheduler.runTask(envelope);
  const file = path.join(stateDir, "tasks", "T-1", "attempt-1.json");
  assert.equal(fs.existsSync(file), true, "the attempt record must be on disk");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.taskId, "T-1");
  assert.equal(parsed.taskId, "T-1");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("a failure is persisted next to the attempts", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-fail-"));
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.js"],
  });
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  const scheduler = new Scheduler({
    adapter: scriptedAdapter({ results: [thin, thin] }),
    requirements,
    pipeline,
    now: fixedClock,
    maxAttempts: 2,
    stateDir,
  });
  await scheduler.runTask(envelope);
  const file = path.join(stateDir, "tasks", "T-1", "failure.json");
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.reason, "attempts-exhausted");
  fs.rmSync(stateDir, { recursive: true, force: true });
});



