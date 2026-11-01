/**
 * A longer plan with three roles and real dependencies.
 *
 * P34 proved two tasks with two agents. The open question is whether a plan
 * that fans out and joins still routes correctly: several tasks at the same
 * level, each bound to a different role, then a task that depends on all of
 * them.
 *
 * Shape:
 *
 *   T-IMPL-A  (developer / codex)  ─┐
 *   T-IMPL-B  (developer / codex)  ─┼─► T-REVIEW (reviewer / claude) ─► T-SIGN (integrator / codex)
 *   T-TEST    (tester   / claude)  ─┘
 *
 * The join task can only start after all three branches finish, so a routing
 * bug in any branch shows up as a missing dependency rather than as a wrong
 * result.
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

const log = (...args) => console.log("[long]", ...args);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "long-plan-"));
const repo = path.join(root, "repo");
const state = path.join(root, "state");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(state, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "drill@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "drill"], { cwd: repo });
fs.writeFileSync(path.join(repo, "README.md"), "# long plan\n", "utf8");
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

const requirements = requirementsSchema.parse([
  {
    req_id: "REQ-1",
    statement: "two modules exist and are signed off",
    acceptance: [
      {
        ac_id: "AC-1",
        requirement_id: "REQ-1",
        description: "add.js exports add",
        kind: "automated",
        verification_command: "node -e \"const a=require('./src/add.js');if(typeof a.add!=='function')process.exit(1);console.log('ok')\"",
      },
    ],
  },
]);

const base = { repo_path: repo, base_revision: "init", acceptance_ids: ["AC-1"], timeout_seconds: 600 };

const implA = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-IMPL-A",
  role: "developer",
  objective:
    "Create src/add.js exporting add(a,b) returning a+b. " +
    "Run node -e \"const a=require('./src/add.js');if(typeof a.add!=='function')process.exit(1);console.log('ok')\" and report the exit code.",
  allowed_paths: ["src/add.js"],
  deliverables: ["src/add.js"],
  verification_commands: [
    { command: "node -e \"const a=require('./src/add.js');if(typeof a.add!=='function')process.exit(1);console.log('ok')\"", expect_exit: 0 },
  ],
});

const implB = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-IMPL-B",
  role: "developer",
  objective:
    "Create src/mul.js exporting mul(a,b) returning a*b. " +
    "Run node -e \"const m=require('./src/mul.js');if(typeof m.mul!=='function')process.exit(1);console.log('ok')\" and report the exit code.",
  allowed_paths: ["src/mul.js"],
  deliverables: ["src/mul.js"],
  verification_commands: [
    { command: "node -e \"const m=require('./src/mul.js');if(typeof m.mul!=='function')process.exit(1);console.log('ok')\"", expect_exit: 0 },
  ],
});

const testTask = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-TEST",
  role: "tester",
  objective:
    "Write TESTING.md containing one line per module: the file name and whether its exported function exists. " +
    "Read src/add.js and src/mul.js first. Do not modify the modules.",
  allowed_paths: ["TESTING.md"],
  deliverables: ["TESTING.md"],
  dependencies: ["T-IMPL-A", "T-IMPL-B"],
});

const reviewTask = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-REVIEW",
  role: "reviewer",
  objective:
    "Read src/add.js, src/mul.js and TESTING.md. Write REVIEW.md with one line: whether both modules export a function and whether TESTING.md covers both. " +
    "Do not modify any file except REVIEW.md.",
  allowed_paths: ["REVIEW.md"],
  deliverables: ["REVIEW.md"],
  dependencies: ["T-TEST"],
});

const signTask = taskEnvelopeSchema.parse({
  ...base,
  task_id: "T-SIGN",
  role: "integrator",
  objective:
    "Read REVIEW.md and append one final line to it: 'signed: <the word PASS or FAIL as written in REVIEW.md>'. " +
    "If REVIEW.md does not state a verdict, append 'signed: UNKNOWN'. Do not touch other files.",
  allowed_paths: ["REVIEW.md"],
  deliverables: ["REVIEW.md"],
  dependencies: ["T-REVIEW"],
});

const agents = detectAgents();
const claude = agents.find((a) => a.id === "claude");
const codex = agents.find((a) => a.id === "codex");
if (!claude?.binary || !codex?.binary) throw new Error("both agents must be installed");
if (claude.route?.kind !== "gateway") throw new Error("claude has no gateway route");

writeBindings(state, { developer: "codex", tester: "claude", reviewer: "claude", integrator: "codex" });
const bindings = readBindings(state);
log("bindings:", JSON.stringify(bindings));

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
    log(`task ${envelope.task_id} (${envelope.role}) -> ${agent}`);
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

const pipeline = new Pipeline("IMPLEMENT");
const scheduler = new Scheduler({
  adapter: router,
  requirements,
  pipeline,
  maxAttempts: 1,
  stateDir: state,
});

const started = Date.now();
const outcome = await scheduler.runPlan([implA, implB, testTask, reviewTask, signTask]);
const elapsed = Math.round((Date.now() - started) / 1000);

log("completed:", JSON.stringify(outcome.completed));
log("failed:", JSON.stringify(outcome.failed.map((f) => `${f.taskId}:${f.reason}`)));
log("skipped:", JSON.stringify(outcome.skipped));
log("calls:", JSON.stringify(calls));
log("elapsed:", `${elapsed}s`);

const problems = [];
const files = ["src/add.js", "src/mul.js", "TESTING.md", "REVIEW.md"];
for (const file of files) {
  if (!fs.existsSync(path.join(repo, file))) problems.push(`${file} missing`);
}
if (outcome.completed.length !== 5) problems.push(`expected 5 completions, saw ${outcome.completed.length}`);
if (outcome.failed.length !== 0) problems.push(`expected no failures, saw ${outcome.failed.length}`);
if (calls.length !== 5) problems.push(`expected 5 dispatches, saw ${calls.length}`);

// The join task must run last, and the branches in dependency order.
const testIndex = calls.findIndex((c) => c.startsWith("T-TEST"));
const reviewIndex = calls.findIndex((c) => c.startsWith("T-REVIEW"));
const signIndex = calls.findIndex((c) => c.startsWith("T-SIGN"));
if (testIndex < 0 || reviewIndex < 0 || signIndex < 0) problems.push("one of the chain tasks never ran");
if (!(testIndex < reviewIndex && reviewIndex < signIndex)) problems.push("chain order is wrong");

if (fs.existsSync(path.join(repo, "REVIEW.md"))) {
  const review = fs.readFileSync(path.join(repo, "REVIEW.md"), "utf8");
  if (!/signed:/i.test(review)) problems.push("integrator did not append a signed line");
}

if (problems.length) {
  log("FAILED:", problems.join("; "));
  process.exitCode = 1;
} else {
  log("PASS: five tasks, three roles, fan-out and join all routed correctly");
}
log("kept at:", root);
