#!/usr/bin/env node
/**
 * P8: walk all twelve stages with all six gates, on a real repository.
 *
 * Where real execution is possible, it happens:
 *   G2 - a real codex exec child edits the fixture; the observer records it
 *   G3 - a real second codex child reviews the diff
 *   G4 - the fixture's own tests are run, one verification per criterion
 *
 * Where it is not, the drill stops and says so:
 *   G5 - requires a named human acceptance. The drill refuses to invent one.
 *        It ends at ACCEPT with G5 blocked, which is the correct outcome.
 *        Pass --accept-by and --accept-note to supply a real acceptance.
 *
 * Usage:
 *   node tools/p8-full-path.mjs [--sandbox bypass|workspace-write]
 *                               [--accept-by NAME --accept-note TEXT]
 *                               [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import { Pipeline } from "../dist/workflow/pipeline.js";
import { Scheduler } from "../dist/workflow/scheduler.js";
import { snapshotWorktree } from "../dist/workflow/observer.js";
import { parseTestOutput } from "../dist/workflow/test-output.js";
import { requirementsSchema, taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const sandbox = arg("--sandbox", "bypass");
const acceptBy = arg("--accept-by", undefined);
const acceptNote = arg("--accept-note", undefined);
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
const note = (text) => {
  if (!jsonOut) console.log(text);
};

/** A fixture with two independently testable criteria. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p8-fixture-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src", "calc.js"),
    ["exports.add = (a, b) => a + b;", "exports.mul = (a, b) => a * b;", ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "src", "calc.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert");',
      'const { add, mul } = require("./calc.js");',
      'test("add works", () => assert.equal(add(2, 3), 5));',
      'test("mul works", () => assert.equal(mul(2, 3), 6));',
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

const home = path.join(repo, ".codex-home-p8");
fs.mkdirSync(home, { recursive: true });
for (const f of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
  const from = path.join(os.homedir(), ".codex", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(home, f));
}

const fixture = makeFixture();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "p8-state-"));
note(`[p8] fixture ${fixture}`);
note(`[p8] model=${model} sandbox=${sandbox}`);

// ------------------------------------------------------------------ project
// Two automated criteria, each with its own runnable check. No manual
// criterion, because a manual one needs a human and this drill has none
// until G5.
const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "calc adds and multiplies correctly",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "add returns the sum",
        kind: "automated",
        verification_command: "node --test-name-pattern=add src/calc.test.js",
      },
      {
        ac_id: "AC-2",
        requirement_id: "REQ-1",
        description: "mul returns the product",
        kind: "automated",
        verification_command: "node --test-name-pattern=mul src/calc.test.js",
      },
    ],
  },
]);

const devTask = taskEnvelopeSchema.parse({
  task_id: "T-DEV",
  role: "developer",
  objective:
    "In this repository, append the line `// reviewed` to src/calc.js. " +
    "Do not change any behaviour. Then run `node --test src/calc.test.js` " +
    "and report its real exit code and output.",
  repo_path: fixture,
  base_revision: "init",
  allowed_paths: ["src"],
  deliverables: ["src/calc.js"],
  acceptance_ids: ["AC-1", "AC-2"],
  verification_commands: [{ command: "node --test src/calc.test.js", expect_exit: 0 }],
  timeout_seconds: 300,
});

const adapter = new CodexAdapter({ codexPath, codexHome: home, model, sandbox, observeWorktree: true });
const pipeline = new Pipeline("INTAKE");
const scheduler = new Scheduler({ adapter, requirements, pipeline, maxAttempts: 2, stateDir });

// ------------------------------------------------------------------ stages
const stages = [];
function advance(to, state, label) {
  const outcome = scheduler.advanceStage(to, state, label);
  stages.push({ to, ok: outcome.ok, gate: outcome.record?.gate, reason: outcome.refused?.reason, detail: outcome.refused?.detail });
  note(`[p8] ${pipeline.stage} -> ${to}: ${outcome.ok ? "passed" : `refused (${outcome.refused?.reason})`}`);
  return outcome;
}

// Ungated: INTAKE -> CLARIFY -> BASELINE -> SPEC
advance("CLARIFY", {}, "intake complete");
advance("BASELINE", {}, "environment checked");
advance("SPEC", {}, "requirements drafted");

// G0: requirements are answerable.
const g0 = advance("PLAN", { requirements, tasks: [devTask] }, "spec approved");
record("G0", "requirements with deciders clear the requirement gate", g0.ok, g0.ok ? "passed" : g0.refused?.detail ?? "");

// G1: the plan covers every criterion and does not collide.
const g1 = advance("DISPATCH", { requirements, tasks: [devTask] }, "plan approved");
record("G1", "a plan covering every criterion clears the plan gate", g1.ok, g1.ok ? "passed" : g1.refused?.detail ?? "");

// Ungated: DISPATCH -> IMPLEMENT
advance("IMPLEMENT", {}, "dispatched");

// G2: a real child does the work, and the observer records what it did.
const run = await scheduler.runTask(devTask);
const last = run.attempts.at(-1);
note(`[p8] child run: ok=${run.ok} attempts=${run.attempts.length} observed=${JSON.stringify(last?.observedChanges ?? [])}`);
record(
  "G2-run",
  "the real child produced evidence the adapter could collect",
  run.ok && (last?.observedChanges ?? []).includes("src/calc.js"),
  run.ok ? `observed ${JSON.stringify(last?.observedChanges ?? [])}` : `refused: ${last?.refusal}`,
);
const g2 = advance(
  "REVIEW",
  {
    requirements,
    tasks: [devTask],
    envelope: devTask,
    result: last?.result,
    deliveredArtifact: "init",
    changedFiles: last?.observedChanges,
  },
  "implementation complete",
);
record("G2", "the implementation gate accepts a real run", g2.ok, g2.ok ? "passed" : g2.refused?.detail ?? "");

// G3: a second child reviews the diff, through the same adapter the developer
// run used. Hand-rolling `codex exec` here was a mistake: it bypassed the
// schema handling and the retry logic, and one run came back with a prose
// prefix instead of JSON.
const diff = execFileSync("git", ["-C", fixture, "diff", "--unified=0", "HEAD"], { encoding: "utf8" });
const reviewEnvelope = taskEnvelopeSchema.parse({
  task_id: "T-REVIEW",
  role: "reviewer",
  objective:
    "Review this diff for correctness, regressions and missing tests. " +
    "Return findings in test_results: one row per finding, name = the finding, " +
    "outcome = failed for an unresolved Blocker or Major and passed for anything " +
    "that is Minor, Suggestion or already resolved. detail carries the note. " +
    "If the change is comment-only and changes no behaviour, report one row " +
    "named `no findings` with outcome passed.\n\n```diff\n" +
    (diff.trim() || "(no diff)") +
    "\n```",
  repo_path: fixture,
  base_revision: "init",
  allowed_paths: [],
  deliverables: ["(review record)"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "git diff --stat HEAD", expect_exit: 0 }],
  timeout_seconds: 240,
});

const reviewRun = await adapter.execute(reviewEnvelope);
note(`[p8] reviewer result: ${reviewRun.status} — ${reviewRun.summary.slice(0, 120)}`);

// A finding row maps back to a GateInput finding. The reviewer's own vocabulary
// is already normalized by the adapter, so this only has to decide severity.
const findings = reviewRun.test_results
  .filter((t) => t.name.trim().toLowerCase() !== "no findings")
  .map((t) => ({
    severity: t.outcome === "failed" ? "Major" : "Minor",
    resolved: t.outcome !== "failed",
  }));
const reviewedClean =
  reviewRun.test_results.length > 0 &&
  reviewRun.test_results.every((t) => t.outcome === "passed");

note(`[p8] reviewer findings: ${JSON.stringify(findings)} (clean=${reviewedClean})`);
record(
  "G3-review",
  "a real reviewer produced structured findings through the adapter",
  reviewRun.test_results.length > 0,
  `${reviewRun.test_results.length} row(s), clean=${reviewedClean}`,
);

function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [text, fenced?.[1] ?? ""];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined;
}

const g3 = advance("VERIFY", { reviewFindings: findings }, "review complete");
record("G3", "the review gate accepts a real review", g3.ok, g3.ok ? "passed" : g3.refused?.detail ?? "");

// G4: run each criterion's own check, for real, and record the transcript.
const verifications = [];
for (const ac of requirements.flatMap((r) => r.acceptance)) {
  const startedAt = new Date().toISOString();
  let output = "";
  let exitCode = 0;
  try {
    output = execFileSync("node", ["--test-name-pattern", ac.ac_id === "AC-1" ? "add" : "mul", "src/calc.test.js"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    exitCode = typeof error.status === "number" ? error.status : -1;
  }
  const parsed = parseTestOutput(output);
  const passed = exitCode === 0 && parsed.results.some((r) => r.outcome === "passed");
  verifications.push({
    ac_id: ac.ac_id,
    outcome: passed ? "passed" : "failed",
    evidence: `${ac.verification_command} exit ${exitCode}; ${parsed.totals ? `${parsed.totals.passed} passed, ${parsed.totals.failed} failed` : `${parsed.results.length} parsed result(s)`}`,
    at: startedAt,
  });
  note(`[p8] ${ac.ac_id}: exit=${exitCode} parsed=${parsed.results.length} -> ${passed ? "passed" : "failed"}`);
}
record(
  "G4-run",
  "every criterion was verified by running its own command",
  verifications.every((v) => v.outcome === "passed"),
  JSON.stringify(verifications.map((v) => `${v.ac_id}:${v.outcome}`)),
);
const g4 = advance("INTEGRATE", { requirements, verifications }, "verification complete");
record("G4", "the verification gate accepts real per-criterion evidence", g4.ok, g4.ok ? "passed" : g4.refused?.detail ?? "");

// Ungated: INTEGRATE -> ACCEPT
advance("ACCEPT", {}, "integration complete");

// G5: a named human acceptance. Never invented.
const artifact = snapshotHash(fixture);
const acceptance = acceptBy && acceptNote
  ? { by: acceptBy, at: new Date().toISOString(), note: acceptNote, artifact, accepted_ac_ids: ["AC-1", "AC-2"] }
  : undefined;
const g5 = advance(
  "DELIVER",
  { requirements, deliveredArtifact: artifact, verifications, recorded: acceptance ? { G5: acceptance } : {} },
  acceptance ? `accepted by ${acceptBy}` : "pending human acceptance",
);
note(`[p8] delivered artifact: ${artifact}`);

if (acceptance) {
  record("G5", "the delivery gate accepts a named human acceptance", g5.ok, g5.ok ? "passed" : g5.refused?.detail ?? "");
} else {
  // The honest outcome: without a human, the gate blocks. This is a pass for
  // the drill, because the drill's job is to prove the gate blocks.
  record(
    "G5",
    "the delivery gate blocks without a named human acceptance",
    !g5.ok && g5.refused?.verdict?.gate === "G5",
    `blocked: ${g5.refused?.detail ?? "(it passed, which is wrong)"}`,
  );
}

record(
  "STAGES",
  "every gated edge was exercised on a real run",
  ["G0", "G1", "G2", "G3", "G4", "G5"].every((g) => pipeline.history.some((h) => h.gate === g) || (g === "G5" && !g5.ok)),
  `gates recorded: ${JSON.stringify(pipeline.history.map((h) => h.gate).filter(Boolean))}`,
);

if (acceptance) advance("ARCHIVE", {}, "delivered");

note(`[p8] final stage ${pipeline.stage}`);
fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });

if (jsonOut) {
  console.log(JSON.stringify({ results, stages, verifications, artifact }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (!acceptance) {
    console.log("note: G5 blocked as designed. Re-run with --accept-by <name> --accept-note <what you checked> to complete delivery.");
  }
  if (failed.length) for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);

/** A stable hash of the worktree contents, standing in for a build id. */
function snapshotHash(root) {
  const snap = snapshotWorktree(root);
  const sorted = [...snap.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  return crypto
    .createHash("sha256")
    .update(sorted.map(([p, h]) => `${p}:${h}`).join("\n"))
    .digest("hex")
    .slice(0, 12);
}
