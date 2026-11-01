/**
 * Run one plan where two different agents do two different roles.
 *
 * P33 proved Claude can complete a single task through its gateway route. What
 * it did not prove is the routing: that a plan mixing roles actually reaches
 * two different binaries, and that each task's evidence is collected from the
 * adapter that ran it.
 *
 * The fixture is a throwaway git repo with a tiny module. Task one writes it
 * (Codex). Task two reviews it and writes a report (Claude). The roles are
 * bound in the state directory, so the router has to consult them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../dist/workflow/scheduler.js";
import { Pipeline } from "../dist/workflow/pipeline.js";
import { CodexAdapter } from "../dist/workflow/adapters/codex.js";
import { ClaudeAdapter } from "../dist/workflow/adapters/claude.js";
import { detectAgents, writeBindings, readBindings, agentForRole } from "../dist/workflow/agents.js";
import { requirementsSchema, taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const log = (...args) => console.log("[drill]", ...args);

// --- fixture --------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-agents-"));
const repo = path.join(root, "repo");
const state = path.join(root, "state");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(state, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "drill@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "drill"], { cwd: repo });
fs.writeFileSync(path.join(repo, "README.md"), "# drill\n", "utf8");
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
log("repo:", repo);

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "the module exports a greeting",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "greet.js exports a function returning a string",
        kind: "automated",
        verification_command: "node -e \"const g=require('./src/greet.js');if(typeof g.greet!=='function')process.exit(1);console.log('ok')\"",
      },
    ],
  },
]);

const writeTask = taskEnvelopeSchema.parse({
  task_id: "T-WRITE",
  role: "developer",
  objective:
    "Create src/greet.js exporting a function greet(name) that returns 'hello ' + name. " +
    "Then run: node -e \"const g=require('./src/greet.js');if(typeof g.greet!=='function')process.exit(1);console.log('ok')\" " +
    "and report its exit code.",
  repo_path: repo,
  base_revision: "init",
  allowed_paths: ["src/greet.js"],
  deliverables: ["src/greet.js"],
  acceptance_ids: ["AC-1"],
  verification_commands: [
    {
      command:
        "node -e \"const g=require('./src/greet.js');if(typeof g.greet!=='function')process.exit(1);console.log('ok')\"",
      expect_exit: 0,
    },
  ],
  timeout_seconds: 600,
});

const reviewTask = taskEnvelopeSchema.parse({
  task_id: "T-REVIEW",
  role: "reviewer",
  objective:
    "Read src/greet.js and write REVIEW.md containing one line: the file's exported function name, " +
    "and whether it returns a string. Do not modify src/greet.js.",
  repo_path: repo,
  base_revision: "init",
  allowed_paths: ["REVIEW.md"],
  deliverables: ["REVIEW.md"],
  acceptance_ids: ["AC-1"],
  verification_commands: [
    { command: "node -e \"const f=require('fs');if(!f.existsSync('REVIEW.md'))process.exit(1);console.log('ok')\"", expect_exit: 0 },
  ],
  dependencies: ["T-WRITE"],
  timeout_seconds: 600,
});

// --- bindings -------------------------------------------------------------
const agents = detectAgents();
const claude = agents.find((a) => a.id === "claude");
const codex = agents.find((a) => a.id === "codex");
if (!claude?.binary || !codex?.binary) throw new Error("both agents must be installed");
if (claude.route?.kind !== "gateway") throw new Error("claude has no gateway route");

writeBindings(state, { developer: "codex", reviewer: "claude" });
const bindings = readBindings(state);
log("bindings:", JSON.stringify(bindings));
log("developer ->", agentForRole(bindings, "developer"), "| reviewer ->", agentForRole(bindings, "reviewer"));

// --- router ---------------------------------------------------------------
const used = new Map();
const calls = [];
const router = {
  id: "role-router",
  label: "role-router",
  async capabilityCheck() {
    return {
      adapter_id: "role-router",
      version: "1",
      available: true,
      models: [],
      working_directories: [repo],
      can_run_tests: true,
      can_resume: true,
      detail: "",
    };
  },
  async execute(envelope) {
    const agent = agentForRole(bindings, envelope.role);
    calls.push(`${envelope.task_id}:${agent}`);
    log(`task ${envelope.task_id} -> ${agent}`);
    const adapter = buildFor(agent);
    used.set(envelope.task_id, adapter);
    return adapter.execute(envelope);
  },
  async resume(taskId, feedback) {
    return used.get(taskId).resume(taskId, feedback);
  },
  async cancel(taskId) {
    return used.get(taskId)?.cancel(taskId);
  },
  async collectEvidence(taskId) {
    return used.get(taskId).collectEvidence(taskId);
  },
};

function buildFor(agent) {
  if (agent === "claude") {
    return new ClaudeAdapter({
      claudePath: claude.binary,
      repoPath: repo,
      model: "claude-sonnet-4-5",
      gateway: {
        baseUrl: claude.route.baseUrl,
        ...(claude.route.apiKey ? { apiKey: claude.route.apiKey } : {}),
        modelMap: claude.route.modelMap,
      },
    });
  }
  const home = path.join(state, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
    const from = path.join(os.homedir(), ".codex", file);
    const to = path.join(home, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  return new CodexAdapter({
    codexPath: codex.binary,
    codexHome: home,
    model: "deepseek-v4.1-flash-solo",
    sandbox: "bypass",
    observeWorktree: true,
  });
}

// --- run ------------------------------------------------------------------
const pipeline = new Pipeline("IMPLEMENT");
const scheduler = new Scheduler({
  adapter: router,
  requirements,
  pipeline,
  maxAttempts: 1,
  stateDir: state,
});

const started = Date.now();
const outcome = await scheduler.runPlan([writeTask, reviewTask]);
const elapsed = Math.round((Date.now() - started) / 1000);

log("completed:", JSON.stringify(outcome.completed));
log("failed:", JSON.stringify(outcome.failed.map((f) => `${f.taskId}:${f.reason}`)));
log("skipped:", JSON.stringify(outcome.skipped));
log("calls:", JSON.stringify(calls));
log("elapsed:", `${elapsed}s`);

// --- assertions -----------------------------------------------------------
const problems = [];
if (calls.length !== 2) problems.push(`expected 2 dispatches, saw ${calls.length}`);
if (calls[0] !== "T-WRITE:codex") problems.push(`first dispatch should be codex, saw ${calls[0]}`);
if (calls[1] !== "T-REVIEW:claude") problems.push(`second dispatch should be claude, saw ${calls[1]}`);
if (!fs.existsSync(path.join(repo, "src", "greet.js"))) problems.push("codex did not create src/greet.js");
if (!fs.existsSync(path.join(repo, "REVIEW.md"))) problems.push("claude did not create REVIEW.md");
if (!outcome.completed.includes("T-WRITE")) problems.push("T-WRITE did not complete");
if (!outcome.completed.includes("T-REVIEW")) problems.push("T-REVIEW did not complete");

if (problems.length) {
  log("FAILED:", problems.join("; "));
  process.exitCode = 1;
} else {
  log("PASS: two agents, two roles, both tasks completed");
}

log("kept at:", root);
