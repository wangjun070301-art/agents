import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * The Electron shell, actually running.
 *
 * P23 could only check `main.cjs` statically because the Electron binary was
 * not installed, and that gap let two launch bugs survive. This test starts
 * the real binary in smoke mode: the window loads, the renderer reports what
 * it drew, and the process exits non-zero if the panel did not render.
 *
 * The binary is downloaded by Electron's own install step, so the test skips
 * when it is absent rather than failing a machine that never ran `npm ci`
 * with postinstall.
 */

const execute = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function electronBinary(): string | undefined {
  const pathFile = path.join(repo, "node_modules", "electron", "path.txt");
  if (!fs.existsSync(pathFile)) return undefined;
  const relative = fs.readFileSync(pathFile, "utf8").trim();
  const binary = path.join(repo, "node_modules", "electron", "dist", relative);
  return fs.existsSync(binary) ? binary : undefined;
}

const binary = electronBinary();
const electronReady = {
  skip: binary ? false : "Electron binary is not installed (run npm ci with postinstall)",
};

test("the Electron shell loads the panel and the renderer draws it", electronReady, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-smoke-"));
  try {
    const result = await execute(binary!, ["app/main.cjs"], {
      cwd: repo,
      env: { ...process.env, PANEL_SMOKE: "1", PANEL_STATE: stateDir },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    // The shell reports the port it bound, so a broken port resolution shows up
    // here as ":0/" rather than as a mysteriously blank window.
    const url = /\[app\] panel: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(result.stdout)?.[1];
    assert.ok(url, `the shell must print the panel URL, got: ${result.stdout}`);
    assert.doesNotMatch(url!, /:0\//, "the shell must not report port 0");

    assert.match(result.stdout, /\[app\] window: loaded/, "the window must finish loading");

    const render = /\[app\] render: (\{.*?\})/.exec(result.stdout)?.[1];
    assert.ok(render, `the shell must report what the renderer drew, got: ${result.stdout}`);
    const drawn = JSON.parse(render!) as {
      title: string;
      hasStageMap: boolean;
      hasNextStages: boolean;
      stageRows: number;
      gates: number;
      stageHint: string;
    };
    assert.equal(drawn.title, "流水线控制台");
    assert.equal(drawn.hasStageMap, true, "the stage map must exist");
    assert.equal(drawn.hasNextStages, true, "the intervention buttons must exist");
    assert.equal(drawn.stageRows, 13, "all 13 stages must be drawn");
    assert.equal(drawn.gates, 6, "all six gates must be drawn");
    // The hint is filled from /api/state, so this proves the renderer's fetch
    // reached the panel rather than the page merely painting its static shell.
    assert.match(drawn.stageHint, /当前阶段/, "the panel state must have been fetched");

    assert.match(result.stdout, /\[app\] smoke: ok/, "the smoke run must report success");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/**
 * The shell must not fall back to the repo's own workflow-state when
 * PANEL_STATE is set. A fresh state directory stays empty until something
 * advances, so the assertion is that the repo default was not written to.
 */
test("the Electron shell does not fall back to the repo state directory", electronReady, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-state-"));
  const repoState = path.join(repo, "workflow-state", "pipeline.json");
  const before = fs.existsSync(repoState) ? fs.readFileSync(repoState, "utf8") : undefined;
  try {
    await execute(binary!, ["app/main.cjs"], {
      cwd: repo,
      env: { ...process.env, PANEL_SMOKE: "1", PANEL_STATE: stateDir },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const after = fs.existsSync(repoState) ? fs.readFileSync(repoState, "utf8") : undefined;
    assert.equal(after, before, "PANEL_STATE must keep the shell out of the repo's own state");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
