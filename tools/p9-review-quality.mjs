#!/usr/bin/env node
/**
 * P9 item 5: does the reviewer catch a defect, or just emit well-formed JSON?
 *
 * The P8 drill reviews a comment-only diff and the reviewer says "clean".
 * That proves the reviewer can be agreeable. This drill hands it a diff with a
 * real bug and checks that it says so.
 *
 * A reviewer that says "clean" to both is a rubber stamp, and this drill fails.
 *
 * Usage: node tools/p9-review-quality.mjs [--sandbox bypass] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import { taskEnvelopeSchema } from "../dist/workflow/contracts.js";

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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p9-review-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "calc.js"), "exports.add = (a, b) => a + b;\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "src", "calc.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert");',
      'const { add } = require("./calc.js");',
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

const home = path.join(repo, ".codex-home-p9");
fs.mkdirSync(home, { recursive: true });
for (const f of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
  const from = path.join(os.homedir(), ".codex", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(home, f));
}

const adapter = new CodexAdapter({ codexPath, codexHome: home, model, sandbox, observeWorktree: false });

async function review(label, diff, dir) {
  const envelope = taskEnvelopeSchema.parse({
    task_id: `T-REV-${label}`,
    role: "reviewer",
    objective:
      "Review this diff for correctness. Return test_results with one row per finding: " +
      "outcome = failed for a defect that should block, passed for a clean change. " +
      "If there are no findings, return exactly one row named `no findings` with outcome passed.\n\n" +
      "```diff\n" +
      diff +
      "\n```",
    repo_path: dir,
    base_revision: "init",
    allowed_paths: [],
    deliverables: ["(review record)"],
    acceptance_ids: ["AC-1"],
    verification_commands: [{ command: "git diff --stat HEAD", expect_exit: 0 }],
    timeout_seconds: 240,
  });
  const result = await adapter.execute(envelope);
  const findings = result.test_results.filter((t) => t.name.trim().toLowerCase() !== "no findings");
  const clean = result.test_results.some(
    (t) => t.name.trim().toLowerCase() === "no findings" && t.outcome === "passed",
  );
  return { result, findings, clean, status: result.status };
}

const dirA = fixture();
fs.writeFileSync(path.join(dirA, "src", "calc.js"), "exports.add = (a, b) => a + b;\n// tuned\n", "utf8");
const diffA = execFileSync("git", ["-C", dirA, "diff", "HEAD"], { encoding: "utf8" });
const a = await review("A", diffA, dirA);
console.log(`[p9] A (comment-only): status=${a.status} findings=${a.findings.length} clean=${a.clean}`);
record(
  "R-A",
  "a comment-only change is reported as clean",
  a.clean && a.findings.length === 0,
  `findings=${a.findings.length}, clean=${a.clean}`,
);

const dirB = fixture();
fs.writeFileSync(path.join(dirB, "src", "calc.js"), "exports.add = (a, b) => a - b;\n", "utf8");
const diffB = execFileSync("git", ["-C", dirB, "diff", "HEAD"], { encoding: "utf8" });
const b = await review("B", diffB, dirB);
console.log(`[p9] B (breaks the test): status=${b.status} findings=${b.findings.length} clean=${b.clean}`);
record(
  "R-B",
  "a change that breaks a test is reported as a defect",
  b.findings.length > 0 && !b.clean,
  `findings=${b.findings.length}, clean=${b.clean}, ${b.findings.map((f) => `${f.outcome}:${f.name.slice(0, 40)}`).join(" | ")}`,
);

record(
  "R-DIFF",
  "the reviewer distinguishes a clean change from a broken one",
  a.clean !== b.clean || a.findings.length !== b.findings.length,
  `A: ${a.findings.length} findings, B: ${b.findings.length} findings`,
);

fs.rmSync(dirA, { recursive: true, force: true });
fs.rmSync(dirB, { recursive: true, force: true });

if (jsonOut) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
