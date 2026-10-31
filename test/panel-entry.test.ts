import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * The Windows entry points.
 *
 * `bin/*` are POSIX shell scripts, so on Windows the panel is started either by
 * `node tools/panel.mjs` or by the Electron shell. Neither had automated
 * coverage, and while writing it the first real bug surfaced: the panel
 * reported the requested port instead of the bound one, so the desktop window
 * was pointed at `http://127.0.0.1:0/` and never loaded anything.
 */

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = require(path.join(repo, "app", "panel-host.cjs")) as {
  resolveStateDir: (repoRoot: string, env?: Record<string, string | undefined>) => string;
  startPanel: (options: { repoRoot: string; stateDir: string; host?: string; port?: number }) => Promise<{
    panel: { stop: () => Promise<void> };
    port: number;
    url: string;
  }>;
};

test("PANEL_STATE overrides the default state directory", () => {
  const chosen = path.join(os.tmpdir(), "panel-state-explicit");
  assert.equal(
    host.resolveStateDir(repo, { PANEL_STATE: chosen }),
    path.resolve(chosen),
    "an explicit PANEL_STATE must be used as given",
  );
  assert.equal(
    host.resolveStateDir(repo, {}),
    path.join(repo, "workflow-state"),
    "without PANEL_STATE the state lives beside the repo",
  );
  assert.equal(
    host.resolveStateDir(repo, { PANEL_STATE: "" }),
    path.join(repo, "workflow-state"),
    "an empty PANEL_STATE is not a directory",
  );
});

/**
 * The bug this test exists for. With port 0 the OS picks the port, and
 * returning the requested value produces a URL nothing listens on.
 */
test("startPanel reports the port the socket actually bound", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-host-"));
  const started = await host.startPanel({ repoRoot: repo, stateDir, port: 0 });
  try {
    assert.ok(started.port > 0, `expected a real port, got ${started.port}`);
    assert.equal(started.url, `http://127.0.0.1:${started.port}/`);
    // The reported URL must actually answer.
    const response = await fetch(started.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await started.panel.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startPanel creates the state directory it was handed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-host-mkdir-"));
  const stateDir = path.join(root, "nested", "state");
  const started = await host.startPanel({ repoRoot: repo, stateDir, port: 0 });
  try {
    assert.equal(fs.existsSync(stateDir), true, "the state directory must exist before the panel serves");
    const state = (await (await fetch(`${started.url}api/state`)).json()) as { stage: string };
    assert.equal(state.stage, "INTAKE", "a fresh state directory starts at INTAKE");
  } finally {
    await started.panel.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * End to end: run the real launcher the way a Windows user would, then talk to
 * the panel it printed. This is the coverage the skipped `bin/*` test used to
 * imply on POSIX.
 */
test("tools/panel.mjs serves a working panel and prints the real port", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-cli-"));
  const child = spawn(
    process.execPath,
    [path.join(repo, "tools", "panel.mjs"), "--state", stateDir, "--port", "0"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );

  const closed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stderr }));
  });

  try {
    // The launcher prints "[panel] open:  http://127.0.0.1:<port>" once bound.
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`panel did not print a URL; stdout so far: ${stdout}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = /\[panel\] open:\s+(http:\/\/127\.0\.0\.1:(\d+)(?:\/)?)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`panel exited ${code} before printing a URL; stdout: ${stdout}`));
      });
    });

    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/?$/, `a real port must be printed, got ${url}`);
    assert.notEqual(url, "http://127.0.0.1:0/", "--port 0 must not be echoed back as the port");

    // The launcher prints the URL without a trailing slash; normalise once so
    // the API paths below append cleanly.
    const base = url.endsWith("/") ? url : `${url}/`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /流水线控制台/);
    assert.match(body, /AGENT ORCHESTRATOR/);

    const state = (await (await fetch(`${base}api/state`)).json()) as {
      stage: string;
      history: unknown[];
      outputLines: unknown[];
    };
    assert.equal(state.stage, "INTAKE");
    assert.equal(state.history.length, 0);
    assert.ok(Array.isArray(state.outputLines), "the state snapshot must carry the output lines array");
  } finally {
    child.kill();
    await closed.catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("tools/panel.mjs honours --state by writing the pipeline there", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-cli-state-"));
  const child = spawn(
    process.execPath,
    [path.join(repo, "tools", "panel.mjs"), "--state", stateDir, "--port", "0"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`no URL printed; stdout: ${stdout}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = /\[panel\] open:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/)?)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`panel exited ${code} before printing a URL`));
      });
    });

    // An ungated edge, so no evidence is needed. The write must land in the
    // directory given on the command line, not the repo default.
    const base = url.endsWith("/") ? url : `${url}/`;
    const advanced = await fetch(`${base}api/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "CLARIFY", note: "cli test" }),
    });
    assert.equal(advanced.status, 200, await advanced.text());

    const pipelineFile = path.join(stateDir, "pipeline.json");
    assert.equal(fs.existsSync(pipelineFile), true, "pipeline.json must be written under --state");
    const saved = JSON.parse(fs.readFileSync(pipelineFile, "utf8")) as { current: string };
    assert.equal(saved.current, "CLARIFY");
    assert.equal(
      fs.existsSync(path.join(repo, "workflow-state", "pipeline.json")) &&
        (JSON.parse(fs.readFileSync(path.join(repo, "workflow-state", "pipeline.json"), "utf8")) as { current: string })
          .current === "CLARIFY",
      false,
      "--state must not be ignored in favour of the repo default",
    );
  } finally {
    child.kill();
    await new Promise((resolve) => child.on("close", resolve)).catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/**
 * Electron is a dev dependency that downloads a binary at install time, and
 * `main.cjs` cannot run without it. These two tests pin what can be checked
 * without the runtime: the file parses, and it wires the resolved port rather
 * than a literal one.
 */
test("app/main.cjs parses and loads the URL the host resolved", () => {
  const source = fs.readFileSync(path.join(repo, "app", "main.cjs"), "utf8");
  assert.doesNotThrow(() => new Function(source), "main.cjs must be syntactically valid");
  assert.match(source, /win\.loadURL\(started\.url\)/, "the window must load the resolved URL");
  assert.doesNotMatch(source, /loadURL\(`http:\/\/127\.0\.0\.1:\$\{port\}\/`\)/, "the old literal-port load must be gone");
  assert.match(source, /startPanel\(\{ repoRoot, stateDir, port: 0 \}\)/, "the shell must request an ephemeral port");
});

test("app/panel-host.cjs parses and exports the two seams", () => {
  const file = path.join(repo, "app", "panel-host.cjs");
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotThrow(() => new Function(source), "panel-host.cjs must be syntactically valid");
  assert.equal(typeof host.resolveStateDir, "function");
  assert.equal(typeof host.startPanel, "function");
});

/**
 * Two instances must not fight over a port. `port: 0` is what makes that
 * work, and P23 recorded it as untested: the theory was fine, the behaviour
 * was not observed.
 */
test("two panels started at once bind different ports and both serve", async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "panel-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "panel-b-"));
  const [a, b] = await Promise.all([
    host.startPanel({ repoRoot: repo, stateDir: first, port: 0 }),
    host.startPanel({ repoRoot: repo, stateDir: second, port: 0 }),
  ]);
  try {
    assert.notEqual(a.port, b.port, "two instances must not share a port");
    for (const started of [a, b]) {
      const response = await fetch(started.url);
      assert.equal(response.status, 200, `${started.url} must serve`);
      const state = (await (await fetch(`${started.url}api/state`)).json()) as { stage: string };
      assert.equal(state.stage, "INTAKE");
    }
  } finally {
    await Promise.all([a.panel.stop(), b.panel.stop()]);
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
