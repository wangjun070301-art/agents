/**
 * Run the Claude adapter end to end through its gateway route.
 *
 * This is the check that matters: not "the binary exists" but "a task comes
 * back as a protocol-valid result". It uses a throwaway repo and a trivial
 * task, so nothing on disk is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../dist/workflow/adapters/claude.js";
import { detectAgents } from "../dist/workflow/agents.js";
import { taskEnvelopeSchema } from "../dist/workflow/contracts.js";

const claude = detectAgents().find((a) => a.id === "claude");
if (!claude?.binary) throw new Error("claude not found");
if (claude.route?.kind !== "gateway") throw new Error("claude has no gateway route");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-task-"));
fs.writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-CLAUDE",
  role: "developer",
  objective: "Read a.txt and report its contents in the summary. Do not modify any file.",
  repo_path: repo,
  base_revision: "init",
  allowed_paths: [],
  deliverables: ["(none)"],
  acceptance_ids: ["AC-1"],
  timeout_seconds: 300,
});

const adapter = new ClaudeAdapter({
  claudePath: claude.binary,
  repoPath: repo,
  model: "claude-sonnet-4-5",
  gateway: {
    baseUrl: claude.route.baseUrl,
    ...(claude.route.apiKey ? { apiKey: claude.route.apiKey } : {}),
    modelMap: claude.route.modelMap,
  },
});

const capability = await adapter.capabilityCheck();
console.log("capability:", capability.available, capability.detail);

try {
  const result = await adapter.execute(envelope);
  console.log("status:", result.status);
  console.log("summary:", String(result.summary).slice(0, 200));
} catch (error) {
  console.log("FAILED:", error.message.slice(0, 400));
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
