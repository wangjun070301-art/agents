import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../src/workflow/scheduler.js";
import { Pipeline } from "../src/workflow/pipeline.js";
import { requirementsSchema, taskEnvelopeSchema } from "../src/workflow/contracts.js";
import type { TaskEnvelope, TaskResult } from "../src/workflow/contracts.js";
import type { CapabilityReport, EvidenceBundle, WorkflowAdapter } from "../src/workflow/adapters.js";

/**
 * P9 item 2: runPlan on a multi-task plan, with evidence that actually matches
 * each task's own envelope.
 *
 * The earlier runPlan test used one adapter that returned the same result for
 * every task, which hid the fact that a real plan has tasks with different
 * deliverables and different acceptance criteria.
 */

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "the fixture library adds and multiplies",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "add returns the sum",
        kind: "automated",
        verification_command: "node --test add",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "mul returns the product",
        kind: "automated",
        verification_command: "node --test mul",
      },
      {
        ac_id: "AC-3",
        requirement_id: "REQ-1",
        description: "both live in one module",
        kind: "automated",
        verification_command: "node --test both",
      },
    ],
  },
]);

const base = {
  role: "developer" as const,
  repo_path: "C:/repo",
  base_revision: "init",
  timeout_seconds: 60,
};

/** Three tasks: add, mul, then a join task that depends on both. */
const plan = [
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-ADD",
    objective: "implement add",
    allowed_paths: ["src/add.js"],
    deliverables: ["src/add.js"],
    acceptance_ids: ["AC-1"],
    verification_commands: [{ command: "node --test add", expect_exit: 0 }],
  }),
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-MUL",
    objective: "implement mul",
    allowed_paths: ["src/mul.js"],
    deliverables: ["src/mul.js"],
    acceptance_ids: ["AC-2"],
    verification_commands: [{ command: "node --test mul", expect_exit: 0 }],
  }),
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-JOIN",
    objective: "export both from the index",
    allowed_paths: ["src/index.js"],
    deliverables: ["src/index.js"],
    acceptance_ids: ["AC-3"],
    dependencies: ["T-ADD", "T-MUL"],
    verification_commands: [{ command: "node --test both", expect_exit: 0 }],
  }),
];

/** A result that answers the envelope it was handed, not a fixed one. */
function resultFor(envelope: TaskEnvelope): TaskResult {
  const command = envelope.verification_commands[0]!.command;
  return {
    task_id: envelope.task_id,
    status: "succeeded",
    summary: `${envelope.objective} done`,
    changed_files: [...envelope.deliverables],
    commands: [{ command, exit_code: 0, output_tail: "ok" }],
    test_results: envelope.acceptance_ids.map((ac) => ({
      name: `check ${ac}`,
      outcome: "passed",
      acceptance_ids: [ac],
    })),
    artifacts: [],
    unresolved_issues: [],
    risks: [],
    suggested_next_step: "",
  } as TaskResult;
}

/** Adapter that records call order and answers per envelope. */
function planAdapter(observedRoot: string): WorkflowAdapter & { order: string[] } {
  const order: string[] = [];
  return {
    id: "plan-adapter",
    label: "plan-adapter",
    order,
    capabilityCheck: async (): Promise<CapabilityReport> => ({
      adapter_id: "plan-adapter",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: true,
      can_resume: true,
      detail: "",
    }),
    execute: async (envelope: TaskEnvelope) => {
      order.push(envelope.task_id);
      // Write a real file so observation has something to see.
      const file = path.join(observedRoot, envelope.deliverables[0]!.replace(/\\/g, "/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `// ${envelope.task_id}\n`, "utf8");
      return resultFor(envelope);
    },
    resume: async (_id: string, feedback: string) => {
      order.push(`resume:${_id}:${feedback.length}`);
      return resultFor(plan[0]!);
    },
    cancel: async () => {},
    collectEvidence: async (taskId: string): Promise<EvidenceBundle> => {
      const envelope = plan.find((t) => t.task_id === taskId)!;
      return {
        task_id: taskId,
        changed_files: [...envelope.deliverables],
        command_records: [],
        artifact_paths: [],
      };
    },
    observedChanges: (taskId: string) => {
      const envelope = plan.find((t) => t.task_id === taskId)!;
      return envelope.deliverables.map((p) => ({ path: p, kind: "added" as const }));
    },
    claimDiscrepancies: () => [],
  };
}

test("runPlan executes a three-task plan in dependency order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runplan-"));
  const adapter = planAdapter(root);
  const pipeline = new Pipeline("PLAN");
  const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 1 });

  const outcome = await scheduler.runPlan(plan);
  assert.deepEqual(adapter.order, ["T-ADD", "T-MUL", "T-JOIN"], "the join task must run last");
  assert.equal(outcome.completed.length, 3, "every task should complete");
  assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.skipped.length, 0);
  // A task run never moves the stage; that is advanceStage's job.
  assert.equal(pipeline.stage, "PLAN");
  fs.rmSync(root, { recursive: true, force: true });
});

test("runPlan skips the join task when one dependency fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runplan-fail-"));
  const base = planAdapter(root);
  const failing: WorkflowAdapter = {
    ...base,
    execute: async (envelope: TaskEnvelope) => {
      if (envelope.task_id === "T-MUL") throw new Error("mul task crashed");
      return base.execute(envelope);
    },
  };
  const pipeline = new Pipeline("PLAN");
  const scheduler = new Scheduler({ adapter: failing, requirements, pipeline, maxAttempts: 1 });
  const outcome = await scheduler.runPlan(plan);

  assert.ok(outcome.failed.some((f) => f.taskId === "T-MUL"), "the mul failure must be reported");
  const skipped = outcome.skipped.find((s) => s.taskId === "T-JOIN");
  assert.ok(skipped, "the join task must be skipped");
  assert.match(skipped!.because, /T-MUL/);
  // The independent task still ran.
  assert.ok(outcome.completed.includes("T-ADD"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("runPlan advances the stage once, after the plan, with the whole plan visible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runplan-adv-"));
  const pipeline = new Pipeline("PLAN");
  const scheduler = new Scheduler({
    adapter: planAdapter(root),
    requirements,
    pipeline,
    maxAttempts: 1,
  });
  // G1 needs the whole plan to judge coverage and collisions.
  const outcome = scheduler.advanceStage("DISPATCH", { requirements, tasks: plan });
  assert.equal(outcome.ok, true, outcome.refused?.detail);
  assert.equal(outcome.record?.gate, "G1");
  assert.equal(pipeline.stage, "DISPATCH");
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A blocked pipeline stops the plan. Continuing would build the remaining
 * tasks on work nobody has accepted, which is worse than stopping.
 */
test("runPlan stops dispatching once the pipeline is blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runplan-blocked-"));
  const pipeline = new Pipeline("IMPLEMENT");
  const calls: string[] = [];
  const adapter: WorkflowAdapter = {
    ...planAdapter(root),
    execute: async (envelope: TaskEnvelope) => {
      calls.push(envelope.task_id);
      // Block the pipeline from inside the first task's own failure.
      pipeline.advance({ to: "BLOCKED", note: "simulated block" });
      throw new Error("blocked on purpose");
    },
  };
  const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 1 });
  const outcome = await scheduler.runPlan(plan);

  assert.equal(calls.length, 1, "only the first task may run");
  assert.ok(
    outcome.skipped.every((s) => /pipeline blocked/.test(s.because)),
    `every remaining task must say why it was skipped: ${JSON.stringify(outcome.skipped)}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("runPlan runs normally when the pipeline is not blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runplan-notblocked-"));
  const pipeline = new Pipeline("PLAN");
  const adapter = planAdapter(root);
  const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 1 });
  const outcome = await scheduler.runPlan(plan);
  assert.equal(outcome.completed.length, 3);
  assert.equal(outcome.skipped.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
