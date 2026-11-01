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
  /** The model strings this proxy actually received. */
  modelsSeen: () => string[];
  /** The model strings actually forwarded upstream, in order. */
  modelsForwarded: () => string[];
}

const SUFFIX = /\[1m\]$/;

/**
 * Map a Claude Code model name onto the model the upstream actually serves.
 *
 * Claude Code only sends names from its built-in list, but Agent2API serves
 * its own names. The proxy rewrites the model field so Claude can keep using a
 * name it accepts while the gateway receives one it knows.
 */
export interface ModelMapping {
  /** What Claude Code sends, e.g. `claude-sonnet-4-5`. */
  from: string;
  /** What the upstream expects, e.g. `glm-5.3`. */
  to: string;
}

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
export async function startClaudeProxy(
  upstream: string,
  mapping?: ModelMapping[],
): Promise<ProxyHandle> {
  const target = new URL(upstream);
  const transport = target.protocol === "https:" ? https : http;
  let count = 0;
  /** Every model string seen, so a mismatch can be diagnosed. */
  const seen: string[] = [];
  /** The model string actually forwarded, in order. */
  const forwardedModels: string[] = [];

  const server = http.createServer((req, res) => {
    if (process.env.CLAUDE_PROXY_TRACE) {
      console.log(`[proxy] ${req.method} ${req.url}`);
        for (const key of ["anthropic-beta", "anthropic-version", "content-type"]) {
          if (req.headers[key]) console.log(`[proxy]   ${key}: ${req.headers[key]}`);
        }
    }
    // Claude Code is pointed at `<proxy>/v1` as its base URL, so it requests
    // `/v1/messages`. Match the endpoint, not the exact path prefix.
    const raw = req.url ?? "/";
    const endpoint = raw.split("?")[0] ?? "";
    // Claude Code is pointed at `<proxy>/v1` and requests `/v1/messages`, so
    // the path arrives as `/v1/v1/messages`. Every leading /v1 is a base-URL
    // artifact, not part of the endpoint, so all of them are collapsed.
    const normalized = endpoint.replace(/(?:\/v1)+\/?/, "/").replace(/\/$/, "") || "/";

    // Claude Code probes a hello endpoint before it sends anything; answering
    // it locally avoids a 404 that would abort the turn.
    if (req.method === "HEAD" || req.method === "GET") {
      if (normalized === "/api/hello" || normalized === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "proxy only forwards /messages" } }));
      return;
    }
    if (req.method !== "POST" || !/\/messages$/.test(normalized)) {
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
      let originalModel = "";
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === "string") {
          let model = parsed.model;
          originalModel = parsed.model;
          seen.push(model);
          const mapped = mapping?.find((entry) => model.startsWith(entry.from));
          if (mapped) {
            model = mapped.to;
          }
          model = stripContextSuffix(model);
          if (model !== parsed.model) {
            parsed.model = model;
            forwarded = JSON.stringify(parsed);
            count += 1;
          }
          forwardedModels.push(model);
        }
      } catch {
        // Not JSON: forward as-is rather than inventing a shape.
      }

      const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
      delete headers.host;
      delete headers["content-length"];

      /**
       * `context-1m-2025-08-07` tells the upstream to treat the request as a
       * 1m-context call, which makes it look for a `[1m]` model name. This
       * upstream has no such models, so the beta is removed from the list.
       */
      const beta = headers["anthropic-beta"];
      if (typeof beta === "string") {
        const kept = beta
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part && part !== "context-1m-2025-08-07");
        if (kept.length) headers["anthropic-beta"] = kept.join(",");
        else delete headers["anthropic-beta"];
      }
      headers["content-length"] = String(Buffer.byteLength(forwarded));

      // Remember the mapping for this request so the response can be restored.
      const restoreName = mapping?.find((entry) => originalModel.startsWith(entry.from));

      const options = {
        method: "POST",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        // The proxy's own /v1 prefix is the caller's view of the base URL;
        // the upstream already carries its own path, so only the endpoint is
        // appended.
        // `?beta=true` tells Claude Code the upstream supports the 1m context
        // beta, which is what makes it insist on a `[1m]` model name. The
        // upstream here does not, so the query is dropped.
        path: `${target.pathname.replace(/\/$/, "")}${normalized}`,
        headers,
      };

      const outgoing = transport.request(options, (upstreamRes) => {
        /**
         * Claude Code checks that the response's `model` field matches what it
         * asked for, and reports a 404 when it does not. The upstream answers
         * with its own name, so the field is mapped back before the response
         * leaves the proxy.
         */
        const restore = restoreName;
        if (!restore) {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          return;
        }

        /**
         * The upstream answers with SSE, and `model` appears inside the first
         * `message_start` event. Claude Code compares that value to what it
         * asked for, so the name is mapped back as the stream passes through.
         *
         * Streaming has no content-length to preserve: the response is
         * chunked, and every event is rewritten as it arrives.
         */
        const headers = { ...upstreamRes.headers };
        delete headers["content-length"];
        if (process.env.CLAUDE_PROXY_TRACE) {
          console.log(`[proxy] upstream status ${upstreamRes.statusCode} model->${restore.from}`);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);

        const pattern = new RegExp(
          `"model":"${restore.to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
          "g",
        );
        upstreamRes.on("data", (chunk) => {
          const text = String(chunk).replace(pattern, `"model":"${restore.from}"`);
          if (process.env.CLAUDE_PROXY_TRACE && upstreamRes.statusCode !== 200) {
            console.log(`[proxy] upstream body: ${text.slice(0, 240).replace(/\s+/g, " ")}`);
          }
          res.write(text);
        });
        upstreamRes.on("end", () => res.end());
        upstreamRes.on("error", () => res.end());
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
    modelsSeen: () => [...seen],
    modelsForwarded: () => [...forwardedModels],
  };
}
