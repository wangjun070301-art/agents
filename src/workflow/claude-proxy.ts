import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * A local stand-in for the Anthropic endpoint, used only by Claude Code.
 *
 * Claude Code appends `[1m]` to any model name it does not recognise, and the
 * gateway on this machine rejects that suffix with "no available channel" even
 * though the bare name works. There is no flag to turn the suffix off, so the
 * suffix is removed in flight instead: Claude Code talks to this server, this
 * server talks to the real gateway.
 *
 * Only `model` is rewritten. Everything else, including the streaming body, is
 * passed through untouched.
 */
export interface ProxyHandle {
  /** Base URL to hand to Claude Code as ANTHROPIC_BASE_URL. */
  baseUrl: string;
  /** Port the proxy listens on. */
  port: number;
  /** Stop listening. Safe to call twice. */
  close: () => Promise<void>;
  /** How many requests were rewritten, for a test or a log line. */
  rewritten: () => number;
}

const SUFFIX = /\[1m\]$/;

/**
 * Remove the `[1m]` suffix Claude Code appends.
 *
 * Exported so the rewrite can be tested without standing up a server.
 */
export function stripContextSuffix(model: string): string {
  return model.replace(SUFFIX, "");
}

/**
 * Start the proxy.
 *
 * `upstream` is the real gateway base URL, e.g. `https://open-ai.baomiao.cn/v1`.
 * The proxy listens on an ephemeral port on 127.0.0.1 only.
 */
export async function startClaudeProxy(upstream: string): Promise<ProxyHandle> {
  const target = new URL(upstream);
  const transport = target.protocol === "https:" ? https : http;
  let count = 0;

  const server = http.createServer((req, res) => {
    // Claude Code is pointed at `<proxy>/v1` as its base URL, so it requests
    // `/v1/messages`. Match the endpoint, not the exact path prefix.
    const endpoint = req.url?.split("?")[0] ?? "";
    if (req.method !== "POST" || !/\/messages$/.test(endpoint)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "proxy only forwards /messages" } }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      let forwarded = body;
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === "string" && SUFFIX.test(parsed.model)) {
          parsed.model = stripContextSuffix(parsed.model);
          forwarded = JSON.stringify(parsed);
          count += 1;
        }
      } catch {
        // Not JSON: forward as-is rather than inventing a shape.
      }

      const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
      delete headers.host;
      delete headers["content-length"];
      headers["content-length"] = String(Buffer.byteLength(forwarded));

      const options = {
        method: "POST",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        // The proxy's own /v1 prefix is the caller's view of the base URL;
        // the upstream already carries its own path, so only the endpoint is
        // appended.
        path: `${target.pathname.replace(/\/$/, "")}${endpoint.replace(/^\/v1/, "")}`,
        headers,
      };

      const outgoing = transport.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      outgoing.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: { message: `proxy upstream failed: ${error.message}` } }));
      });
      outgoing.end(forwarded);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    rewritten: () => count,
  };
}
