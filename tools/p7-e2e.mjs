#!/usr/bin/env node
/**
 * P7: drive the scheduler against a real child process.
 *
 * First run where all four pieces are connected:
 *   scheduler -> CodexAdapter -> observer/test-output -> Pipeline gates
 *
 * The scenario is honest on purpose: a drill that only ever shows refusals
 * proves the gates are paranoid, not that the wiring works. The last check
 * then inflates the claim and shows the same wiring refuse it.
 *
 * Usage: node tools/p7-e2e.mjs [--sandbox bypass|workspace-write] [--json]
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
const sandboxArg = process.argv.indexOf("--sandbox");
const sandbox = sandboxArg > -1 ? process.argv[sandboxArg + 1] : "bypass";
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

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-fixture-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "greet.js"), 'exports.greet = (name) => `hello ${name}`;\n', "utf8");
  fs.writeFileSync(
    path.join(dir, "src", "greet.test.js"),
    [
      'const assert = require("node:assert");',
      'const { greet } = require("./greet.js");',
      'assert.equal(greet("world"), "hello world");',
      'console.log("ok");',
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

const home = path.join(repo, ".codex-home-p7");
fs.mkdirSync(home, { recursive: true });
for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
  const from = path.join(os.homedir(), ".codex", file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(home, file));
}

const fixture = makeFixture();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-state-"));
console.log(`[p7] fixture: ${fixture}`);
console.log(`[p7] state:   ${stateDir}`);
console.log(`[p7] model=${model} sandbox=${sandbox}`);

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "greet returns a greeting for a name",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "the test file passes",
        kind: "automated",
        verification_command: "node --test src/greet.test.js",
      },
    ],
  },
]);

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-P7",
  role: "developer",
  objective:
    "In this repository, append the line `// tuned` to src/greet.js, " +
    "then run `node --test src/greet.test.js` and report its real exit code. " +
    "Report a test outcome only if that command actually printed test results.",
  repo_path: fixture,
  base_revision: "init",
  allowed_paths: ["src"],
  deliverables: ["src/greet.js"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --test src/greet.test.js", expect_exit: 0 }],
  timeout_seconds: 300,
});

const adapter = new CodexAdapter({ codexPath, codexHome: home, model, sandbox, observeWorktree: true });
const pipeline = new Pipeline("IMPLEMENT");
const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 2, stateDir });

console.log(`[p7] starting at stage ${pipeline.stage}`);
const started = Date.now();
const outcome = await scheduler.runTask(envelope);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[p7] runTask: ok=${outcome.ok} attempts=${outcome.attempts.length} elapsed=${elapsed}s`);
console.log(`[p7] stage after runTask: ${pipeline.stage}`);

const last = outcome.attempts.at(-1);
if (last) {
  console.log(`[p7] claimed:  ${JSON.stringify(last.result?.changed_files ?? [])}`);
  console.log(`[p7] observed: ${JSON.stringify(last.observedChanges ?? [])}`);
  console.log(`[p7] refusal:  ${last.refusal ?? "(none)"}`);
}

record(
  "S1",
  "the task completed without a refusal",
  outcome.ok,
  outcome.ok ? `${outcome.attempts.length} attempt(s)` : `refused: ${last?.refusal}`,
);

record(
  "S2",
  "the run did not move the stage by itself",
  pipeline.stage === "IMPLEMENT",
  `stage is ${pipeline.stage}; only advanceStage moves it`,
);

record(
  "S3",
  "the adapter observed the real edit",
  (last?.observedChanges ?? []).includes("src/greet.js"),
  `observed ${JSON.stringify(last?.observedChanges ?? [])}`,
);

record(
  "S4",
  "attempt records were persisted",
  fs.existsSync(path.join(stateDir, "tasks", "T-P7", "attempt-1.json")),
  `state dir ${stateDir}`,
);

const advance = scheduler.advanceStage("REVIEW", {
  requirements,
  tasks: [envelope],
  envelope,
  result: last?.result,
  deliveredArtifact: "init",
  changedFiles: last?.observedChanges,
});
console.log(`[p7] advanceStage -> ${advance.ok ? "passed" : "refused"}: ${advance.refused?.detail ?? ""}`);

record(
  "S5",
  "G2 passes the real run on real evidence",
  advance.ok,
  advance.ok ? `stage is now ${pipeline.stage}` : `refused: ${advance.refused?.detail}`,
);

record(
  "S6",
  "the gate that passed is recorded in the pipeline history",
  pipeline.passedGates.includes("G2"),
  `passedGates=${JSON.stringify(pipeline.passedGates)}`,
);

// The pipeline already moved to REVIEW, so a fresh one is needed to test the
// refusal at the same edge. Reusing it would only prove "you cannot go to
// REVIEW from REVIEW", which is a different property.
const inflated = last?.result
  ? { ...last.result, changed_files: [...last.result.changed_files, "src/never-touched.js"] }
  : undefined;
const refusalPipeline = new Pipeline("IMPLEMENT");
const refusalScheduler = new Scheduler({
  adapter,
  requirements,
  pipeline: refusalPipeline,
  maxAttempts: 1,
});
const refused = refusalScheduler.advanceStage("REVIEW", {
  requirements,
  tasks: [envelope],
  envelope,
  result: inflated,
  deliveredArtifact: "init",
  changedFiles: last?.observedChanges,
});
record(
  "S7",
  "the same wiring refuses an inflated claim",
  !refused.ok && refused.refused?.reason === "gate-failed",
  refused.ok ? "it wrongly passed" : `${refused.refused?.reason}: ${refused.refused?.detail ?? ""}`,
);

fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });

if (jsonOut) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
  }
}
process.exit(results.every((r) => r.ok) ? 0 : 1);


