/**
 * Try Claude Code through the suffix-stripping proxy.
 *
 * The gateway rejects `[1m]`, which Claude Code appends to unrecognised model
 * names. This script starts the proxy, points Claude at it, and runs one
 * throwaway prompt so the whole path is exercised before the panel uses it.
 *
 *   node scripts/try-claude.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startClaudeProxy } from "../dist/workflow/claude-proxy.js";

const settings = path.join(os.homedir(), ".claude", "settings.json");
const env = JSON.parse(fs.readFileSync(settings, "utf8")).env ?? {};
const upstream = env.ANTHROPIC_BASE_URL ?? "https://open-ai.baomiao.cn/v1";
const model = env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "Deepseek-V4-Pro (3.60x)";

const claude = process.env.CLAUDE_BIN ??
  "D:\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

const proxy = await startClaudeProxy(upstream);
console.log(`[proxy] ${proxy.baseUrl} -> ${upstream}`);
console.log(`[model] ${model}`);

try {
  // Claude Code merges its own settings.json over the environment, so the base
  // URL has to arrive as an explicit settings document instead.
  const override = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: proxy.baseUrl,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    },
  });
  const child = spawn(claude, [
    "-p", "reply with exactly OK",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--settings", override,
  ], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxy.baseUrl,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    },
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (out += String(chunk)));
  await new Promise((resolve) => child.on("close", resolve));
  console.log(`[rewritten] ${proxy.rewritten()}`);
  console.log(out.slice(0, 800));
} finally {
  await proxy.close();
}
