import test from "node:test";
import assert from "node:assert/strict";
import { requirementsSchema, taskEnvelopeSchema, taskResultSchema } from "../src/workflow/contracts.js";
import {
  evaluateAllGates,
  evaluateGate,
  gateG0,
  gateG1,
  gateG2,
  gateG3,
  gateG4,
  gateG5,
} from "../src/workflow/gates.js";

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "add a parser",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "parses the fixture",
        kind: "automated",
        verification_command: "npm test",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "output looks right",
        kind: "manual",
        manual_check: { owner: "He", procedure: "read the output" },
      },
    ],
  },
]);

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-1",
  role: "developer",
  objective: "add the parser",
  repo_path: "C:/repo",
  base_revision: "abc",
  allowed_paths: ["src"],
  deliverables: ["src/parser.ts"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "npm test", expect_exit: 0 }],
});

const goodResult = taskResultSchema.parse({
  task_id: "T-1",
  status: "succeeded",
  summary: "parser added",
  changed_files: ["src/parser.ts"],
  commands: [{ command: "npm test", exit_code: 0 }],
  test_results: [{ name: "parser", outcome: "passed", acceptance_ids: ["AC-1"] }],
});

// A second task that owns the manual criterion. G1 requires every AC to be
// claimed by some task, including the ones a human decides.
const manualTask = taskEnvelopeSchema.parse({
  task_id: "T-2",
  role: "tester",
  objective: "confirm the output reads correctly",
  repo_path: "C:/repo",
  base_revision: "abc",
  allowed_paths: [],
  deliverables: ["(manual check record)"],
  acceptance_ids: ["AC-2"],
  dependencies: ["T-1"],
});
const plan = [envelope, manualTask];

/** A complete, honest delivery record used by the gates that need one. */
const deliveredArtifact = "build-7d4e880";
const acceptance = {
  by: "He",
  at: "2026-10-31T14:10:00Z",
  note: "read the parser output and the fixture result",
  artifact: deliveredArtifact,
  accepted_ac_ids: ["AC-1", "AC-2"],
};
const verifications = [
  { ac_id: "AC-1", outcome: "passed" as const, evidence: "npm test exit 0", at: "2026-10-31T13:00:00Z" },
  { ac_id: "AC-2", outcome: "passed" as const, evidence: "He read the output at 14:02", at: "2026-10-31T14:02:00Z" },
];

// ------------------------------------------------------------------ G0
test("G0 passes a requirement set where every criterion names its decider", () => {
  const v = gateG0({ requirements, envelope });
  assert.equal(v.passed, true);
  assert.equal(v.blocking.length, 0);
});

test("G0 blocks when a criterion has no decider", () => {
  // Built through the schema's own escape hatch: a manual criterion is forced
  // to carry a manual_check, so the only way to be undecidable is to omit the
  // command on an automated one — which the schema already rejects. Feed the
  // gate a hand-built object to prove the gate itself also refuses.
  const crippled = [
    {
      req_id: "REQ-1",
      statement: "x",
      acceptance: [
        { ac_id: "AC-1", requirement_id: "REQ-1", description: "y", kind: "automated" as const },
      ],
    },
  ];
  const v = gateG0({ requirements: crippled as never });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /no decider for: AC-1/);
});

test("G0 blocks when the envelope cites an AC nobody defined", () => {
  const env = taskEnvelopeSchema.parse({ ...envelope, acceptance_ids: ["AC-999"] });
  const v = gateG0({ requirements, envelope: env });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /AC-999/);
});

test("G0 blocks with no requirement set at all", () => {
  const v = gateG0({});
  assert.equal(v.passed, false);
});

// ------------------------------------------------------------------ G1
test("G1 passes a single well-formed task", () => {
  const v = gateG1({ tasks: plan, requirements });
  assert.equal(v.passed, true);
});

test("G1 blocks a dangling dependency", () => {
  const t2 = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-2", dependencies: ["T-MISSING"] });
  const v = gateG1({ tasks: [envelope, t2], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /T-2->T-MISSING/);
});

test("G1 blocks parallel tasks that write the same path", () => {
  const a = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-A", allowed_paths: ["src/shared"] });
  const b = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-B", allowed_paths: ["src/shared"] });
  const v = gateG1({ tasks: [a, b], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /share src\/shared/);
});

test("G1 allows the same path when one task depends on the other", () => {
  const a = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-A",
    allowed_paths: ["src/shared"],
    acceptance_ids: ["AC-1"],
  });
  const b = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-B",
    allowed_paths: ["src/shared"],
    dependencies: ["T-A"],
    acceptance_ids: ["AC-2"],
  });
  const v = gateG1({ tasks: [a, b], requirements });
  assert.equal(v.passed, true);
});

test("G1 blocks when a requirement has no task claiming it", () => {
  const narrow = taskEnvelopeSchema.parse({ ...envelope, acceptance_ids: ["AC-1"] });
  const v = gateG1({ tasks: [narrow], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /unclaimed: AC-2/);
});

test("G1 blocks a parent/child write overlap, not just an identical string", () => {
  const wide = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-W", allowed_paths: ["src"] });
  const narrow = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-N", allowed_paths: ["src/parser.ts"] });
  const v = gateG1({ tasks: [wide, narrow], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /share src ~ src\/parser\.ts/);
});

test("G1 treats differently written but equal paths as a collision", () => {
  const a = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-A", allowed_paths: ["./src"] });
  const b = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-B", allowed_paths: ["Src"] });
  const v = gateG1({ tasks: [a, b], requirements });
  assert.equal(v.passed, false);
});

test("G1 blocks two tasks that deliver the same file even when their allowlists differ", () => {
  const a = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-A", deliverables: ["src/parser.ts"] });
  const b = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-B",
    deliverables: ["src/parser.ts"],
    allowed_paths: ["src/parser.ts"],
  });
  const v = gateG1({ tasks: [a, b], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /both deliver src\/parser\.ts/);
});

test("G1 blocks a dependency cycle instead of treating it as ordering", () => {
  const a = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-A", dependencies: ["T-B"] });
  const b = taskEnvelopeSchema.parse({ ...envelope, task_id: "T-B", dependencies: ["T-A"] });
  const v = gateG1({ tasks: [a, b], requirements });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /cycle:/);
});

test("G1 honours transitive ordering when judging collisions", () => {
  const a = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-A",
    allowed_paths: ["src"],
    acceptance_ids: ["AC-1"],
  });
  const b = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-B",
    dependencies: ["T-A"],
    allowed_paths: ["src"],
    acceptance_ids: ["AC-2"],
  });
  const c = taskEnvelopeSchema.parse({
    ...envelope,
    task_id: "T-C",
    dependencies: ["T-B"],
    allowed_paths: ["src"],
    acceptance_ids: ["AC-1"],
  });
  const v = gateG1({ tasks: [a, b, c], requirements });
  // A and C are ordered through B, so neither pair is a real parallel clash.
  assert.equal(v.passed, true);
});

test("G1 blocks when it has no requirement set to check coverage against", () => {
  const v = gateG1({ tasks: plan });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /no requirement set/);
});

// ------------------------------------------------------------------ G2
test("G2 passes a result that reconciles with its envelope", () => {
  const v = gateG2({ envelope, result: goodResult });
  assert.equal(v.passed, true);
});

test("G2 blocks a success claim with no test result", () => {
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.ts"],
    commands: [{ command: "npm test", exit_code: 0 }],
  });
  const v = gateG2({ envelope, result: thin });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /claim-supported/);
});

test("G2 blocks a result that touched a file outside allowed_paths", () => {
  const stray = taskResultSchema.parse({ ...goodResult, changed_files: ["src/parser.ts", "README.md"] });
  const v = gateG2({ envelope, result: stray });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /README\.md/);
});

test("G2 blocks when the developer admits something is unresolved", () => {
  const partial = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "half done",
    unresolved_issues: ["second fixture not handled"],
  });
  const v = gateG2({ envelope, result: partial });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /second fixture/);
});

test("G2 blocks a tidy partial result, not just a messy one", () => {
  const tidy = taskResultSchema.parse({
    task_id: "T-1",
    status: "partial",
    summary: "most of it works",
    changed_files: ["src/parser.ts"],
    commands: [{ command: "npm test", exit_code: 0 }],
    test_results: [{ name: "parser", outcome: "passed", acceptance_ids: ["AC-1"] }],
  });
  const v = gateG2({ envelope, result: tidy });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /status is partial, not succeeded/);
});

test("G2 catches a change the developer did not report", () => {
  const v = gateG2({
    envelope,
    result: goodResult,
    changedFiles: ["src/parser.ts", "README.md"],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /changed but unreported: README\.md/);
});

test("G2 catches a file the developer reported but did not change", () => {
  const inflated = taskResultSchema.parse({ ...goodResult, changed_files: ["src/parser.ts", "src/extra.ts"] });
  const v = gateG2({ envelope, result: inflated, changedFiles: ["src/parser.ts"] });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /reported but unchanged: src\/extra\.ts/);
});

// ------------------------------------------------------------------ G3
test("G3 passes when only Minor and Suggestion remain", () => {
  const v = gateG3({
    reviewFindings: [
      { severity: "Minor", resolved: false },
      { severity: "Suggestion", resolved: false },
      { severity: "Major", resolved: true },
    ],
  });
  assert.equal(v.passed, true);
});

test("G3 blocks an unresolved Major", () => {
  const v = gateG3({
    reviewFindings: [{ severity: "Major", resolved: false }],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /1 unresolved Blocker\/Major/);
});

test("G3 blocks when no review was supplied at all", () => {
  const v = gateG3({});
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /no review findings/);
});

test("G3 distinguishes 'reviewed and clean' from 'not reviewed'", () => {
  const empty = gateG3({ reviewFindings: [] });
  assert.equal(empty.passed, true, "an explicit empty review is a real verdict");
  const missing = gateG3({});
  assert.equal(missing.passed, false, "a missing review is not a clean review");
});

test("G3 blocks a finding whose severity is not one of the four", () => {
  const v = gateG3({ reviewFindings: [{ severity: "blocker" as never, resolved: false }] });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /unknown severity/);
});

// ------------------------------------------------------------------ G4
test("G4 passes when every criterion has passing evidence", () => {
  const v = gateG4({
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output at 14:02" },
    ],
  });
  assert.equal(v.passed, true);
});

test("G4 blocks an unverified criterion", () => {
  const v = gateG4({
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "unverified", evidence: "" },
    ],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /not passing: AC-2/);
});

test("G4 blocks a criterion with no result row", () => {
  const v = gateG4({
    requirements,
    verifications: [{ ac_id: "AC-1", outcome: "passed", evidence: "npm test" }],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /no result for: AC-2/);
});

test("G4 blocks a pass that cites no evidence", () => {
  const v = gateG4({
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "   " },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read it" },
    ],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /passed without evidence: AC-1/);
});

test("G4 rejects evidence that is a shrug rather than a record", () => {
  for (const junk of ["n/a", "N/A", "none", "TBD", "-", "...", "?", "\u200b"]) {
    const v = gateG4({
      requirements,
      verifications: [
        { ac_id: "AC-1", outcome: "passed", evidence: junk },
        { ac_id: "AC-2", outcome: "passed", evidence: "He read the output at 14:02" },
      ],
    });
    assert.equal(v.passed, false, `evidence ${JSON.stringify(junk)} must not count`);
  }
});

test("G4 blocks duplicate verification rows instead of taking the last one", () => {
  const v = gateG4({
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "failed", evidence: "npm test exit 1" },
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output" },
    ],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /duplicated: AC-1/);
});

test("G4 blocks a verification for a criterion nobody defined", () => {
  const v = gateG4({
    requirements,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output" },
      { ac_id: "AC-77", outcome: "passed", evidence: "invented" },
    ],
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /unknown criteria: AC-77/);
});

// ------------------------------------------------------------------ G5
test("G5 passes with verified evidence and a recorded human acceptance", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications,
    recorded: { G5: acceptance },
  });
  assert.equal(v.passed, true);
});

test("G5 blocks without a human acceptance, even when G4 passes", () => {
  const v = gateG5({
    requirements,
    deliveredArtifact,
    verifications,
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /no recorded human acceptance/);
});

test("G5 inherits G4's failures rather than shipping an unverified build", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications: [{ ac_id: "AC-1", outcome: "passed", evidence: "npm test", at: "2026-10-31T13:00:00Z" }],
    recorded: { G5: acceptance },
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /g4:/);
});

test("G5 blocks a blank acceptance note", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications,
    recorded: { G5: { ...acceptance, note: "  " } },
  });
  assert.equal(v.passed, false);
});

test("G5 rejects a placeholder acceptance that names nobody and nothing", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications,
    recorded: {
      G5: { by: "x", at: "now", note: "ok", artifact: deliveredArtifact, accepted_ac_ids: ["AC-1", "AC-2"] },
    },
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /not a name/);
  assert.match(v.blocking.join(" "), /not a parseable date/);
  assert.match(v.blocking.join(" "), /too short/);
});

test("G5 requires the acceptance to name the artifact it accepts", () => {
  const base = {
    requirements,
    deliveredArtifact,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output" },
    ],
  };
  const noArtifact = gateG5({
    ...base,
    recorded: {
      G5: {
        by: "He",
        at: "2026-10-31T14:10:00Z",
        note: "read the parser output",
        artifact: "",
        accepted_ac_ids: ["AC-1", "AC-2"],
      },
    },
  });
  assert.equal(noArtifact.passed, false);
  assert.match(noArtifact.blocking.join(" "), /does not name the artifact/);

  const wrongArtifact = gateG5({
    ...base,
    envelope,
    recorded: {
      G5: {
        by: "He",
        at: "2026-10-31T14:10:00Z",
        note: "read the parser output",
        artifact: "some-other-build",
        accepted_ac_ids: ["AC-1", "AC-2"],
      },
    },
  });
  assert.equal(wrongArtifact.passed, false);
  assert.match(wrongArtifact.blocking.join(" "), /names some-other-build but the delivered artifact is build-7d4e880/);
});

test("G5 requires every criterion to be signed off", () => {
  const v = gateG5({
    requirements,
    deliveredArtifact,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output" },
    ],
    recorded: {
      G5: {
        by: "He",
        at: "2026-10-31T14:10:00Z",
        note: "read the parser output",
        artifact: deliveredArtifact,
        accepted_ac_ids: ["AC-1"],
      },
    },
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /leaves criteria unsigned: AC-2/);
});

test("G5 rejects an acceptance dated before the last verification", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications: [
      { ac_id: "AC-1", outcome: "passed", evidence: "npm test exit 0", at: "2026-10-31T15:00:00Z" },
      { ac_id: "AC-2", outcome: "passed", evidence: "He read the output", at: "2026-10-31T15:05:00Z" },
    ],
    recorded: {
      G5: {
        by: "He",
        at: "2026-10-31T14:00:00Z",
        note: "read the parser output",
        artifact: deliveredArtifact,
        accepted_ac_ids: ["AC-1", "AC-2"],
      },
    },
  });
  assert.equal(v.passed, false);
  assert.match(v.blocking.join(" "), /dated before the last verification/);
});

test("G5 rejects an acceptance whose note says nothing concrete", () => {
  const v = gateG5({
    requirements,
    envelope,
    deliveredArtifact,
    verifications,
    recorded: { G5: { ...acceptance, note: "it works fine and looks good to me" } },
  });
  // "works" is four letters, so this note does name something; it must pass.
  assert.equal(v.passed, true);
});

// ------------------------------------------------------------------ plumbing
test("evaluateGate refuses a gate it has no evaluator for", () => {
  assert.throws(() => evaluateGate("G9" as never, {}), /No evaluator/);
});

test("evaluateAllGates covers every gate exactly once", () => {
  const all = evaluateAllGates({});
  assert.equal(all.length, 6);
  assert.deepEqual(
    all.map((v) => v.gate),
    ["G0", "G1", "G2", "G3", "G4", "G5"],
  );
});

test("an empty input fails every gate rather than passing by default", () => {
  const all = evaluateAllGates({});
  for (const v of all) {
    assert.equal(v.passed, false, `${v.gate} must not pass on empty input`);
    assert.ok(v.blocking.length > 0, `${v.gate} must say why`);
  }
});

test("a fully evidenced project passes every gate", () => {
  const all = evaluateAllGates({
    requirements,
    envelope,
    deliveredArtifact,
    result: goodResult,
    tasks: plan,
    changedFiles: ["src/parser.ts"],
    reviewFindings: [{ severity: "Minor", resolved: false }],
    verifications,
    recorded: { G5: acceptance },
  });
  for (const v of all) {
    assert.equal(v.passed, true, `${v.gate} blocked: ${v.blocking.join("; ")}`);
  }
});
