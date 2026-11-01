/**
 * Does a shared CODEX_HOME break a second Codex task?
 *
 * In the long-plan drill two Codex tasks ran in sequence and the second
 * returned `partial` with no files. Both used one codex-home. This runs the
 * same two tasks, once with a shared home and once with one home per task, and
 * compares.
 *
 * The suspicion is that Codex keeps session state in CODEX_HOME and a second
 * run reuses a session id, so the second child has nothing to resume.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import { detectAgents } from "../dist/workflow/agents.js";
import { taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const log = (...args) => console.log("[home]", ...args);

const codex = detectAgents().find((a) => a.id === "codex");
if (!codex?.binary) throw new Error("codex not installed");

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `home-${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# probe\n", "utf8");
  return dir;
}

function seedHome(home) {
  fs.mkdirSync(home, { recursive: true });
  for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
    const from = path.join(os.homedir(), ".codex", file);
    const to = path.join(home, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

function taskFor(id, repo, file, fn) {
  const verify = `node -e "const m=require('./src/${file}');if(typeof m.${fn}!=='function')process.exit(1);console.log('ok')"`;
  return taskEnvelopeSchema.parse({
    task_id: id,
    role: "developer",
    objective: `Create src/${file} exporting ${fn}. Run ${verify} and report the exit code.`,
    repo_path: repo,
    base_revision: "init",
    allowed_paths: [`src/${file}`],
    deliverables: [`src/${file}`],
    acceptance_ids: ["AC-1"],
    verification_commands: [{ command: verify, expect_exit: 0 }],
    timeout_seconds: 600,
  });
}

async function runPair(label, sharedHome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `home-${label}-`));
  const repoA = makeRepo(`${label}-a`);
  const repoB = makeRepo(`${label}-b`);

  const homeA = sharedHome ? path.join(root, "home") : path.join(root, "home-a");
  const homeB = sharedHome ? path.join(root, "home") : path.join(root, "home-b");
  seedHome(homeA);
  seedHome(homeB);

  const results = [];
  for (const [id, repo, home, file, fn] of [
    ["T-A", repoA, homeA, "add.js", "add"],
    ["T-B", repoB, homeB, "mul.js", "mul"],
  ]) {
    const adapter = new CodexAdapter({
      codexPath: codex.binary,
      codexHome: home,
      model: "deepseek-v4.1-flash-solo",
      sandbox: "bypass",
      observeWorktree: true,
    });
    const started = Date.now();
    let status = "error";
    let summary = "";
    try {
      const result = await adapter.execute(taskFor(id, repo, file, fn));
      status = result.status;
      summary = String(result.summary).slice(0, 80);
    } catch (error) {
      summary = String(error?.message ?? error).slice(0, 120);
    }
    const wrote = fs.existsSync(path.join(repo, "src", file));
    results.push({ id, status, wrote, seconds: Math.round((Date.now() - started) / 1000) });
    log(`${label} ${id}: ${status} wrote=${wrote} ${Math.round((Date.now() - started) / 1000)}s ${summary}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
  return results;
}

const shared = await runPair("shared", true);
const separate = await runPair("separate", false);

const sharedOk = shared.every((r) => r.status === "succeeded" && r.wrote);
const separateOk = separate.every((r) => r.status === "succeeded" && r.wrote);

log("");
log(`shared home:   ${sharedOk ? "both ok" : "BROKEN"}`);
log(`separate homes: ${separateOk ? "both ok" : "BROKEN"}`);

if (sharedOk) {
  log("NOTE: shared home worked; the drill failure had another cause");
} else if (separateOk) {
  log("CONFIRMED: a shared CODEX_HOME breaks the second task; use one home per task");
} else {
  log("INCONCLUSIVE: both arrangements failed");
  process.exitCode = 1;
}
