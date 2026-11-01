/**
 * Call Agent2API with the key cc-switch stored, in both dialects.
 *
 * The point is to find out whether Agent2API can stand in for Claude Code:
 * Claude needs `/v1/messages`, and Agent2API is primarily an OpenAI-shaped
 * gateway. If it answers the Anthropic shape, Claude Code can run here.
 */
const base = "http://127.0.0.1:3065";
/**
 * Keys are read from cc-switch's database rather than written here. A
 * credential in a committed script is a credential leaked.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

function keys() {
  try {
    const db = new DatabaseSync(path.join(os.homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
    const found = new Set();
    for (const row of db.prepare("SELECT settings_config FROM providers").all()) {
      const match = String(row.settings_config ?? "").match(/sk-a2a-[0-9a-f]{8,}/);
      if (match) found.add(match[0]);
    }
    db.close();
    return [...found];
  } catch {
    return [];
  }
}

async function call(path, headers, body) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 260).replace(/\s+/g, " ") };
  } catch (error) {
    return { error: error.message };
  }
}

for (const key of keys()) {
  console.log(`\n=== key ${key.slice(0, 12)}… ===`);

  const models = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json()).catch(() => undefined);
  if (models?.data) {
    console.log("models:", models.data.map((m) => m.id).slice(0, 8).join(", "));
  }

  const openai = await call(
    "/v1/chat/completions",
    { authorization: `Bearer ${key}` },
    { model: "auto", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] },
  );
  console.log("chat/completions:", openai.status ?? openai.error, (openai.body ?? "").slice(0, 120));

  const anthropic = await call(
    "/v1/messages",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    { model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] },
  );
  console.log("messages:", anthropic.status ?? anthropic.error, (anthropic.body ?? "").slice(0, 120));
}
