import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startClaudeProxy, stripContextSuffix } from "../src/workflow/claude-proxy.js";

/**
 * The proxy exists for one reason: Claude Code appends `[1m]` to model names it
 * does not recognise, and this machine's gateway rejects that suffix even though
 * the bare name works. The tests pin the rewrite and prove the request reaches
 * the upstream with the corrected model.
 */

test("the context suffix is removed and nothing else is touched", () => {
  assert.equal(stripContextSuffix("Deepseek-V4-Pro (3.60x)[1m]"), "Deepseek-V4-Pro (3.60x)");
  assert.equal(stripContextSuffix("Deepseek-V4-Pro (3.60x)"), "Deepseek-V4-Pro (3.60x)");
  assert.equal(stripContextSuffix("claude-sonnet-4-20250514"), "claude-sonnet-4-20250514");
  // Only a trailing suffix is a suffix.
  assert.equal(stripContextSuffix("[1m]gpt-4"), "[1m]gpt-4");
});

test("the proxy forwards the request with the suffix stripped", async () => {
  let received: { model?: string; body: string } | undefined;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      received = { model: (JSON.parse(body) as { model?: string }).model, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const proxy = await startClaudeProxy(`http://127.0.0.1:${port}/v1`);
  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Deepseek-V4-Pro (3.60x)[1m]",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(received?.model, "Deepseek-V4-Pro (3.60x)", "the upstream must see the bare name");
    assert.equal(proxy.rewritten(), 1);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("a request without the suffix is forwarded unchanged", async () => {
  let model: string | undefined;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      model = (JSON.parse(body) as { model?: string }).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const proxy = await startClaudeProxy(`http://127.0.0.1:${port}/v1`);
  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [] }),
    });
    // The upstream handler runs before the response resolves, so reading the
    // body guarantees `model` was recorded.
    await response.text();
    assert.equal(model, "claude-sonnet-4-20250514");
    assert.equal(proxy.rewritten(), 0, "nothing was rewritten");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("a non-messages path is refused rather than proxied", async () => {
  const proxy = await startClaudeProxy("http://127.0.0.1:9/v1");
  try {
    const response = await fetch(`${proxy.baseUrl}/other`);
    assert.equal(response.status, 404);
  } finally {
    await proxy.close();
  }
});
