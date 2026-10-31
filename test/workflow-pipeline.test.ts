import test from "node:test";
import assert from "node:assert/strict";
import { Pipeline, gateInputFor, type ProjectState } from "../src/workflow/pipeline.js";
import { requirementsSchema, taskEnvelopeSchema, taskResultSchema } from "../src/workflow/contracts.js";

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

const manualTask = taskEnvelopeSchema.parse({
  ...envelope,
  task_id: "T-2",
  role: "tester",
  acceptance_ids: ["AC-2"],
  dependencies: ["T-1"],
  allowed_paths: [],
  deliverables: ["(manual check record)"],
});

const result = taskResultSchema.parse({
  task_id: "T-1",
  status: "succeeded",
  summary: "parser written",
  changed_files: ["src/parser.js"],
  commands: [{ command: "node --test fixture/parser.test.js", exit_code: 0 }],
  test_results: [{ name: "fixture", outcome: "passed", acceptance_ids: ["AC-1"] }],
});

const deliveredArtifact = "build-final";
const verifications = [
  { ac_id: "AC-1", outcome: "passed" as const, evidence: "node --test exit 0", at: "2026-10-31T13:00:00Z" },
  { ac_id: "AC-2", outcome: "passed" as const, evidence: "He read fixture/out.txt", at: "2026-10-31T13:10:00Z" },
];
const acceptance = {
  by: "He",
  at: "2026-10-31T13:20:00Z",
  note: "read the output file and the parser test result",
  artifact: deliveredArtifact,
  accepted_ac_ids: ["AC-1", "AC-2"],
};

const state: ProjectState = {
  requirements,
  tasks: [envelope, manualTask],
  envelope,
  result,
  deliveredArtifact,
  changedFiles: ["src/parser.js"],
  reviewFindings: [{ severity: "Minor", resolved: false }],
  verifications,
  recorded: { G5: acceptance },
};

const fixedClock = () => new Date("2026-10-31T14:00:00Z");

test("a pipeline cannot skip a stage even with no gate involved", () => {
  const pipeline = new Pipeline("INTAKE", fixedClock);
  const result = pipeline.advance({ to: "PLAN" });
  assert.equal(result.ok, false);
  assert.equal(result.refused?.reason, "illegal-transition");
  assert.equal(pipeline.stage, "INTAKE");
});

test("a gated edge with no gate input is refused, not passed", () => {
  const pipeline = new Pipeline("SPEC", fixedClock);
  const result = pipeline.advance({ to: "PLAN" });
  assert.equal(result.ok, false);
  assert.equal(result.refused?.reason, "gate-input-missing");
  assert.match(result.refused!.detail, /G0/);
  assert.equal(pipeline.stage, "SPEC", "the stage must not move");
});

test("a failing gate keeps the pipeline where it is", () => {
  const pipeline = new Pipeline("SPEC", fixedClock);
  const result = pipeline.advance({ to: "PLAN", gateInput: {} });
  assert.equal(result.ok, false);
  assert.equal(result.refused?.reason, "gate-failed");
  assert.equal(result.refused?.verdict?.gate, "G0");
  assert.equal(pipeline.stage, "SPEC");
  assert.equal(pipeline.history.length, 0, "a refusal must not be recorded as progress");
});

test("a passing gate advances and records the verdict", () => {
  const pipeline = new Pipeline("SPEC", fixedClock);
  const result = pipeline.advance({
    to: "PLAN",
    gateInput: gateInputFor("SPEC", state),
  });
  assert.equal(result.ok, true);
  assert.equal(pipeline.stage, "PLAN");
  assert.equal(result.record?.gate, "G0");
  assert.equal(result.record?.verdict?.passed, true);
  assert.deepEqual(pipeline.passedGates, ["G0"]);
});

test("the full happy path walks every gate in order", () => {
  const pipeline = new Pipeline("INTAKE", fixedClock);
  const path: Array<[Parameters<typeof pipeline.advance>[0]["to"], string]> = [
    ["CLARIFY", "INTAKE"],
    ["BASELINE", "CLARIFY"],
    ["SPEC", "BASELINE"],
    ["PLAN", "SPEC"],
    ["DISPATCH", "PLAN"],
    ["IMPLEMENT", "DISPATCH"],
    ["REVIEW", "IMPLEMENT"],
    ["VERIFY", "REVIEW"],
    ["INTEGRATE", "VERIFY"],
    ["ACCEPT", "INTEGRATE"],
    ["DELIVER", "ACCEPT"],
    ["ARCHIVE", "DELIVER"],
  ];
  for (const [to, from] of path) {
    const outcome = pipeline.advance({ to, gateInput: gateInputFor(from as never, state) });
    assert.equal(outcome.ok, true, `${from} -> ${to} should pass: ${outcome.refused?.detail ?? ""}`);
  }
  assert.equal(pipeline.stage, "ARCHIVE");
  assert.deepEqual(pipeline.passedGates, ["G0", "G1", "G2", "G3", "G4", "G5"]);
  assert.equal(pipeline.history.length, 12);
});

test("a failed gate is never recorded as a passed gate", () => {
  const pipeline = new Pipeline("IMPLEMENT", fixedClock);
  // A result that claims success with nothing to back it.
  const thin = taskResultSchema.parse({
    task_id: "T-1",
    status: "succeeded",
    summary: "trust me",
    changed_files: ["src/parser.js"],
  });
  const outcome = pipeline.advance({
    to: "REVIEW",
    gateInput: gateInputFor("IMPLEMENT", { ...state, result: thin }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused?.verdict?.gate, "G2");
  assert.deepEqual(pipeline.passedGates, []);
});

test("BLOCKED can only be left for the stage that blocked", () => {
  const pipeline = new Pipeline("REVIEW", fixedClock);
  assert.equal(pipeline.advance({ to: "BLOCKED" }).ok, true);
  assert.equal(pipeline.stage, "BLOCKED");
  assert.equal(pipeline.isBlocked, true);

  // Resume into a stage that never blocked.
  assert.equal(pipeline.advance({ to: "VERIFY", blockedFrom: "IMPLEMENT" }).ok, false);

  // Resume into the right stage.
  const resumed = pipeline.advance({ to: "REVIEW", blockedFrom: "REVIEW" });
  assert.equal(resumed.ok, true);
  assert.equal(pipeline.stage, "REVIEW");
  assert.equal(pipeline.isBlocked, false);
});

test("a terminal stage refuses every advance", () => {
  const pipeline = new Pipeline("ARCHIVE", fixedClock);
  const result = pipeline.advance({ to: "DELIVER" });
  assert.equal(result.ok, false);
  assert.equal(result.refused?.reason, "terminal");
});

test("rework edges move backwards without a gate", () => {
  const pipeline = new Pipeline("REVIEW", fixedClock);
  assert.equal(pipeline.advance({ to: "IMPLEMENT" }).ok, true);
  assert.equal(pipeline.stage, "IMPLEMENT");
  assert.equal(pipeline.history.at(-1)?.gate, undefined);
});

test("requiredGatesTo lists what evidence a planner must gather", () => {
  const pipeline = new Pipeline("SPEC", fixedClock);
  assert.deepEqual(pipeline.requiredGatesTo("DELIVER"), ["G0", "G1", "G2", "G3", "G4", "G5"]);
  const mid = new Pipeline("IMPLEMENT", fixedClock);
  assert.deepEqual(mid.requiredGatesTo("ACCEPT"), ["G2", "G3", "G4"]);
});

test("advanceAll stops at the first refusal and reports it", () => {
  const pipeline = new Pipeline("SPEC", fixedClock);
  const result = pipeline.advanceAll([
    { to: "PLAN", gateInput: gateInputFor("SPEC", state) },
    // G1 with no tasks: must refuse.
    { to: "DISPATCH", gateInput: { requirements } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(pipeline.stage, "PLAN", "it advanced one step then stopped");
  assert.equal(result.refused?.verdict?.gate, "G1");
});
