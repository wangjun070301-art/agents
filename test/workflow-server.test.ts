import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPanel } from "../src/workflow/server.js";

/**
 * The panel is a control surface, not a task launcher. These tests pin the
 * three things it must get right: it serves state, it refuses an unclear
 * release, and it persists through a restart.
 */

function scratchState(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panel-"));
}

async function withPanel<T>(
  fn: (ctx: { base: string; panel: ReturnType<typeof createPanel>; dir: string }) => Promise<T>,
): Promise<T> {
  const dir = scratchState();
  const panel = createPanel({ stateDir: dir, port: 0 });
  await new Promise<void>((resolve, reject) => {
    panel.server.once("error", reject);
    panel.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = panel.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, panel, dir });
  } finally {
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the panel serves the HTML page", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const body = await response.text();
    assert.match(body, /流水线控制台/);
  });
});

test("the panel reports the current stage and no history on a fresh state", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/state`);
    assert.equal(response.status, 200);
    const state = (await response.json()) as { stage: string; history: unknown[] };
    assert.equal(state.stage, "INTAKE");
    assert.equal(state.history.length, 0);
  });
});

test("a release without a target stage is refused", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });
});

test("a blocked pipeline is released to the stage that blocked it", async () => {
  await withPanel(async ({ base, panel }) => {
    // Block the pipeline first, then release it.
    panel.pipeline.advance({ to: "CLARIFY" });
    panel.pipeline.advance({ to: "BLOCKED", note: "test block" });
    assert.equal(panel.pipeline.stage, "BLOCKED");

    const response = await fetch(`${base}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "CLARIFY", from: "CLARIFY", note: "human reviewed" }),
    });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as { ok: boolean };
    assert.equal(outcome.ok, true);
    assert.equal(panel.pipeline.stage, "CLARIFY");
    // The note must be the human's own words, not a generic placeholder.
    const record = panel.pipeline.history.at(-1);
    assert.equal(record?.note, "human reviewed");
  });
});

test("releasing a pipeline that is not blocked is refused", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "CLARIFY", from: "INTAKE" }),
    });
    // INTAKE -> CLARIFY is legal, but `blockedFrom` on a forward move is not.
    assert.equal(response.status, 409);
  });
});

test("the stage survives a panel restart", async () => {
  const dir = scratchState();
  const first = createPanel({ stateDir: dir, port: 0 });
  await new Promise<void>((resolve) => first.server.listen(0, "127.0.0.1", () => resolve()));
  first.pipeline.advance({ to: "CLARIFY" });
  await new Promise<void>((resolve) => first.server.close(() => resolve()));

  const second = createPanel({ stateDir: dir, port: 0 });
  assert.equal(second.pipeline.stage, "CLARIFY", "the persisted stage must load back");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the task records are listed from disk", async () => {
  await withPanel(async ({ base, dir }) => {
    const taskDir = path.join(dir, "tasks", "T-1");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "attempt-1.json"), "{}", "utf8");
    const response = await fetch(`${base}/api/state`);
    const state = (await response.json()) as { tasks: Array<{ taskId: string; files: string[] }> };
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0]?.taskId, "T-1");
    assert.deepEqual(state.tasks[0]?.files, ["attempt-1.json"]);
  });
});
