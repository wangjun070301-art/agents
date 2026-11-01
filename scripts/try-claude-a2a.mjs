/**
 * Run Claude Code against Agent2API.
 *
 * Agent2API answers `/v1/messages` in Anthropic's shape, but it does not know
 * names like `claude-sonnet-4-5`. Claude Code rejects unknown names locally,
 * so the fix is to tell Claude Code the name Agent2API does know. The model
 * alias env vars do that: `ANTHROPIC_DEFAULT_SONNET_MODEL` is what Claude
 * actually sends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startClaudeProxy } from "../dist/workflow/claude-proxy.js";

/** The key cc-switch already stores for Agent2API. */
function findKey() {
  const db = new DatabaseSync(path.join(os.homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
  for (const row of db.prepare("SELECT settings_config FROM providers").all()) {
    const match = String(row.settings_config ?? "").match(/sk-a2a-[0-9a-f]{8,}/);
    if (match) {
      db.close();
      return match[0];
    }
  }
  db.close();
  return undefined;
}

const key = findKey();
if (!key) throw new Error("no Agent2API key found in cc-switch");

const model = process.env.A2A_MODEL ?? "glm-5.3";
const claude = process.env.CLAUDE_BIN ??
  "D:\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

const proxy = await startClaudeProxy("http://127.0.0.1:3065/v1");
console.log(`[proxy] ${proxy.baseUrl} -> http://127.0.0.1:3065/v1`);

const settings = JSON.stringify({
  env: {
    // Claude Code appends `[1m]` to names it does not recognise, and Agent2API
    // rejects that suffix. The proxy strips it in flight.
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  },
});

console.log(`[claude] model=${model} base=http://127.0.0.1:3065/v1`);

const child = spawn(
  claude,
  ["-p", "reply with exactly OK", "--output-format", "json", "--dangerously-skip-permissions", "--settings", settings],
  // stdin must stay open: Claude Code prints a warning and proceeds without it,
  // but on Windows an ignored stdin can make it exit before writing output.
  { cwd: os.tmpdir(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
);
child.stdin.end();

let out = "";
child.stdout.on("data", (chunk) => (out += String(chunk)));
child.stderr.on("data", (chunk) => (out += String(chunk)));
await new Promise((resolve) => child.on("close", resolve));

const envelope = out.match(/\{[\s\S]*"type":"result"[\s\S]*\}/);
if (envelope) {
  try {
    const parsed = JSON.parse(envelope[0]);
    console.log(`[result] is_error=${parsed.is_error} status=${parsed.api_error_status ?? "-"} rewritten=${proxy.rewritten()}`);
    console.log(`[text] ${String(parsed.result ?? "").slice(0, 200)}`);
  } catch {
    console.log(out.slice(0, 600));
  }
} else {
  console.log(out.slice(0, 600));
}

await proxy.close();
