/**
 * Ask each local agent gateway what it offers.
 *
 * Three are running on this machine: cc-switch (15721), Agent2API (3065) and
 * DeepSeek Harness (9230). Each may speak a different dialect. This script
 * probes the shapes that matter: /v1/models for the OpenAI-compatible ones,
 * /v1/messages for the Anthropic one, and the harness RPC for the third.
 */
const targets = [
  { name: "cc-switch", base: "http://127.0.0.1:15721" },
  { name: "agent2api", base: "http://127.0.0.1:3065" },
  { name: "harness", base: "http://127.0.0.1:9230" },
];

async function tryFetch(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type"), body: text.slice(0, 400) };
  } catch (error) {
    return { error: error.message };
  }
}

for (const target of targets) {
  console.log(`\n=== ${target.name} ${target.base} ===`);
  for (const path of ["/v1/models", "/models", "/health", "/api/health"]) {
    const r = await tryFetch(`${target.base}${path}`);
    if (r.error) {
      console.log(`${path}: ${r.error}`);
    } else {
      console.log(`${path}: ${r.status} ${r.type ?? ""}`);
      console.log("   " + (r.body ?? "").replace(/\s+/g, " ").slice(0, 220));
    }
  }
}
