import test from "node:test";
import assert from "node:assert/strict";
import {
  claimIsSupported,
  taskEnvelopeSchema,
  taskResultSchema,
} from "../src/workflow/contracts.js";
import {
  LEGAL_TRANSITIONS,
  ProtocolError,
  assertTransition,
  canTransition,
  gateFor,
} from "../src/workflow/states.js";
import { AdapterRegistry, AdapterUnavailable } from "../src/workflow/adapters.js";
import type { WorkflowAdapter } from "../src/workflow/adapters.js";

const envelope = {
  task_id: "T-1",
  role: "developer" as const,
  objective: "Add a parser",
  repo_path: "C:/repo",
  base_revision: "abc123",
  deliverables: ["src/parser.ts"],
  acceptance_ids: ["AC-1"],
};

test("envelope fills declared defaults and rejects a missing base_revision", () => {
  const parsed = taskEnvelopeSchema.parse(envelope);
  assert.deepEqual(parsed.allowed_paths, []);
  assert.equal(parsed.timeout_seconds, 1800);

  const { base_revision: _dropped, ...withoutBase } = envelope;
  assert.equal(taskEnvelopeSchema.safeParse(withoutBase).success, false);
});

test("envelope rejects unknown keys and empty deliverables", () => {
  assert.equal(taskEnvelopeSchema.safeParse({ ...envelope, surprise: 1 }).success, false);
  assert.equal(taskEnvelopeSchema.safeParse({ ...envelope, deliverables: [] }).success, false);
  assert.equal(taskEnvelopeSchema.safeParse({ ...envelope, acceptance_ids: ["A-1"] }).success, false);
  assert.equal(taskEnvelopeSchema.safeParse({ ...envelope, acceptance_ids: ["AC-1x"] }).success, false);
  assert.equal(taskEnvelopeSchema.safeParse({ ...envelope, acceptance_ids: ["REQ-1"] }).success, false);
});

test("succeeded without a recorded command is not a supported claim", () => {
  const claim = {
    task_id: "T-1",
    status: "succeeded" as const,
    summary: "done",
  };
  assert.equal(claimIsSupported(taskResultSchema.parse(claim)), false);

  const evidenced = taskResultSchema.parse({
    ...claim,
    commands: [{ command: "npm test", exit_code: 0 }],
    test_results: [{ name: "suite", outcome: "passed" }],
  });
  assert.equal(claimIsSupported(evidenced), true);
});

test("a failed or unverified test blocks a succeeded claim", () => {
  const base = {
    task_id: "T-1",
    status: "succeeded" as const,
    summary: "done",
    commands: [{ command: "npm test", exit_code: 0 }],
  };
  assert.equal(
    claimIsSupported(taskResultSchema.parse({ ...base, test_results: [{ name: "x", outcome: "failed" }] })),
    false,
  );
  assert.equal(
    claimIsSupported(taskResultSchema.parse({ ...base, test_results: [{ name: "x", outcome: "unverified" }] })),
    false,
  );
});

test("stages advance one step at a time and cannot be skipped", () => {
  assert.equal(canTransition("SPEC", "PLAN"), true);
  assert.equal(canTransition("SPEC", "DISPATCH"), false);
  assert.equal(canTransition("INTAKE", "PLAN"), false);
  assert.throws(() => assertTransition("INTAKE", "REVIEW"), ProtocolError);
});

test("review and verify may return work to IMPLEMENT", () => {
  assert.equal(canTransition("REVIEW", "IMPLEMENT"), true);
  assert.equal(canTransition("VERIFY", "IMPLEMENT"), true);
  assert.equal(canTransition("ACCEPT", "IMPLEMENT"), false);
});

test("BLOCKED returns only to the stage that blocked", () => {
  assert.equal(canTransition("REVIEW", "BLOCKED"), true);
  assert.equal(canTransition("BLOCKED", "REVIEW", "REVIEW"), true);
  assert.equal(canTransition("BLOCKED", "IMPLEMENT", "REVIEW"), false);
  assert.equal(canTransition("BLOCKED", "VERIFY"), false);
  assert.deepEqual(LEGAL_TRANSITIONS.ARCHIVE, []);
});

test("each gated edge names its gate", () => {
  assert.equal(gateFor("SPEC", "PLAN"), "G0");
  assert.equal(gateFor("IMPLEMENT", "REVIEW"), "G2");
  assert.equal(gateFor("ACCEPT", "DELIVER"), "G5");
  assert.equal(gateFor("CLARIFY", "BASELINE"), undefined);
});

test("registry rejects duplicate ids and reports unknown adapters", () => {
  const stub: WorkflowAdapter = {
    id: "stub",
    label: "stub",
    capabilityCheck: async () => ({
      adapter_id: "stub",
      version: "0",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: false,
      can_resume: false,
      detail: "",
    }),
    execute: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
    cancel: async () => {},
    collectEvidence: async () => ({
      task_id: "T-1",
      changed_files: [],
      command_records: [],
      artifact_paths: [],
    }),
  };

  const registry = new AdapterRegistry().register(stub);
  assert.throws(() => registry.register(stub), /already registered/);
  assert.throws(() => registry.require("missing"), AdapterUnavailable);
  assert.deepEqual(registry.list(), [{ id: "stub", label: "stub" }]);
});

test("a failing capabilityCheck degrades to an unavailable report", async () => {
  const broken: WorkflowAdapter = {
    id: "broken",
    label: "broken",
    capabilityCheck: async () => {
      throw new Error("binary not found");
    },
    execute: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
    cancel: async () => {},
    collectEvidence: async () => ({
      task_id: "T-1",
      changed_files: [],
      command_records: [],
      artifact_paths: [],
    }),
  };

  const [report] = await new AdapterRegistry().register(broken).checkAll();
  assert.equal(report?.available, false);
  assert.equal(report?.detail, "binary not found");
});
