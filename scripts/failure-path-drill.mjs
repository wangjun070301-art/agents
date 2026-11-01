/**
 * What happens when the second agent fails.
 *
 * P34 only proved the sunny case: two agents, two roles, both succeed. The
 * interesting question is what the pipeline does when the reviewer agent
 * cannot run. Three things must hold:
 *
 *   1. The failed task is reported as failed, with the real reason.
 *   2. The upstream agent's work is not touched or rolled back by the failure.
 *   3. A task that depends on the failed one is skipped, not run on stale work.
 *
 * The failure is produced honestly: the Claude adapter is given a gateway
 * route pointing at a port nothing listens on. That is a real spawn and a real
 * connection error, not a stub that throws.
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

const log = (...args) => console.log("[fail]", ...args);

// --- fixture --------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fail-path-"));
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

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "the module exists",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "greet.js exports a function",
        kind: "automated",
        verification_command:
          "node -e \"const g=require('./src/greet.js');if(typeof g.greet!=='function')process.exit(1);console.log('ok')\"",
      },
    ],
  },
]);

const writeTask = taskEnvelopeSchema.parse({
  task_id: "T-WRITE",
  role: "developer",
  objective:
    "Create src/greet.js exporting greet(name) returning 'hello ' + name. " +
    "Run node -e \"const g=require('./src/greet.js');if(typeof g.greet!=='function')process.exit(1);console.log('ok')\" and report the exit code.",
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
  objective: "Read src/greet.js and write REVIEW.md with one line naming its exported function.",
  repo_path: repo,
  base_revision: "init",
  allowed_paths: ["REVIEW.md"],
  deliverables: ["REVIEW.md"],
  acceptance_ids: ["AC-1"],
  verification_commands: [
    {
      command: "node -e \"const f=require('fs');if(!f.existsSync('REVIEW.md'))process.exit(1);console.log('ok')\"",
      expect_exit: 0,
    },
  ],
  dependencies: ["T-WRITE"],
  timeout_seconds: 600,
});

// A task downstream of the review. It must be skipped when the review fails.
const publishTask = taskEnvelopeSchema.parse({
  task_id: "T-PUBLISH",
  role: "integrator",
  objective: "Append a line to REVIEW.md.",
  repo_path: repo,
  base_revision: "init",
  allowed_paths: ["REVIEW.md"],
  deliverables: ["REVIEW.md"],
  acceptance_ids: ["AC-1"],
  dependencies: ["T-REVIEW"],
  timeout_seconds: 600,
});

// --- bindings -------------------------------------------------------------
const agents = detectAgents();
const claude = agents.find((a) => a.id === "claude");
const codex = agents.find((a) => a.id === "codex");
if (!claude?.binary || !codex?.binary) throw new Error("both agents must be installed");

writeBindings(state, { developer: "codex", reviewer: "claude", integrator: "codex" });
const bindings = readBindings(state);
log("bindings:", JSON.stringify(bindings));

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
      /**
       * A gateway on a dead port. The adapter spawns Claude for real and the
       * relay fails to connect, which is the honest version of "the reviewer
       * could not reach a model".
       */
      gateway: {
        baseUrl: "http://127.0.0.1:9/v1",
        modelMap: [{ from: "claude-sonnet-4-5", to: "nothing-serves-this" }],
      },
      timeoutMs: 120_000,
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
const outcome = await scheduler.runPlan([writeTask, reviewTask, publishTask]);
const elapsed = Math.round((Date.now() - started) / 1000);

log("completed:", JSON.stringify(outcome.completed));
log("failed:", JSON.stringify(outcome.failed.map((f) => `${f.taskId}:${f.reason}:${f.detail.slice(0, 120)}`)));
log("skipped:", JSON.stringify(outcome.skipped));
log("calls:", JSON.stringify(calls));
log("elapsed:", `${elapsed}s`);

// --- assertions -----------------------------------------------------------
const problems = [];
const greetPath = path.join(repo, "src", "greet.js");
const reviewPath = path.join(repo, "REVIEW.md");

if (!outcome.completed.includes("T-WRITE")) problems.push("T-WRITE should have completed before the failure");
if (!fs.existsSync(greetPath)) problems.push("Codex's output was lost when the reviewer failed");

if (outcome.failed.length !== 1) problems.push(`expected exactly one failure, saw ${outcome.failed.length}`);
if (outcome.failed[0]?.taskId !== "T-REVIEW") problems.push(`expected T-REVIEW to fail, saw ${outcome.failed[0]?.taskId}`);
if (!/adapter-error/.test(outcome.failed[0]?.reason ?? "")) {
  problems.push(`failure reason should be adapter-error, saw ${outcome.failed[0]?.reason}`);
}

if (!outcome.skipped.some((s) => s.taskId === "T-PUBLISH")) {
  problems.push("T-PUBLISH should be skipped when its dependency failed");
}
const publishSkip = outcome.skipped.find((s) => s.taskId === "T-PUBLISH");
if (publishSkip && !/T-REVIEW/.test(publishSkip.because)) {
  problems.push(`skip reason should name T-REVIEW, saw ${publishSkip.because}`);
}

if (calls.includes("T-PUBLISH:codex")) problems.push("T-PUBLISH must not be dispatched after a failed dependency");
if (fs.existsSync(reviewPath)) problems.push("a failed reviewer left a REVIEW.md behind");
if (pipeline.isBlocked) problems.push("a non-retryable failure must not block the pipeline");

if (problems.length) {
  log("FAILED:", problems.join("; "));
  process.exitCode = 1;
} else {
  log("PASS: upstream work survived, downstream skipped, failure reported honestly");
}

log("kept at:", root);
