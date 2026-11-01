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
 * A plan mixes roles, so one plan must reach more than one agent.
 *
 * The drill that proved this used two real binaries; this test pins the
 * routing decision itself, so a regression in role lookup is caught without
 * needing an installed Claude or Codex.
 */

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "the fixture exists",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "a file was written",
        kind: "automated",
        verification_command: "node --version",
      },
    ],
  },
]);

function envelope(taskId: string, role: TaskEnvelope["role"], dependencies: string[] = []) {
  return taskEnvelopeSchema.parse({
    task_id: taskId,
    role,
    objective: `do ${taskId}`,
    repo_path: "C:/repo",
    base_revision: "init",
    allowed_paths: [`src/${taskId}.js`],
    deliverables: [`src/${taskId}.js`],
    acceptance_ids: ["AC-1"],
    verification_commands: [{ command: "node --version", expect_exit: 0 }],
    dependencies,
    timeout_seconds: 60,
  });
}

/** An adapter that records which role it was asked to serve. */
function roleAdapter(role: TaskEnvelope["role"], id: string, calls: string[]): WorkflowAdapter {
  return {
    id,
    label: id,
    async capabilityCheck(): Promise<CapabilityReport> {
      return {
        adapter_id: id,
        version: "1",
        available: true,
        models: [],
        working_directories: [],
        can_run_tests: true,
        can_resume: true,
        detail: "",
      };
    },
    async execute(en: TaskEnvelope): Promise<TaskResult> {
      calls.push(`${en.task_id}:${role}`);
      return {
        task_id: en.task_id,
        status: "succeeded",
        summary: `${role} did it`,
        changed_files: [...en.deliverables],
        commands: [{ command: "node --version", exit_code: 0, output_tail: "v22" }],
        test_results: en.acceptance_ids.map((ac) => ({ name: ac, outcome: "passed", acceptance_ids: [ac] })),
        artifacts: [],
        unresolved_issues: [],
        risks: [],
        suggested_next_step: "",
      } as TaskResult;
    },
    async resume(): Promise<TaskResult> {
      throw new Error("not used");
    },
    async cancel(): Promise<void> {},
    async collectEvidence(taskId: string): Promise<EvidenceBundle> {
      return { task_id: taskId, changed_files: [], command_records: [], artifact_paths: [] };
    },
    observedChanges: (taskId: string) => [{ path: `src/${taskId}.js`, kind: "added" as const }],
    claimDiscrepancies: () => [],
  };
}

test("a plan routes each task to the agent bound to its role", async () => {
  const calls: string[] = [];
  const byRole = new Map<string, WorkflowAdapter>([
    ["developer", roleAdapter("developer", "codex", calls)],
    ["reviewer", roleAdapter("reviewer", "claude", calls)],
  ]);

  // This is the same shape the panel builds: one adapter that picks per task.
  const router: WorkflowAdapter = {
    id: "role-router",
    label: "role-router",
    async capabilityCheck() {
      return {
        adapter_id: "role-router",
        version: "1",
        available: true,
        models: [],
        working_directories: [],
        can_run_tests: true,
        can_resume: true,
        detail: "",
      };
    },
    async execute(en: TaskEnvelope) {
      const adapter = byRole.get(en.role);
      if (!adapter) throw new Error(`no agent bound to ${en.role}`);
      return adapter.execute(en);
    },
    async resume() {
      throw new Error("not used");
    },
    async cancel() {},
    async collectEvidence(taskId: string) {
      return { task_id: taskId, changed_files: [], command_records: [], artifact_paths: [] };
    },
    observedChanges: (taskId: string) => [{ path: `src/${taskId}.js`, kind: "added" as const }],
    claimDiscrepancies: () => [],
  };

  const pipeline = new Pipeline("IMPLEMENT");
  const scheduler = new Scheduler({ adapter: router, requirements, pipeline, maxAttempts: 1 });
  const plan = [envelope("T-WRITE", "developer"), envelope("T-REVIEW", "reviewer", ["T-WRITE"])];
  const outcome = await scheduler.runPlan(plan);

  assert.deepEqual(calls, ["T-WRITE:developer", "T-REVIEW:reviewer"], "each role reaches its own agent");
  assert.equal(outcome.completed.length, 2);
  assert.equal(outcome.failed.length, 0);
});

test("a role with no bound agent fails loudly instead of silently using another", async () => {
  const calls: string[] = [];
  const byRole = new Map<string, WorkflowAdapter>([["developer", roleAdapter("developer", "codex", calls)]]);
  const router: WorkflowAdapter = {
    id: "role-router",
    label: "role-router",
    async capabilityCheck() {
      return {
        adapter_id: "role-router",
        version: "1",
        available: true,
        models: [],
        working_directories: [],
        can_run_tests: true,
        can_resume: true,
        detail: "",
      };
    },
    async execute(en: TaskEnvelope) {
      const adapter = byRole.get(en.role);
      if (!adapter) throw new Error(`no agent bound to ${en.role}`);
      return adapter.execute(en);
    },
    async resume() {
      throw new Error("not used");
    },
    async cancel() {},
    async collectEvidence(taskId: string) {
      return { task_id: taskId, changed_files: [], command_records: [], artifact_paths: [] };
    },
    observedChanges: () => undefined,
    claimDiscrepancies: () => [],
  };

  const pipeline = new Pipeline("IMPLEMENT");
  const scheduler = new Scheduler({ adapter: router, requirements, pipeline, maxAttempts: 1 });
  const outcome = await scheduler.runPlan([envelope("T-REVIEW", "reviewer")]);

  assert.equal(outcome.failed.length, 1, "an unbound role must fail, not borrow another agent");
  assert.match(outcome.failed[0]!.detail, /no agent bound to reviewer/);
});
