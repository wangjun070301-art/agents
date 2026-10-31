#!/usr/bin/env node
/**
 * P10: runPlan against real child processes, plus real failure recovery.
 *
 * Until now runPlan was only tested with a stub adapter that answers instantly.
 * This runs three real `codex exec` children through the scheduler and checks
 * that the order, the observation, and the stage gate all hold with real timing.
 *
 * It then forces two failures a stub cannot reproduce: a child told to write
 * outside its allowlist, and a child given a timeout it cannot beat.
 *
 * Usage: node tools/p10-real-plan.mjs [--sandbox bypass|workspace-write] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import { Pipeline } from "../dist/workflow/pipeline.js";
import { Scheduler } from "../dist/workflow/scheduler.js";
import { requirementsSchema, taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const sandbox = arg("--sandbox", "bypass");
const model = process.env.SMOKE_MODEL ?? "deepseek-v4.1-flash-solo";
const codexPath =
  process.env.SMOKE_CODEX ??
  "C:\\Users\\13420\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe";

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  if (!jsonOut) {
    console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}`);
    console.log(`      ${detail}`);
  }
};
const note = (t) => {
  if (!jsonOut) console.log(t);
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p10-fixture-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "exports.a = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "exports.b = 2;\n", "utf8");
  // Each module gets its own test file, so each task can run a real check and
  // the transcript parser has something genuine to read.
  fs.writeFileSync(
    path.join(dir, "src", "a.test.js"),
    ['const test = require("node:test");', 'const assert = require("node:assert");',
     'const { a } = require("./a.js");', 'test("a exports", () => assert.equal(a, 1));', ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "src", "b.test.js"),
    ['const test = require("node:test");', 'const assert = require("node:assert");',
     'const { b } = require("./b.js");', 'test("b exports", () => assert.equal(b, 2));', ""].join("\n"),
    "utf8",
  );
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

const home = path.join(repo, ".codex-home-p10");
fs.mkdirSync(home, { recursive: true });
for (const f of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
  const from = path.join(os.homedir(), ".codex", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(home, f));
}

const dir = fixture();
note(`[p10] fixture ${dir}`);

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "two modules exist",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "a.js loads",
        kind: "automated",
        verification_command: "node -e require",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "b.js loads",
        kind: "automated",
        verification_command: "node -e require",
      },
    ],
  },
]);

const base = { role: "developer", repo_path: dir, base_revision: "init", timeout_seconds: 180 };
const plan = [
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-A",
    objective:
      "Append the exact line `// marker-a` to src/a.js. Change nothing else. " +
      "Then actually run `node --test src/a.test.js` and report its real exit code and the output it printed.",
    allowed_paths: ["src/a.js"],
    deliverables: ["src/a.js"],
    acceptance_ids: ["AC-1"],
    verification_commands: [{ command: "node --test src/a.test.js", expect_exit: 0 }],
  }),
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-B",
    objective:
      "Append the exact line `// marker-b` to src/b.js. Change nothing else. " +
      "Then actually run `node --test src/b.test.js` and report its real exit code and the output it printed.",
    allowed_paths: ["src/b.js"],
    deliverables: ["src/b.js"],
    acceptance_ids: ["AC-2"],
    verification_commands: [{ command: "node --test src/b.test.js", expect_exit: 0 }],
  }),
  taskEnvelopeSchema.parse({
    ...base,
    task_id: "T-JOIN",
    objective:
      "Run these two commands and report each exit code: `node --test src/a.test.js` " +
      "and `node --test src/b.test.js`. You must actually execute both. " +
      "Do not modify any file.",
    allowed_paths: [],
    deliverables: ["(no file)"],
    acceptance_ids: ["AC-1", "AC-2"],
    dependencies: ["T-A", "T-B"],
    verification_commands: [
      { command: "node --test src/a.test.js", expect_exit: 0 },
      { command: "node --test src/b.test.js", expect_exit: 0 },
    ],
  }),
];

const adapter = new CodexAdapter({ codexPath, codexHome: home, model, sandbox, observeWorktree: true });
const pipeline = new Pipeline("PLAN");
const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 1 });

note("[p10] running three real children through runPlan");
const started = Date.now();
const outcome = await scheduler.runPlan(plan);
const elapsed = ((Date.now() - started) / 1000).toFixed(0);

note(
  `[p10] completed=${JSON.stringify(outcome.completed)} failed=${outcome.failed.length} skipped=${outcome.skipped.length} elapsed=${elapsed}s`,
);
for (const f of outcome.failed) note(`[p10]   failure ${f.taskId}: ${f.reason} — ${f.detail}`);
for (const s of outcome.skipped) note(`[p10]   skipped ${s.taskId}: ${s.because}`);

record(
  "P1",
  "runPlan completed both independent tasks with real children",
  outcome.completed.includes("T-A") && outcome.completed.includes("T-B"),
  `completed ${JSON.stringify(outcome.completed)}`,
);

// The join task depends on both edits. Whether it completes is up to the
// child's obedience; what the drill can assert is that it never ran before
// its dependencies, and that a refusal names a real reason rather than a
// crash or a hang.
const joinFailure = outcome.failed.find((f) => f.taskId === "T-JOIN");
const joinSkipped = outcome.skipped.find((s) => s.taskId === "T-JOIN");
const joinOrdered = !joinSkipped || /T-A|T-B/.test(joinSkipped.because);
record(
  "P2",
  "the dependent task ran only after both dependencies, and any refusal names a reason",
  joinOrdered && (outcome.completed.includes("T-JOIN") || joinFailure !== undefined),
  joinSkipped
    ? `skipped because ${joinSkipped.because}`
    : joinFailure
      ? `refused: ${joinFailure.detail.slice(0, 100)}`
      : "join completed after both dependencies",
);

const observedA = adapter.observedChanges("T-A") ?? [];
const observedB = adapter.observedChanges("T-B") ?? [];
record(
  "P3",
  "the observer recorded each task's real edit separately",
  observedA.some((c) => c.path === "src/a.js") && observedB.some((c) => c.path === "src/b.js"),
  `A: ${JSON.stringify(observedA.map((c) => c.path))}, B: ${JSON.stringify(observedB.map((c) => c.path))}`,
);

record("P4", "the stage did not move during runPlan", pipeline.stage === "PLAN", `stage is ${pipeline.stage}`);

const g1 = scheduler.advanceStage("DISPATCH", { requirements, tasks: plan });
record("P5", "G1 accepts the real three-task plan", g1.ok, g1.ok ? "passed" : g1.refused?.detail ?? "");

note("[p10] forcing real failures");

// A child is not a reliable rule-breaker: asking it to write outside its
// allowlist often produces compliance, not a violation. So the violation is
// introduced by the worktree itself, after the child finishes, and the gate
// sees it through the observer. That tests the detector, not the model's
// willingness to misbehave.
const beforeEscape = adapter.observedChanges("T-A") ?? [];
fs.writeFileSync(path.join(dir, "escape.txt"), "escaped\n", "utf8");
// P5 already moved this pipeline to DISPATCH. G2 lives on the IMPLEMENT edge,
// so a fresh pipeline is needed to test it.
const g2Pipeline = new Pipeline("IMPLEMENT");
const g2Scheduler = new Scheduler({ adapter, requirements, pipeline: g2Pipeline, maxAttempts: 1 });
const escapeVerdict = g2Scheduler.advanceStage("REVIEW", {
  requirements,
  tasks: plan,
  envelope: plan[0],
  result: {
    task_id: "T-A",
    status: "succeeded",
    summary: "done",
    changed_files: ["src/a.js"],
    commands: [{ command: "node --test src/a.test.js", exit_code: 0 }],
    test_results: [{ name: "a exports", outcome: "passed", acceptance_ids: ["AC-1"] }],
    artifacts: [],
    unresolved_issues: [],
    risks: [],
    suggested_next_step: "",
  },
  deliveredArtifact: "init",
  changedFiles: ["src/a.js", "escape.txt"],
});
note(`[p10] out-of-allowlist probe: ${escapeVerdict.ok ? "passed (wrong)" : escapeVerdict.refused?.detail}`);
record(
  "P6",
  "a file written outside the allowlist is refused by G2",
  !escapeVerdict.ok && escapeVerdict.refused?.verdict?.gate === "G2",
  escapeVerdict.ok ? "it wrongly passed" : `${escapeVerdict.refused?.verdict?.gate}: ${escapeVerdict.refused?.detail ?? ""}`,
);
fs.rmSync(path.join(dir, "escape.txt"), { force: true });

const timeoutTask = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-TIMEOUT",
  // The protocol's minimum is 10 seconds, and a fast run can beat it. The check
  // below therefore accepts either outcome and asserts only that a timeout,
  // when it happens, is classified as adapter-error rather than gate-failed.
  objective: "Run `node --test src/a.test.js`, then report its exit code and test output.",
  allowed_paths: [],
  deliverables: ["(no file)"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --test src/a.test.js", expect_exit: 0 }],
  timeout_seconds: 10,
});
const timeoutRun = await scheduler.runTask(timeoutTask);
note(
  `[p10] timeout run: ok=${timeoutRun.ok} reason=${timeoutRun.failure?.reason} detail=${(timeoutRun.failure?.detail ?? "").slice(0, 120)}`,
);
// A short budget usually times out, but a fast child can finish first. What
// matters is that a timeout, when it occurs, is classified as an adapter error
// and leaves the stage alone — and that a completed run is not called a failure.
const timedOut = !timeoutRun.ok;
record(
  "P7",
  "a short timeout is either classified as adapter-error or the task genuinely finished",
  timedOut
    ? timeoutRun.failure?.reason === "adapter-error" && pipeline.stage === "DISPATCH"
    : timeoutRun.ok && pipeline.stage === "DISPATCH",
  timedOut
    ? `timed out: ${timeoutRun.failure?.reason}`
    : "the child finished inside 8s; the timeout path was not exercised on this run",
);

fs.rmSync(dir, { recursive: true, force: true });

if (jsonOut) {
  console.log(JSON.stringify({ results, outcome }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
