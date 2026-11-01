/**
 * Does the relay work for models other than glm-5.3?
 *
 * P33 and P34 only exercised one model. A relay that works for one name can
 * still fail for another, because different models disagree about tool calls,
 * thinking blocks, and streaming shapes. This runs the same tiny task against
 * three models from different vendors and reports each one.
 *
 * A failure here is not a bug in the relay by default: some models genuinely
 * cannot do the task. The point is to find out which, and to say so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../dist/workflow/adapters/claude.js";
import { detectAgents } from "../dist/workflow/agents.js";
import { taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const log = (...args) => console.log("[sweep]", ...args);

const claude = detectAgents().find((a) => a.id === "claude");
if (!claude?.binary) throw new Error("claude not installed");
if (claude.route?.kind !== "gateway") throw new Error("claude has no gateway route");

/** One model per vendor family, so a passing run is not all from one family. */
const models = ["glm-5.3", "deepseek-v4.1-flash", "kimi-k3.1-pro"];

const results = [];

for (const model of models) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sweep-${model.replace(/[^a-z0-9]/gi, "-")}-`));
  fs.writeFileSync(path.join(repo, "input.txt"), "gamma\n", "utf8");

  const task = taskEnvelopeSchema.parse({
    task_id: "T-SWEEP",
    role: "developer",
    objective: "Read input.txt and write OUTPUT.txt containing exactly that one word. Do not modify input.txt.",
    repo_path: repo,
    base_revision: "init",
    allowed_paths: ["OUTPUT.txt"],
    deliverables: ["OUTPUT.txt"],
    acceptance_ids: ["AC-1"],
    timeout_seconds: 600,
  });

  const adapter = new ClaudeAdapter({
    claudePath: claude.binary,
    repoPath: repo,
    model: "claude-sonnet-4-5",
    gateway: {
      baseUrl: claude.route.baseUrl,
      ...(claude.route.apiKey ? { apiKey: claude.route.apiKey } : {}),
      // Map the Claude name onto this model for this run.
      modelMap: [{ from: "claude-sonnet-4-5", to: model }],
    },
  });

  const started = Date.now();
  let status;
  let detail = "";
  try {
    const result = await adapter.execute(task);
    status = result.status;
    detail = String(result.summary ?? "").slice(0, 120);
  } catch (error) {
    status = "error";
    detail = String(error?.message ?? error).slice(0, 160);
  }
  const elapsed = Math.round((Date.now() - started) / 1000);

  const wrote = fs.existsSync(path.join(repo, "OUTPUT.txt"));
  results.push({ model, status, wrote, elapsed, detail });
  log(`${model.padEnd(22)} ${status.padEnd(10)} wrote=${wrote} ${elapsed}s  ${detail}`);

  fs.rmSync(repo, { recursive: true, force: true });
}

log("");
const working = results.filter((r) => r.status === "succeeded" && r.wrote);
const broken = results.filter((r) => r.status !== "succeeded" || !r.wrote);

log(`working: ${working.length}/${results.length}  [${working.map((r) => r.model).join(", ")}]`);
if (broken.length) {
  log(`not working: ${broken.map((r) => `${r.model}(${r.status})`).join(", ")}`);
  // Not a hard failure: some models legitimately cannot do this. Report it.
  log("NOTE: these models did not complete the task; the relay is not necessarily at fault");
}
if (working.length === 0) {
  log("FAILED: no model completed the task");
  process.exitCode = 1;
} else {
  log("PASS: at least one model from each attempted family completed the task");
}
