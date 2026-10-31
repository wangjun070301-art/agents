import test from "node:test";
import assert from "node:assert/strict";
import { parseTestOutput, reconcileClaimedWithParsed } from "../src/workflow/test-output.js";

test("node --test summary is parsed into totals", () => {
  const out = [
    "ℹ tests 12",
    "ℹ pass 12",
    "ℹ fail 0",
    "",
  ].join("\n");
  const parsed = parseTestOutput(out);
  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.totals, { passed: 12, failed: 0, skipped: 0 });
  assert.equal(parsed.results[0]?.outcome, "passed");
});

test("node --test with failures is parsed as a failure", () => {
  const parsed = parseTestOutput("ℹ pass 3\nℹ fail 2\n");
  assert.equal(parsed.results[0]?.outcome, "failed");
  assert.deepEqual(parsed.totals, { passed: 3, failed: 2, skipped: 0 });
});

test("TAP lines are parsed individually", () => {
  const out = ["ok 1 - parses input", "not ok 2 - handles empty", "ok 3 - ignores whitespace # skip"].join("\n");
  const parsed = parseTestOutput(out);
  assert.deepEqual(
    parsed.results.map((r) => [r.name, r.outcome]),
    [
      ["parses input", "passed"],
      ["handles empty", "failed"],
      ["ignores whitespace # skip", "skipped"],
    ],
  );
});

test("jest summary line is parsed", () => {
  const parsed = parseTestOutput("Tests: 2 failed, 1 skipped, 9 passed, 12 total");
  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.totals, { passed: 9, failed: 2, skipped: 1 });
  assert.equal(parsed.results[0]?.outcome, "failed");
});

test("pytest summary is parsed", () => {
  const parsed = parseTestOutput("4 passed, 1 failed in 0.32s");
  assert.deepEqual(parsed.totals, { passed: 4, failed: 1, skipped: 0 });
});

test("a program that merely prints ok is not a test result", () => {
  const parsed = parseTestOutput("ok\nall good\n");
  assert.equal(parsed.empty, true);
  assert.equal(parsed.results.length, 0);
});

test("empty output is empty, not a silent pass", () => {
  const parsed = parseTestOutput("");
  assert.equal(parsed.empty, true);
});

test("a claimed pass with no supporting output is a discrepancy", () => {
  const problems = reconcileClaimedWithParsed(
    [{ name: "suite", outcome: "passed" }],
    parseTestOutput("nothing ran"),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /no test result/);
});

test("a claimed pass against an output full of failures is a discrepancy", () => {
  const problems = reconcileClaimedWithParsed(
    [{ name: "suite", outcome: "passed" }],
    parseTestOutput("ℹ pass 0\nℹ fail 5\n"),
  );
  assert.match(problems.join(" "), /failing/);
});

test("a claimed failure against an all-passing output is a discrepancy", () => {
  const problems = reconcileClaimedWithParsed(
    [{ name: "suite", outcome: "failed" }],
    parseTestOutput("ℹ pass 9\nℹ fail 0\n"),
  );
  assert.match(problems.join(" "), /0 failing/);
});

test("agreeing claim and output produce no discrepancy", () => {
  const problems = reconcileClaimedWithParsed(
    [{ name: "suite", outcome: "passed" }],
    parseTestOutput("ℹ pass 9\nℹ fail 0\n"),
  );
  assert.deepEqual(problems, []);
});

test("no claim at all is not a discrepancy by itself", () => {
  assert.deepEqual(reconcileClaimedWithParsed([], parseTestOutput("ℹ pass 4\nℹ fail 0\n")), []);
});
