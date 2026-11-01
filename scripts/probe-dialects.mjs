/**
 * Which local gateway can speak Anthropic's message API?
 *
 * Claude Code needs a `/v1/messages` endpoint. cc-switch runs a proxy with a
 * `claude` app_type row, so it may accept that dialect even when the provider
 * behind it is OpenAI-shaped. This probes both dialects against both gateways
 * and reports the model list each one advertises.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

/** Agent2API stores its local API key in `kv`. */
function agent2apiKey() {
  try {
    const db = new DatabaseSync(path.join(os.homedir(), ".agent2api", "agent2api.db"), { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM kv").all();
    db.close();
    for (const row of rows) {
      const value = String(row.value ?? "");
      if (/api[_-]?key/i.test(String(row.key)) && value.length > 8) return value;
      if (/sk-a2a-[0-9a-f]+/.test(value)) return value.match(/sk-a2a-[0-9a-f]+/)[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const a2aKey = agent2apiKey();
console.log("agent2api key found:", a2aKey ? a2aKey.slice(0, 10) + "…" : "none");

const targets = [
  { name: "cc-switch", base: "http://127.0.0.1:15721" },
  { name: "agent2api", base: "http://127.0.0.1:3065", key: a2aKey },
];

async function post(url, headers, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 300) };
  } catch (error) {
    return { error: error.message };
  }
}

for (const target of targets) {
  console.log(`\n=== ${target.name} ===`);

  // Anthropic dialect.
  const auth = target.key ? { "x-api-key": target.key, authorization: `Bearer ${target.key}` } : { "x-api-key": "local" };
  const anthropic = await post(
    `${target.base}/v1/messages`,
    { "anthropic-version": "2023-06-01", ...auth },
    { model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  );
  console.log("/v1/messages:", anthropic.status ?? anthropic.error);
  if (anthropic.body) console.log("  " + anthropic.body.replace(/\s+/g, " ").slice(0, 200));

  // OpenAI dialect.
  const openai = await post(
    `${target.base}/v1/chat/completions`,
    target.key ? { authorization: `Bearer ${target.key}` } : { authorization: "Bearer local" },
    { model: "auto", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
  );
  console.log("/v1/chat/completions:", openai.status ?? openai.error);
  if (openai.body) console.log("  " + openai.body.replace(/\s+/g, " ").slice(0, 200));
}
