/**
 * Two Claude tasks at the same time.
 *
 * Each Claude run starts its own relay on an ephemeral port, so the question
 * is whether two relays can coexist and whether each run gets its own. This
 * runs two independent Claude tasks in parallel, against separate repos, and
 * checks that both complete and that neither is served by the other's relay.
 *
 * The scheduler runs one task at a time by design, so this exercises the
 * adapter directly: the concurrency the panel can actually reach is a single
 * plan, but the adapter is the unit that must be safe when two exist.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../dist/workflow/adapters/claude.js";
import { detectAgents } from "../dist/workflow/agents.js";
import { taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const log = (...args) => console.log("[concur]", ...args);

const claude = detectAgents().find((a) => a.id === "claude");
if (!claude?.binary) throw new Error("claude not installed");
if (claude.route?.kind !== "gateway") throw new Error("claude has no gateway route");

/** One repo per task, so neither task can see the other's work. */
function makeRepo(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `concur-${name}-`));
  fs.writeFileSync(path.join(dir, "input.txt"), content, "utf8");
  return dir;
}

const repos = {
  A: makeRepo("a", "alpha\n"),
  B: makeRepo("b", "beta\n"),
};

function taskFor(id, repo) {
  return taskEnvelopeSchema.parse({
    task_id: id,
    role: "developer",
    objective: "Read input.txt and write OUTPUT.txt containing exactly that one word, lowercased. Do not modify input.txt.",
    repo_path: repo,
    base_revision: "init",
    allowed_paths: ["OUTPUT.txt"],
    deliverables: ["OUTPUT.txt"],
    acceptance_ids: ["AC-1"],
    timeout_seconds: 600,
  });
}

function adapterFor(repo) {
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

const started = Date.now();

/**
 * Run both at once. Each adapter starts its own relay inside execute(), so this
 * is the case where two ephemeral ports exist simultaneously.
 */
const results = await Promise.allSettled([
  adapterFor(repos.A).execute(taskFor("T-A", repos.A)),
  adapterFor(repos.B).execute(taskFor("T-B", repos.B)),
]);

const elapsed = Math.round((Date.now() - started) / 1000);

const problems = [];
for (const [index, settled] of results.entries()) {
  const name = index === 0 ? "T-A" : "T-B";
  if (settled.status === "rejected") {
    problems.push(`${name} failed: ${String(settled.reason?.message ?? settled.reason).slice(0, 160)}`);
    continue;
  }
  const result = settled.value;
  log(`${name}: ${result.status} — ${String(result.summary).slice(0, 90)}`);
  if (result.status !== "succeeded") problems.push(`${name} reported ${result.status}`);
}

/** Each task must have produced its own file with its own word. */
const expected = { A: "alpha", B: "beta" };
for (const [key, repo] of Object.entries(repos)) {
  const file = path.join(repo, "OUTPUT.txt");
  if (!fs.existsSync(file)) {
    problems.push(`${key}: no OUTPUT.txt`);
    continue;
  }
  const written = fs.readFileSync(file, "utf8").trim().toLowerCase();
  if (!written.includes(expected[key])) {
    problems.push(`${key}: expected ${expected[key]}, found "${written.slice(0, 40)}"`);
  }
}

/** Cross-contamination check: task A's repo must not contain beta, or vice versa. */
const a = fs.readFileSync(path.join(repos.A, "OUTPUT.txt"), "utf8").toLowerCase();
const b = fs.readFileSync(path.join(repos.B, "OUTPUT.txt"), "utf8").toLowerCase();
if (a.includes("beta")) problems.push("task A's output contains task B's word");
if (b.includes("alpha")) problems.push("task B's output contains task A's word");

log("elapsed:", `${elapsed}s`);

if (problems.length) {
  log("FAILED:", problems.join("; "));
  process.exitCode = 1;
} else {
  log("PASS: two Claude runs in parallel, separate relays, no cross-contamination");
}

for (const repo of Object.values(repos)) {
  log("kept at:", repo);
}
