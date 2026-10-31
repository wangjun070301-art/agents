#!/usr/bin/env node
/**
 * P4 drill: does the gate chain actually stop bad work?
 *
 * Each scenario builds a complete GateInput, feeds it to evaluateAllGates, and
 * asserts the expected gate blocks. The scenarios are deliberately dishonest:
 * a task that claims success without running anything, a developer who edits a
 * file outside its allowlist, a reviewer who signs off a blocker, a delivery
 * with an unverified criterion, and an acceptance stamped before the work.
 *
 * A gate suite that passes all of these has proved nothing. This drill fails
 * the build when a gate lets one through.
 *
 * Usage: node tools/p4-drill.mjs [--json]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requirementsSchema,
  taskEnvelopeSchema,
  taskResultSchema,
} from "../dist/workflow/contracts.js";
import { evaluateAllGates } from "../dist/workflow/gates.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json");
const results = [];

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "the fixture parser reads a two-line file",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "parses the fixture and returns two records",
        kind: "automated",
        verification_command: "node --test fixture/parser.test.js",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "the output reads correctly to a human",
        kind: "manual",
        manual_check: { owner: "He", procedure: "read fixture/out.txt" },
      },
    ],
  },
]);

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-PARSE",
  role: "developer",
  objective: "write the fixture parser",
  repo_path: path.join(repo, "fixture"),
  base_revision: "base-abc",
  allowed_paths: ["src"],
  deliverables: ["src/parser.js"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --test fixture/parser.test.js", expect_exit: 0 }],
});

const honestResult = taskResultSchema.parse({
  task_id: "T-PARSE",
  status: "succeeded",
  summary: "parser written and tested",
  changed_files: ["src/parser.js"],
  commands: [{ command: "node --test fixture/parser.test.js", exit_code: 0 }],
  test_results: [{ name: "parser fixture", outcome: "passed", acceptance_ids: ["AC-1"] }],
});

const manualTask = taskEnvelopeSchema.parse({
  task_id: "T-READ",
  role: "tester",
  objective: "confirm the output reads correctly",
  repo_path: path.join(repo, "fixture"),
  base_revision: "base-abc",
  allowed_paths: [],
  deliverables: ["(manual check record)"],
  acceptance_ids: ["AC-2"],
  dependencies: ["T-PARSE"],
});

const deliveredArtifact = "build-final";
const honestVerifications = [
  { ac_id: "AC-1", outcome: "passed", evidence: "node --test exit 0, 4 assertions", at: "2026-10-31T13:00:00Z" },
  { ac_id: "AC-2", outcome: "passed", evidence: "He read fixture/out.txt at 13:10", at: "2026-10-31T13:10:00Z" },
];
const honestAcceptance = {
  by: "He",
  at: "2026-10-31T13:20:00Z",
  note: "read the output file and the parser test result",
  artifact: deliveredArtifact,
  accepted_ac_ids: ["AC-1", "AC-2"],
};

/** The baseline every scenario starts from: a delivery that should pass. */
function baseline() {
  return {
    requirements,
    envelope,
    deliveredArtifact,
    result: honestResult,
    tasks: [envelope, manualTask],
    changedFiles: ["src/parser.js"],
    reviewFindings: [{ severity: "Minor", resolved: false }],
    verifications: honestVerifications,
    recorded: { G5: honestAcceptance },
  };
}

/**
 * `expectedBlocked` is the full set of gates that must block — not a subset.
 * A scenario that blocks extra gates is failing for the wrong reason, and a
 * drill that accepts that is testing nothing. The only exception is a gate
 * that necessarily inherits a later one (G5 inherits G4), which each scenario
 * declares explicitly in `alsoAllowed`.
 */
function check(id, name, input, expectedBlocked, alsoAllowed = []) {
  const verdicts = evaluateAllGates(input);
  const blocked = verdicts.filter((v) => !v.passed).map((v) => v.gate);
  const unexpected = blocked.filter((gate) => !expectedBlocked.includes(gate) && !alsoAllowed.includes(gate));
  const missing = expectedBlocked.filter((gate) => !blocked.includes(gate));
  const ok = unexpected.length === 0 && missing.length === 0;
  const parts = [];
  if (missing.length) parts.push(`did not block: ${missing.join(",")}`);
  if (unexpected.length) parts.push(`blocked for the wrong reason: ${unexpected.join(",")}`);
  const detail = parts.length
    ? `expected ${expectedBlocked.join(",") || "(none)"}; actually blocked ${blocked.join(",") || "(none)"}; ${parts.join("; ")}`
    : `expected ${expectedBlocked.join(",") || "(none)"}; actually blocked ${blocked.join(",") || "(none)"}`;
  results.push({ id, name, ok, detail });
  if (!jsonOut) {
    console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}`);
    console.log(`      ${detail}`);
  }
}

// Scenario 0: the honest baseline must pass. If this fails, the drill is
// testing a gate suite that rejects everything and proves nothing.
check("S0", "an honest delivery passes every gate", baseline(), []);

// Scenario 0b: a minor finding that was resolved must not block. A gate that
// only ever blocks is as useless as one that never does.
check(
  "S0b",
  "a resolved Major does not block delivery",
  {
    ...baseline(),
    reviewFindings: [
      { severity: "Major", resolved: true },
      { severity: "Minor", resolved: false },
      { severity: "Suggestion", resolved: false },
    ],
  },
  [],
);

// Scenario 0c: an absolute-path file report must not be punished for being
// precise. The protocol accepts both spellings.
check(
  "S0c",
  "an absolute-path change report is accepted",
  {
    ...baseline(),
    result: taskResultSchema.parse({
      ...honestResult,
      changed_files: [path.join(repo, "fixture", "src", "parser.js")],
    }),
    changedFiles: [path.join(repo, "fixture", "src", "parser.js")],
  },
  [],
);

// Scenario 1: a developer claims success having run nothing.
check(
  "S1",
  "a success claim with no command and no test is stopped at G2",
  {
    ...baseline(),
    result: taskResultSchema.parse({
      task_id: "T-PARSE",
      status: "succeeded",
      summary: "trust me",
      changed_files: ["src/parser.js"],
    }),
  },
  ["G2"],
);

// Scenario 2: a developer edits a file it was not allowed to touch.
check(
  "S2",
  "an edit outside allowed_paths is stopped at G2",
  {
    ...baseline(),
    result: taskResultSchema.parse({
      ...honestResult,
      changed_files: ["src/parser.js", "README.md"],
    }),
    changedFiles: ["src/parser.js", "README.md"],
  },
  ["G2"],
);

// Scenario 3: a developer hides an edit it did make.
check(
  "S3",
  "an unreported change is stopped at G2",
  { ...baseline(), changedFiles: ["src/parser.js", "fixture/config.json"] },
  ["G2"],
);

// Scenario 4: the reviewer signs off on an unresolved blocker.
check(
  "S4",
  "an unresolved Blocker is stopped at G3",
  {
    ...baseline(),
    reviewFindings: [
      { severity: "Blocker", resolved: false },
      { severity: "Minor", resolved: false },
    ],
  },
  ["G3"],
);

// Scenario 5: a delivery where one criterion was never verified.
check(
  "S5",
  "an unverified criterion is stopped at G4 and G5",
  {
    ...baseline(),
    verifications: [
      honestVerifications[0],
      { ac_id: "AC-2", outcome: "unverified", evidence: "", at: "2026-10-31T13:10:00Z" },
    ],
  },
  ["G4", "G5"],
);

// Scenario 6: a pass that cites nothing.
check(
  "S6",
  "a pass with shrug-for-evidence is stopped at G4",
  {
    ...baseline(),
    verifications: [
      honestVerifications[0],
      { ac_id: "AC-2", outcome: "passed", evidence: "n/a", at: "2026-10-31T13:10:00Z" },
    ],
  },
  ["G4", "G5"],
);

// Scenario 7: the acceptance was stamped before the work it accepts.
check(
  "S7",
  "an acceptance dated before the verification is stopped at G5",
  {
    ...baseline(),
    recorded: {
      G5: { ...honestAcceptance, at: "2026-10-31T12:00:00Z" },
    },
  },
  ["G5"],
);

// Scenario 8: the acceptance names a different build than the one delivered.
check(
  "S8",
  "an acceptance of the wrong build is stopped at G5",
  {
    ...baseline(),
    recorded: { G5: { ...honestAcceptance, artifact: "some-earlier-build" } },
  },
  ["G5"],
);

// Scenario 9: the acceptance signs off only part of the work.
check(
  "S9",
  "a partial sign-off is stopped at G5",
  {
    ...baseline(),
    recorded: { G5: { ...honestAcceptance, accepted_ac_ids: ["AC-1"] } },
  },
  ["G5"],
);

// Scenario 10: two parallel tasks writing the same tree.
check(
  "S10",
  "parallel tasks sharing a write target are stopped at G1",
  {
    ...baseline(),
    tasks: [
      envelope,
      taskEnvelopeSchema.parse({
        ...manualTask,
        task_id: "T-RACE",
        dependencies: [],
        allowed_paths: ["src"],
        acceptance_ids: ["AC-2"],
      }),
    ],
  },
  ["G1"],
);

// Scenario 11: a plan with a dependency cycle.
check(
  "S11",
  "a dependency cycle is stopped at G1",
  {
    ...baseline(),
    tasks: [
      taskEnvelopeSchema.parse({ ...envelope, dependencies: ["T-READ"] }),
      taskEnvelopeSchema.parse({ ...manualTask, dependencies: ["T-PARSE"] }),
    ],
  },
  ["G1"],
);

// Scenario 12: the plan leaves one criterion unclaimed.
check(
  "S12",
  "an unclaimed acceptance criterion is stopped at G1",
  {
    ...baseline(),
    tasks: [envelope],
  },
  ["G1"],
);

if (jsonOut) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} scenarios behaved as required`);
  if (failed.length) {
    console.log("gates that failed to stop bad work:");
    for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
