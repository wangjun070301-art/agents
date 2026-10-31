#!/usr/bin/env node
/**
 * Model-name shim for Claude Code behind an OpenAI-compatible gateway.
 *
 * Why this exists: some gateways key models by ids that contain spaces and
 * parentheses, e.g. `DeepSeek-V4.1-Flash 1017(1.20x)`. Claude Code strips
 * non-alphanumerics from the model string before sending it, so the upstream
 * receives `DeepSeek-V4.1-Flash10171.20x` and answers 503. This proxy accepts
 * the mangled form and restores the exact id before forwarding.
 *
 * It is a pure passthrough otherwise: request body is forwarded with only the
 * model field rewritten, and the response is streamed back byte for byte.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const upstream = process.env.SHIM_UPSTREAM;
const token = process.env.SHIM_TOKEN;
const port = Number(process.env.SHIM_PORT ?? 18777);
const host = process.env.SHIM_HOST ?? "127.0.0.1";
/** Optional explicit map: {"clean-id": "real-upstream-id"}. */
const explicitMap = (() => {
  try {
    return JSON.parse(process.env.SHIM_MAP ?? "{}");
  } catch {
    console.error("[shim] SHIM_MAP is not valid JSON; ignoring it");
    return {};
  }
})();

/**
 * Claude Code asks for Anthropic-shaped ids. The gateway only knows its own
 * catalog names. Without an explicit map, bind the three well-known aliases to
 * the best matching catalog entry so a bare shim still works.
 */
function deriveAliasMap(ids) {
  const pick = (pattern) => ids.find((id) => pattern.test(id));
  const fast = pick(/V4\.1-Flash/i) ?? pick(/flash/i) ?? ids[0];
  const strong = pick(/V4-Pro/i) ?? pick(/pro/i) ?? fast;
  if (!fast) return {};
  return {
    "claude-haiku-4-5": fast,
    "claude-sonnet-4-5": fast,
    "claude-opus-4-5": strong,
    ...explicitMap,
  };
}
const logRequests = process.env.SHIM_LOG_REQUESTS === "1";

if (!upstream || !token) {
  console.error("SHIM_UPSTREAM and SHIM_TOKEN are required");
  process.exit(2);
}

/** Collapse a model id to the form Claude Code produces: alphanumerics only. */
const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

/** exact id -> normalized key */
let index = new Map();
let knownIds = [];

async function refreshIndex() {
  const url = new URL(`${upstream.replace(/\/+$/, "")}/models`);
  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers: { "x-api-key": token, "anthropic-version": "2023-06-01" } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  if (body.status !== 200) throw new Error(`model list returned ${body.status}`);
  const parsed = JSON.parse(body.text);
  knownIds = (parsed.data ?? parsed.models ?? []).map((m) => m.id).filter(Boolean);
  index = new Map(knownIds.map((id) => [normalize(id), id]));
  for (const [alias, target] of Object.entries(deriveAliasMap(knownIds))) {
    if (!index.has(normalize(alias))) index.set(normalize(alias), target);
  }
  return knownIds;
}

/** Resolve whatever Claude Code sent back to a real upstream id. */
function resolveModel(sent) {
  if (!sent) return sent;
  if (explicitMap[sent]) return explicitMap[sent];
  if (index.has(normalize(sent))) return index.get(normalize(sent));
  return sent;
}

function forward(req, res, bodyOverride) {
  // The gateway base may already end in /v1 and Claude Code also sends /v1/...
  // Collapse the duplicated prefix instead of producing /v1/v1/messages.
  const base = upstream.replace(/\/+$/, "");
  let path = req.url ?? "/";
  const basePath = new URL(base).pathname.replace(/\/+$/, "");
  if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
  const target = new URL(`${base}${path}`);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  const payload = bodyOverride ?? undefined;
  if (payload) headers["content-length"] = Buffer.byteLength(payload);

  const upstreamReq = https.request(
    target,
    { method: req.method, headers },
    (upstreamRes) => {
      if (logRequests && (upstreamRes.statusCode ?? 0) >= 400) {
        console.log(`[shim] upstream ${upstreamRes.statusCode} for ${target.pathname}`);
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "shim_upstream_error", message: error.message } }));
  });
  if (payload) upstreamReq.end(payload);
  else req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400).end("missing url");
    return;
  }
  if (logRequests) console.log(`[shim] ${req.method} ${req.url}`);
  if (!req.url.startsWith("/v1/messages")) {
    forward(req, res);
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "shim_bad_json", message: "body was not JSON" } }));
      return;
    }
    const sent = parsed.model;
    const resolved = resolveModel(sent);
    if (resolved !== sent) {
      console.log(`[shim] ${sent} -> ${resolved}`);
      parsed.model = resolved;
    }
    forward(req, res, JSON.stringify(parsed));
  });
});

server.on("error", (error) => {
  console.error(`[shim] ${error.message}`);
  process.exit(1);
});

await refreshIndex().catch((error) => {
  console.error(`[shim] could not load model list: ${error.message}; forwarding names unchanged`);
});
console.log(`[shim] ${knownIds.length} upstream models indexed`);

server.listen(port, host, () => {
  console.log(`[shim] listening on http://${host}:${port} -> ${upstream}`);
});
