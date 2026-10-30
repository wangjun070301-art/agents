import test from "node:test";
import assert from "node:assert/strict";
import {
  claimIsSupported,
  requirementsSchema,
  taskEnvelopeSchema,
  taskResultSchema,
  validateEnvelopeAgainstRequirements,
  validateTaskResult,
} from "../src/workflow/contracts.js";
import {
  LEGAL_TRANSITIONS,
  ProtocolError,
  assertGatePassed,
  assertGateTableConsistent,
  assertTransition,
  canTransition,
  gateFor,
  gateList,
  REQUIRED_GATES,
  stageList,
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

test("a non-zero exit code blocks a succeeded claim", () => {
  const claim = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "done",
    commands: [{ command: "npm test", exit_code: 1 }],
    test_results: [{ name: "suite", outcome: "passed" }],
  });
  assert.equal(claimIsSupported(claim), false);
});

test("no tests at all blocks a succeeded claim", () => {
  const claim = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "done",
    commands: [{ command: "true", exit_code: 0 }],
  });
  assert.equal(claimIsSupported(claim), false);
});

test("a skipped test blocks a succeeded claim", () => {
  const claim = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "done",
    commands: [{ command: "npm test", exit_code: 0 }],
    test_results: [{ name: "x", outcome: "skipped" }],
  });
  assert.equal(claimIsSupported(claim), false);
});

test("unresolved issues block a succeeded claim", () => {
  const claim = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "done",
    commands: [{ command: "npm test", exit_code: 0 }],
    test_results: [{ name: "suite", outcome: "passed" }],
    unresolved_issues: ["build is broken"],
  });
  assert.equal(claimIsSupported(claim), false);
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

test("failed and blocked results must state what is unresolved", () => {
  assert.equal(
    taskResultSchema.safeParse({ task_id: "T-1", status: "failed", summary: "nope" }).success,
    false,
  );
  assert.equal(
    taskResultSchema.safeParse({
      task_id: "T-1",
      status: "failed",
      summary: "nope",
      unresolved_issues: ["compiler error"],
    }).success,
    true,
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
  assert.equal(canTransition("INTEGRATE", "IMPLEMENT"), false);
  assert.equal(canTransition("ACCEPT", "IMPLEMENT"), false);
});

test("integration can send work back to VERIFY, so a defect is not a dead end", () => {
  assert.equal(canTransition("INTEGRATE", "VERIFY"), true);
  assert.equal(canTransition("VERIFY", "IMPLEMENT"), true);
  // The rework path from integration is exactly two legal hops to the implementer.
  assert.equal(canTransition("INTEGRATE", "ACCEPT"), true);
});

test("BLOCKED returns only to the stage that blocked", () => {
  assert.equal(canTransition("REVIEW", "BLOCKED"), true);
  assert.equal(canTransition("BLOCKED", "REVIEW", "REVIEW"), true);
  assert.equal(canTransition("BLOCKED", "IMPLEMENT", "REVIEW"), false);
  assert.equal(canTransition("BLOCKED", "VERIFY"), false);
  // A forged resume target must not resurrect a terminal stage.
  assert.equal(canTransition("BLOCKED", "ARCHIVE", "ARCHIVE"), false);
  // A stage that never blocks cannot be named as a resume target.
  assert.equal(canTransition("BLOCKED", "ARCHIVE", "INTEGRATE"), false);
  // BLOCKED cannot loop to itself.
  assert.equal(canTransition("BLOCKED", "BLOCKED", "BLOCKED"), false);
  // A stale resume stage on a forward move is rejected.
  assert.equal(canTransition("REVIEW", "VERIFY", "REVIEW"), false);
  assert.deepEqual(LEGAL_TRANSITIONS.ARCHIVE, []);
});

test("each gated edge names its gate", () => {
  assert.equal(gateFor("SPEC", "PLAN"), "G0");
  assert.equal(gateFor("IMPLEMENT", "REVIEW"), "G2");
  assert.equal(gateFor("ACCEPT", "DELIVER"), "G5");
  assert.equal(gateFor("CLARIFY", "BASELINE"), undefined);
});

test("a gated edge cannot be taken without its gate recorded", () => {
  assert.throws(() => assertGatePassed("IMPLEMENT", "REVIEW", []), ProtocolError);
  assert.throws(() => assertGatePassed("SPEC", "PLAN", ["G1"]), ProtocolError);
  assert.doesNotThrow(() => assertGatePassed("SPEC", "PLAN", ["G0"]));
  assert.doesNotThrow(() => assertGatePassed("CLARIFY", "BASELINE", []));
});

test("the gate table points only at legal edges", () => {
  assert.doesNotThrow(() => assertGateTableConsistent());
  assert.equal(REQUIRED_GATES.length, 6);
});

test("a deleted required gate is detected instead of failing open", () => {
  // Guard the invariant itself: every required key is actually present.
  for (const key of REQUIRED_GATES) {
    assert.ok(gateFor(...(key.split("->") as [Parameters<typeof gateFor>[0], Parameters<typeof gateFor>[1]])),
      `missing gate for ${key}`);
  }
});

test("enums are exported read-only", () => {
  assert.equal(Object.isFrozen(stageList), true);
  assert.equal(Object.isFrozen(gateList), true);
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

test("registry rejects empty and malformed ids", () => {
  const base = {
    label: "x",
    capabilityCheck: async () => ({
      adapter_id: "",
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
  const registry = new AdapterRegistry();
  assert.throws(() => registry.register({ ...base, id: "" }), /Adapter id/);
  assert.throws(() => registry.register({ ...base, id: " padded " }), /Adapter id/);
  assert.throws(() => registry.register({ ...base, id: "Upper" }), /Adapter id/);
  assert.doesNotThrow(() => registry.register({ ...base, id: "codex-exec" }));
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

test("checkAll overrides an adapter that misattributes its own report", async () => {
  const liar: WorkflowAdapter = {
    id: "liar",
    label: "liar",
    capabilityCheck: async () => ({
      adapter_id: "someone-else",
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
  const [report] = await new AdapterRegistry().register(liar).checkAll();
  assert.equal(report?.adapter_id, "liar");
});

test("checkAll does not let one hung adapter block the others", async () => {
  const hung: WorkflowAdapter = {
    id: "hung",
    label: "hung",
    capabilityCheck: () => new Promise(() => {}),
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
  const healthy: WorkflowAdapter = {
    ...hung,
    id: "healthy",
    label: "healthy",
    capabilityCheck: async () => ({
      adapter_id: "healthy",
      version: "1",
      available: true,
      models: [],
      working_directories: [],
      can_run_tests: true,
      can_resume: true,
      detail: "ok",
    }),
  };
  const reports = await new AdapterRegistry().register(hung).register(healthy).checkAll(200);
  const byId = new Map(reports.map((r) => [r.adapter_id, r]));
  assert.equal(byId.get("healthy")?.available, true);
  assert.equal(byId.get("hung")?.available, false);
});

test("requirement sets reject duplicate ids and mislinked criteria", () => {
  const good = requirementsSchema.parse([
    {
      req_id: "REQ-1",
      statement: "add a parser",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-1",
          description: "parser accepts the fixture",
          kind: "automated",
          verification_command: "npm test",
        },
      ],
    },
  ]);
  assert.equal(good.length, 1);

  // Criterion pointing at a different requirement than its parent.
  assert.equal(
    requirementsSchema.safeParse([
      {
        req_id: "REQ-1",
        statement: "x",
        acceptance: [
          {
            ac_id: "AC-1",
            requirement_id: "REQ-2",
            description: "y",
            kind: "automated",
            verification_command: "npm test",
          },
        ],
      },
    ]).success,
    false,
  );

  // Duplicate AC across two requirements.
  const dup = [
    {
      req_id: "REQ-1",
      statement: "x",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-1",
          description: "y",
          kind: "automated",
          verification_command: "npm test",
        },
      ],
    },
    {
      req_id: "REQ-2",
      statement: "z",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-2",
          description: "w",
          kind: "automated",
          verification_command: "npm test",
        },
      ],
    },
  ];
  assert.equal(requirementsSchema.safeParse(dup).success, false);
});

test("manual criteria must name a human check and no automated command", () => {
  const base = { ac_id: "AC-1", requirement_id: "REQ-1", description: "looks right", kind: "manual" as const };
  assert.equal(
    requirementsSchema.safeParse([{ req_id: "REQ-1", statement: "x", acceptance: [base] }]).success,
    false,
  );
  assert.equal(
    requirementsSchema.safeParse([
      {
        req_id: "REQ-1",
        statement: "x",
        acceptance: [{ ...base, verification_command: "npm test" }],
      },
    ]).success,
    false,
  );
  assert.equal(
    requirementsSchema.safeParse([
      {
        req_id: "REQ-1",
        statement: "x",
        acceptance: [{ ...base, manual_check: { owner: "He", procedure: "read the output" } }],
      },
    ]).success,
    true,
  );
});

test("validateTaskResult catches a mismatched task id", () => {
  const env = taskEnvelopeSchema.parse(envelope);
  const result = taskResultSchema.parse({
    task_id: "T-OTHER",
    status: "partial",
    summary: "worked on something else",
  });
  assert.deepEqual(validateTaskResult(env, result), [
    "result task_id T-OTHER does not match envelope T-1",
    "deliverable not produced: src/parser.ts",
  ]);
});

test("validateTaskResult rejects writes outside allowed_paths", () => {
  const env = taskEnvelopeSchema.parse({ ...envelope, allowed_paths: ["src/"] });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "done",
    changed_files: ["src/parser.ts", "README.md", "../escape.ts"],
  });
  const problems = validateTaskResult(env, result);
  assert.ok(problems.includes("changed file outside allowed_paths: README.md"));
  assert.ok(problems.includes("changed file outside allowed_paths: ../escape.ts"));
  assert.equal(problems.includes("changed file outside allowed_paths: src/parser.ts"), false);
});

test("validateTaskResult requires every verification command at its expected exit", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    verification_commands: [{ command: "npm test", expect_exit: 0 }],
  });
  const missing = taskResultSchema.parse({ task_id: "T-1", status: "partial", summary: "x" });
  assert.ok(validateTaskResult(env, missing).includes("verification command was not run: npm test"));

  const wrongExit = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "x",
    commands: [{ command: "npm test", exit_code: 1 }],
  });
  assert.ok(
    validateTaskResult(env, wrongExit).some((p) => p.startsWith("verification command exited 1, expected 0")),
  );
});

test("a succeeded result must cover every acceptance id with a passing test", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    acceptance_ids: ["AC-1", "AC-2"],
  });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "done",
    changed_files: ["src/parser.ts"],
    commands: [{ command: "npm test", exit_code: 0 }],
    test_results: [{ name: "parser", outcome: "passed", acceptance_ids: ["AC-1"] }],
  });
  const problems = validateTaskResult(env, result);
  assert.ok(problems.includes("acceptance criterion has no passing test: AC-2"));
  assert.equal(claimIsSupported(result, env), false);
});

test("an expected non-zero exit code still counts as satisfied", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    allowed_paths: ["src"],
    verification_commands: [{ command: "grep -q x f", expect_exit: 1 }],
  });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "negative assertion holds",
    changed_files: ["src/parser.ts"],
    commands: [{ command: "grep -q x f", exit_code: 1 }],
    test_results: [{ name: "absence", outcome: "passed", acceptance_ids: ["AC-1"] }],
  });
  assert.deepEqual(validateTaskResult(env, result), []);
  assert.equal(claimIsSupported(result, env), true);
});

test("a later failing run of a verification command is not hidden by an earlier pass", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    allowed_paths: ["src"],
    verification_commands: [{ command: "npm test", expect_exit: 0 }],
  });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "x",
    changed_files: ["src/parser.ts"],
    commands: [
      { command: "npm test", exit_code: 0 },
      { command: "npm test", exit_code: 1 },
    ],
  });
  const problems = validateTaskResult(env, result);
  assert.equal(problems.length, 1);
  assert.ok(problems[0]?.startsWith("verification command exited 1, expected 0"));
});

test("validateTaskResult is strict about evidence, not just envelope fields", () => {
  const env = taskEnvelopeSchema.parse({ ...envelope, verification_commands: [] });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "nothing was run",
    changed_files: ["src/parser.ts"],
  });
  const problems = validateTaskResult(env, result);
  assert.ok(problems.includes("a succeeded result must carry at least one test result"));
  assert.equal(claimIsSupported(result, env), false);
});

test("an empty allowlist denies every write", () => {
  const env = taskEnvelopeSchema.parse({ ...envelope, allowed_paths: [] });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "x",
    changed_files: ["src/parser.ts"],
  });
  assert.ok(validateTaskResult(env, result).includes("changed file outside allowed_paths: src/parser.ts"));
});

test("a malformed allowlist entry is not a blanket grant", () => {
  for (const bad of ["/", ".", "//"]) {
    const env = taskEnvelopeSchema.parse({ ...envelope, allowed_paths: [bad] });
    const result = taskResultSchema.parse({
      task_id: "T-1",
      status: "partial",
      summary: "x",
      changed_files: ["src/parser.ts"],
    });
    assert.ok(
      validateTaskResult(env, result).includes("changed file outside allowed_paths: src/parser.ts"),
      `allowlist entry ${JSON.stringify(bad)} must not permit every path`,
    );
  }
});

test("an unknown stage throws a protocol error instead of a TypeError", () => {
  assert.throws(() => canTransition("NONSENSE" as never, "PLAN"), ProtocolError);
  assert.throws(() => canTransition("BLOCKED", "PLAN", "NONSENSE" as never), ProtocolError);
});

test("absolute and relative path reports agree, and Windows case is tolerated", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    repo_path: "C:/repo",
    allowed_paths: ["src"],
  });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "x",
    changed_files: ["C:/repo/src/parser.ts", "Src/parser.ts", "src/parser.ts"],
  });
  const problems = validateTaskResult(env, result);
  assert.deepEqual(problems, []);
});

test("repo_path casing differences do not produce false negatives", () => {
  const env = taskEnvelopeSchema.parse({
    ...envelope,
    repo_path: "C:/Repo",
    allowed_paths: ["src"],
  });
  const result = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "x",
    changed_files: ["c:/repo/src/parser.ts"],
  });
  assert.deepEqual(validateTaskResult(env, result), []);
});

test("envelopes cannot cite an acceptance id no requirement defines", () => {
  const env = taskEnvelopeSchema.parse({ ...envelope, acceptance_ids: ["AC-999"] });
  const reqs = requirementsSchema.parse([
    {
      req_id: "REQ-1",
      statement: "x",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-1",
          description: "y",
          kind: "automated",
          verification_command: "npm test",
        },
      ],
    },
  ]);
  assert.deepEqual(validateEnvelopeAgainstRequirements(env, reqs), [
    "acceptance id not defined by any requirement: AC-999",
  ]);
});
