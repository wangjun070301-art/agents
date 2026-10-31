import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

/**
 * The three new capabilities. Each is tested for the honest failure mode:
 * saving a project that does not exist, running without a project, and
 * advancing across a gate without evidence.
 */

const sampleProject = (repo: string) => ({
  name: "fixture",
  repo_path: repo,
  model: "deepseek-v4.1-flash-solo",
  sandbox: "bypass",
  requirements: [
    {
      req_id: "REQ-1",
      statement: "the fixture works",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-1",
          description: "test passes",
          kind: "automated",
          verification_command: "node --test",
        },
      ],
    },
  ],
  tasks: [
    {
      task_id: "T-1",
      role: "developer",
      objective: "do the work",
      repo_path: repo,
      base_revision: "init",
      allowed_paths: ["src"],
      deliverables: ["src/x.js"],
      acceptance_ids: ["AC-1"],
      verification_commands: [{ command: "node --test", expect_exit: 0 }],
    },
  ],
});

test("a project can be saved and read back", async () => {
  await withPanel(async ({ base, dir }) => {
    const response = await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleProject(dir)),
    });
    assert.equal(response.status, 200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      project: { name: string; tasks: unknown[] } | null;
    };
    assert.equal(state.project?.name, "fixture");
    assert.equal(state.project?.tasks.length, 1);
  });
});

test("a project pointing at a missing repo is refused", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleProject("C:/definitely-not-here")),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /does not exist/);
  });
});

test("running a task without a configured project is refused", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "T-1" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /no project configured/);
  });
});

test("advancing across a gated edge without evidence is refused", async () => {
  await withPanel(async ({ base, panel }) => {
    // SPEC -> PLAN is gated by G0; the panel must not let a click pass it.
    panel.pipeline.advance({ to: "CLARIFY" });
    panel.pipeline.advance({ to: "BASELINE" });
    panel.pipeline.advance({ to: "SPEC" });
    const response = await fetch(`${base}/api/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "PLAN" }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /gated by G0/);
  });
});

test("advancing across an ungated edge is allowed", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "CLARIFY" }),
    });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as { ok: boolean; stage: string };
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, "CLARIFY");
  });
});

test("the state reports which stages are reachable and which are gated", async () => {
  await withPanel(async ({ base }) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      nextStages: Array<{ to: string; gate: string | null }>;
    };
    assert.deepEqual(
      state.nextStages.map((s) => s.to),
      ["CLARIFY", "BLOCKED"],
      "INTAKE may only go to CLARIFY or BLOCKED",
    );
    assert.equal(state.nextStages[0]?.gate, null);
  });
});

/**
 * The inline script lives inside a template literal in a .ts file, so the
 * TypeScript compiler never sees it. A missing parenthesis surfaces only in
 * the browser. Extract the script and syntax-check it with node.
 */
test("the inline panel script is syntactically valid JavaScript", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(base);
    const html = await response.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script, "the page must contain an inline script");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "panel-js-")), "panel.js");
    fs.writeFileSync(file, script, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || "inline script must parse");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

test("cancelling when nothing is running is refused", async () => {
  await withPanel(async ({ base }) => {
    const response = await fetch(`${base}/api/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /nothing is running/);
  });
});

test("the state snapshot always carries the output lines array", async () => {
  await withPanel(async ({ base }) => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as { outputLines: string[] };
    assert.ok(Array.isArray(state.outputLines), "outputLines must be an array even when empty");
    assert.equal(state.outputLines.length, 0);
  });
});
