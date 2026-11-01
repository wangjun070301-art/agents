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

/**
 * Claude Code appends `/v1` to the base URL it was given, so a base URL that
 * already ends in `/v1` produces `/v1/v1/messages`. The proxy must collapse
 * that, or every request 404s upstream.
 */
test("a doubled /v1 prefix is collapsed before forwarding", async () => {
  let seenPath: string | undefined;
  const upstream = http.createServer((req, res) => {
    seenPath = req.url;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const proxy = await startClaudeProxy(`http://127.0.0.1:${port}/v1`);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    await response.text();
    assert.equal(seenPath, "/v1/messages", `upstream saw ${seenPath}`);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

/**
 * The relay exists to let Claude Code keep a name it accepts while the gateway
 * receives one it serves, and to map the response name back so Claude does not
 * reject the answer.
 */
test("a model mapping rewrites the request and restores the response name", async () => {
  let forwardedModel: string | undefined;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      forwardedModel = (JSON.parse(body) as { model: string }).model;
      // Answer in Anthropic's streaming shape, which is what Claude Code reads.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: {"type":"message_start","message":{"model":"${forwardedModel}"}}\n\n`,
      );
      res.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const proxy = await startClaudeProxy(`http://127.0.0.1:${port}/v1`, [
    { from: "claude-sonnet-4-5", to: "glm-5.3" },
  ]);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
    });
    const text = await response.text();
    assert.equal(forwardedModel, "glm-5.3", "the gateway must receive its own model name");
    assert.match(text, /"model":"claude-sonnet-4-5"/, "the response must carry the name Claude asked for");
    assert.equal(proxy.rewritten(), 1);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

/**
 * The 1m-context beta is what makes Claude Code demand a `[1m]` model name.
 * This gateway has no such models, so the beta is dropped on the way through.
 */
test("the 1m-context beta is removed from the forwarded headers", async () => {
  let beta: string | undefined;
  const upstream = http.createServer((req, res) => {
    beta = req.headers["anthropic-beta"] as string | undefined;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const proxy = await startClaudeProxy(`http://127.0.0.1:${port}/v1`);
  try {
    await fetch(`${proxy.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    }).then((r) => r.text());
    assert.equal(beta, "claude-code-20250219,interleaved-thinking", "only the 1m beta is dropped");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
