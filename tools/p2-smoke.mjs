#!/usr/bin/env node
/**
 * P2 smoke test: drive the real CodexAdapter against the real codex binary.
 *
 * This is not a unit test. It starts an actual child process, asks it to run
 * a command, and then checks the returned TaskResult against the envelope with
 * validateTaskResult. If the child cannot execute anything, the run must fail
 * loudly rather than report success.
 *
 * Usage:
 *   node tools/p2-smoke.mjs [--sandbox workspace-write|bypass]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import {
  claimIsSupported,
  taskEnvelopeSchema,
  validateTaskResult,
} from "../dist/workflow/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const flagIndex = process.argv.indexOf("--sandbox");
const sandbox = flagIndex > -1 ? process.argv[flagIndex + 1] : "workspace-write";
const model = process.env.SMOKE_MODEL ?? "deepseek-v4.1-flash-solo";
const codexPath =
  process.env.SMOKE_CODEX ??
  "C:\\Users\\13420\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe";

const home = path.join(repo, ".codex-home-p2");
for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
  const from = path.join(os.homedir(), ".codex", file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(home, file));
}

const adapter = new CodexAdapter({
  codexPath,
  codexHome: home,
  model,
  sandbox,
});

const envelope = taskEnvelopeSchema.parse({
  task_id: `T-P2-${Date.now()}`,
  role: "developer",
  objective:
    "Two things, both real: " +
    "(1) create the file src/p2-probe.txt containing exactly the line `probe ok`; " +
    "(2) run `node --version` and report its real exit code and stdout. " +
    "Do not create or modify anything else.",
  repo_path: repo,
  base_revision: "3f9d8af",
  allowed_paths: ["src"],
  deliverables: ["src/p2-probe.txt"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --version", expect_exit: 0 }],
  timeout_seconds: 300,
});

console.log(`[smoke] model=${model} sandbox=${sandbox}`);
console.log(`[smoke] CODEX_HOME=${home}`);

const report = await adapter.capabilityCheck();
console.log(`[smoke] capability: available=${report.available} version=${report.version}`);
console.log(`[smoke] capability detail: ${report.detail}`);

const started = Date.now();
let result;
try {
  result = await adapter.execute(envelope);
} catch (error) {
  console.error(`[smoke] execute threw: ${error?.name}: ${error?.message}`);
  process.exit(1);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`[smoke] elapsed=${elapsed}s`);
console.log(`[smoke] status=${result.status}`);
console.log(`[smoke] summary=${result.summary}`);
console.log(`[smoke] commands=${JSON.stringify(result.commands)}`);
console.log(`[smoke] tests=${JSON.stringify(result.test_results)}`);
console.log(`[smoke] unresolved=${JSON.stringify(result.unresolved_issues)}`);

const problems = validateTaskResult(envelope, result);
console.log(`[smoke] reconciliation problems=${problems.length}`);
for (const p of problems) console.log(`  - ${p}`);

// A probe is only a pass if the child actually ran the command and reported
// the real version. Anything else is a failure, including a polite summary.
const ranIt = result.commands.some(
  (c) => c.command.includes("node --version") && c.exit_code === 0 && /v\d+\.\d+\.\d+/.test(c.output_tail),
);
const wroteIt = fs.existsSync(path.join(repo, "src", "p2-probe.txt"));

if (!ranIt) {
  console.error("[smoke] FAIL: the child did not report a real `node --version` run");
  process.exit(1);
}
if (!wroteIt) {
  console.error("[smoke] FAIL: the child did not actually create src/p2-probe.txt");
  process.exit(1);
}
if (!claimIsSupported(result, envelope)) {
  console.error("[smoke] FAIL: the claim is not supported by the evidence it returned");
  process.exit(1);
}

// The probe file is the test's own artifact, not part of the repository.
fs.rmSync(path.join(repo, "src", "p2-probe.txt"), { force: true });

console.log("[smoke] PASS: child executed the command, wrote the file, and the claim is backed by evidence");
