import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Pipeline } from "./pipeline.js";
import type { Stage } from "./contracts.js";
import { readProject, writeProject, codexHomeFor, defaultCodexPath, type Project } from "./project.js";
import { CodexAdapter } from "./adapters/codex.js";
import { redactSecrets } from "./adapters/codex.js";
import { Scheduler } from "./scheduler.js";
import { LEGAL_TRANSITIONS, gateFor } from "./states.js";
import { evaluateGate } from "./gates.js";

/**
 * A small local control panel for one pipeline.
 *
 * It is deliberately narrow: show the stage, show what happened, and let a
 * human release a BLOCKED pipeline. It does not start tasks — that is the
 * scheduler's job, and mixing the two would mean a button that spends money.
 *
 * Bound to 127.0.0.1 only. No auth: the only reachable client is this machine.
 */
export interface ServerOptions {
  /** Directory holding pipeline.json and any task records. */
  stateDir: string;
  port?: number;
  host?: string;
  /** Overrides the codex binary path; defaults to the machine's install. */
  codexPath?: string;
}

export function createPanel(options: ServerOptions): {
  server: http.Server;
  pipeline: Pipeline;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  /**
   * The state directory must be a directory, and a missing one is created.
   *
   * Without this check a path pointing at a regular file (or a path whose
   * parent is missing) was accepted at startup and only failed later, on the
   * first stage change, as a raw EEXIST/ENOTDIR from deep inside persist().
   * The panel then looked alive while being unable to record anything.
   */
  let resolvedStateDir: string;
  try {
    const stat = fs.statSync(options.stateDir);
    if (!stat.isDirectory()) {
      throw new Error(`stateDir is not a directory: ${options.stateDir}`);
    }
    resolvedStateDir = fs.realpathSync(options.stateDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    fs.mkdirSync(options.stateDir, { recursive: true });
    resolvedStateDir = fs.realpathSync(options.stateDir);
  }
  const stateDir = resolvedStateDir;
  const stateFile = path.join(stateDir, "pipeline.json");
  const pipeline = Pipeline.restore(stateFile);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18493;
  /** A run in flight, with the adapter so the UI can cancel it. */
  let active: {
    taskId: string;
    adapter: CodexAdapter | null;
    /** The task the adapter is actually running; a plan changes this per task. */
    currentTask: string | null;
    lines: string[];
    cancelling: boolean;
    startedAt: string;
  } | undefined;
  /** Output of the last finished run, so it stays visible after completion. */
  let lastLines: string[] = [];
  let lastRun: { taskId: string; ok: boolean; finishedAt: string; failure?: unknown } | undefined;

  const send = (res: http.ServerResponse, status: number, body: string, type = "application/json") => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(body);
  };

  const snapshot = () => ({
    stage: pipeline.stage,
    blocked: pipeline.isBlocked,
    passedGates: pipeline.passedGates,
    history: pipeline.history,
    tasks: readTaskRecords(stateDir),
    project: readProject(stateDir) ?? null,
    running: active
      ? {
          taskId: active.taskId,
          // A plan's `taskId` is the literal string "PLAN", so the UI could not
          // say which task was actually running. The adapter already reports
          // it; expose it instead of leaving the panel guessing.
          currentTask: active.currentTask,
          cancelling: active.cancelling,
          startedAt: active.startedAt,
        }
      : null,
    lastRun: lastRun ?? null,
    outputLines: (active?.taskId ?? lastRun?.taskId) ? (active?.lines ?? lastLines) : [],
    /** Which stages this stage may legally move to, with the gate on that edge. */
    nextStages: LEGAL_TRANSITIONS[pipeline.stage].map((to) => ({
      to,
      gate: gateFor(pipeline.stage, to) ?? null,
    })),
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, PANEL_HTML, "text/html");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(res, 200, JSON.stringify(snapshot()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/release") {
      readJson(req)
        .then((body) => {
          // Releasing requires naming the stage that blocked, because BLOCKED
          // is not a stage you leave toward "somewhere" — it goes back to where
          // it came from.
          const target = body?.to as Stage | undefined;
          const from = body?.from as Stage | undefined;
          if (!target || !from) {
            send(res, 400, JSON.stringify({ error: "release needs both `to` and `from`" }));
            return;
          }
          // The note the human typed is the record of why this was released.
          // Dropping it would leave the history saying only "somebody clicked".
          const note = (body?.note as string | undefined)?.trim() || "released from the panel";
          const outcome = pipeline.advance({ to: target, blockedFrom: from, note });
          send(res, outcome.ok ? 200 : 409, JSON.stringify(outcome));
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/block") {
      readJson(req)
        .then((body) => {
          const note = (body?.note as string | undefined) ?? "blocked from the panel";
          const outcome = pipeline.advance({ to: "BLOCKED", note });
          send(res, outcome.ok ? 200 : 409, JSON.stringify(outcome));
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project") {
      readJson(req)
        .then((body) => {
          const project = writeProject(stateDir, body);
          send(res, 200, JSON.stringify({ ok: true, project }));
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      readJson(req)
        .then(async (body) => {
          const project = readProject(stateDir);
          if (!project) {
            send(res, 400, JSON.stringify({ error: "no project configured" }));
            return;
          }
          const taskId = (body?.taskId as string | undefined)?.trim();
          const task = taskId
            ? project.tasks.find((t) => t.task_id === taskId)
            : project.tasks.find((t) => t.task_id === (body?.first as string | undefined)) ?? project.tasks[0];
          if (!task) {
            send(res, 404, JSON.stringify({ error: `no such task: ${taskId}` }));
            return;
          }
          if (active) {
            send(res, 409, JSON.stringify({ error: `a run is already in progress: ${active.taskId}` }));
            return;
          }
          active = {
            taskId: task.task_id,
            adapter: null,
            currentTask: null,
            lines: [],
            cancelling: false,
            startedAt: new Date().toISOString(),
          };
          send(res, 202, JSON.stringify({ accepted: true, taskId: task.task_id }));

          // Run after responding, so the UI gets its acknowledgement at once
          // instead of waiting on a child process that may take minutes.
          void executeTask(project, task, stateDir, options.codexPath, {
            onCreated: (adapter) => {
              if (active?.taskId === task.task_id) active.adapter = adapter;
            },
            onTaskStart: (taskId) => {
              if (active?.taskId === task.task_id) active.currentTask = taskId;
            },
            isCancelled: () => active?.taskId === task.task_id && active.cancelling,
            onOutput: (chunk) => {
              if (active?.taskId === task.task_id) {
                active.lines.push(redactSecrets(chunk));
                if (active.lines.length > 2000) active.lines.splice(0, active.lines.length - 2000);
              }
            },
          })
            .then((result) => {
              lastRun = {
                taskId: task.task_id,
                ok: result.ok,
                finishedAt: new Date().toISOString(),
                ...(result.failure ? { failure: result.failure } : {}),
              };
              if (active?.taskId === task.task_id) lastLines = [...active.lines];
            })
            .catch((error: unknown) => {
              lastRun = {
                taskId: task.task_id,
                ok: false,
                finishedAt: new Date().toISOString(),
                failure: { reason: "panel-error", detail: error instanceof Error ? error.message : String(error) },
              };
            })
            .finally(() => {
              active = undefined;
            });
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run-plan") {
      readJson(req)
        .then(async () => {
          const project = readProject(stateDir);
          if (!project) {
            send(res, 400, JSON.stringify({ error: "no project configured" }));
            return;
          }
          if (active) {
            send(res, 409, JSON.stringify({ error: `a run is already in progress: ${active.taskId}` }));
            return;
          }
          active = {
            taskId: "PLAN",
            adapter: null,
            currentTask: null,
            lines: [],
            cancelling: false,
            startedAt: new Date().toISOString(),
          };
          send(res, 202, JSON.stringify({ accepted: true, taskId: "PLAN" }));
          void executePlan(project, stateDir, options.codexPath, {
            onCreated: (adapter) => {
              if (active?.taskId === "PLAN") active.adapter = adapter;
            },
            onTaskStart: (taskId) => {
              if (active?.taskId === "PLAN") active.currentTask = taskId;
            },
            isCancelled: () => active?.taskId === "PLAN" && active.cancelling,
            onOutput: (chunk) => {
              if (active?.taskId === "PLAN") {
                active.lines.push(redactSecrets(chunk));
                if (active.lines.length > 2000) active.lines.splice(0, active.lines.length - 2000);
              }
            },
          })
            .then((result) => {
              lastRun = {
                taskId: "PLAN",
                ok: result.failed.length === 0,
                finishedAt: new Date().toISOString(),
                ...(result.failed.length ? { failure: result } : {}),
              };
              if (active?.taskId === "PLAN") lastLines = [...active.lines];
            })
            .catch((error: unknown) => {
              lastRun = {
                taskId: "PLAN",
                ok: false,
                finishedAt: new Date().toISOString(),
                failure: { reason: "panel-error", detail: error instanceof Error ? error.message : String(error) },
              };
            })
            .finally(() => {
              active = undefined;
            });
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      if (!active) {
        send(res, 409, JSON.stringify({ error: "nothing is running" }));
        return;
      }
      active.cancelling = true;
      // The adapter is created inside executeTask/executePlan and linked back
      // here. If it is not linked yet the task is still starting; the cancel
      // flag is polled by the scheduler before every attempt, so the run stops
      // at the earliest safe point either way.
      const runningTask = active.currentTask ?? active.taskId;
      if (active.adapter) {
        active.adapter.cancel(runningTask).catch(() => {});
      }
      send(res, 200, JSON.stringify({ ok: true, taskId: active.taskId }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/advance") {
      readJson(req)
        .then((body) => {
          const to = body?.to as Stage | undefined;
          if (!to) {
            send(res, 400, JSON.stringify({ error: "advance needs `to`" }));
            return;
          }
          const gate = gateFor(pipeline.stage, to);
          // A gated edge needs evidence. The panel cannot invent it, so it
          // refuses rather than letting a click bypass a gate.
          if (gate) {
            send(res, 409, JSON.stringify({
              error: `stage ${pipeline.stage} -> ${to} is gated by ${gate}; run a task to produce its evidence`,
            }));
            return;
          }
          const outcome = pipeline.advance({ to, note: (body?.note as string | undefined)?.trim() || "advanced from the panel" });
          send(res, outcome.ok ? 200 : 409, JSON.stringify(outcome));
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  });

  return {
    server,
    pipeline,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          // Resolve the port the socket actually bound to, not the one we
          // asked for. With port 0 — which the Electron shell uses so two
          // instances never collide — the requested value is meaningless and
          // loading "http://127.0.0.1:0/" would open nothing.
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Run one task with the real adapter and the real scheduler, then let the
 * stage gate judge it. Returns whatever the scheduler decided; the caller only
 * records it.
 */
async function executeTask(
  project: Project,
  task: Project["tasks"][number],
  stateDir: string,
  codexPath: string | undefined,
  hooks?: {
    onCreated?: (adapter: CodexAdapter) => void;
    onTaskStart?: (taskId: string) => void;
    isCancelled?: () => boolean;
    onOutput?: (chunk: string) => void;
  },
): Promise<{ ok: boolean; failure?: unknown }> {
  const home = codexHomeFor(stateDir);
  fs.mkdirSync(home, { recursive: true });
  // The adapter needs a writable CODEX_HOME with auth in it. Copy the user's
  // once, so a run does not depend on the live home being writable.
  for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
    const from = path.join(process.env.USERPROFILE ?? "", ".codex", file);
    const to = path.join(home, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }

  const adapter = new CodexAdapter({
    codexPath: codexPath ?? defaultCodexPath(),
    codexHome: home,
    model: project.model,
    sandbox: project.sandbox,
    observeWorktree: true,
    ...(hooks?.onOutput ? { onOutput: hooks.onOutput } : {}),
  });
  hooks?.onCreated?.(adapter);
  const pipeline = Pipeline.restore(path.join(stateDir, "pipeline.json"));
  const scheduler = new Scheduler({
    adapter,
    requirements: project.requirements,
    pipeline,
    maxAttempts: 2,
    stateDir,
    ...(hooks?.onTaskStart ? { onTaskStart: hooks.onTaskStart } : {}),
    ...(hooks?.isCancelled ? { isCancelled: hooks.isCancelled } : {}),
  });

  const outcome = await scheduler.runTask(task);
  if (outcome.ok) {
    // The task's own evidence supports its claim; now the stage gate decides.
    const last = outcome.attempts.at(-1);
    const next = nextStage(pipeline.stage);
    if (next) {
      scheduler.advanceStage(next, {
        requirements: project.requirements,
        tasks: project.tasks,
        envelope: task,
        result: last?.result,
        deliveredArtifact: task.base_revision,
        changedFiles: last?.observedChanges,
      }, `task ${task.task_id} completed`);
    }
  }
  return { ok: outcome.ok, ...(outcome.failure ? { failure: outcome.failure } : {}) };
}

/**
 * Run every task in dependency order with the real scheduler. Returns the
 * plan outcome so the panel can show which tasks completed and which did not.
 */
async function executePlan(
  project: Project,
  stateDir: string,
  codexPath: string | undefined,
  hooks?: {
    onCreated?: (adapter: CodexAdapter) => void;
    onTaskStart?: (taskId: string) => void;
    isCancelled?: () => boolean;
    onOutput?: (chunk: string) => void;
  },
): Promise<{ completed: string[]; failed: Array<{ taskId: string; reason: string }>; skipped: Array<{ taskId: string; because: string }> }> {
  const home = codexHomeFor(stateDir);
  fs.mkdirSync(home, { recursive: true });
  for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
    const from = path.join(process.env.USERPROFILE ?? "", ".codex", file);
    const to = path.join(home, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  const adapter = new CodexAdapter({
    codexPath: codexPath ?? defaultCodexPath(),
    codexHome: home,
    model: project.model,
    sandbox: project.sandbox,
    observeWorktree: true,
    ...(hooks?.onOutput ? { onOutput: hooks.onOutput } : {}),
  });
  hooks?.onCreated?.(adapter);
  const pipeline = Pipeline.restore(path.join(stateDir, "pipeline.json"));
  const scheduler = new Scheduler({
    adapter,
    requirements: project.requirements,
    pipeline,
    maxAttempts: 2,
    stateDir,
    ...(hooks?.onTaskStart ? { onTaskStart: hooks.onTaskStart } : {}),
    ...(hooks?.isCancelled ? { isCancelled: hooks.isCancelled } : {}),
  });
  const outcome = await scheduler.runPlan(project.tasks);
  return {
    completed: outcome.completed,
    failed: outcome.failed.map((f) => ({ taskId: f.taskId, reason: f.detail })),
    skipped: outcome.skipped,
  };
}

/** The forward edge out of a stage, if there is one. */
function nextStage(stage: Stage): Stage | undefined {
  const edges = LEGAL_TRANSITIONS[stage].filter((to) => to !== "BLOCKED");
  return edges[0];
}

/** Every per-task record under stateDir/tasks, newest first. */
function readTaskRecords(stateDir: string): Array<{ taskId: string; files: string[]; failure?: unknown }> {
  const dir = path.join(stateDir, "tasks");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const taskDir = path.join(dir, e.name);
      const files = fs.readdirSync(taskDir).sort();
      let failure: unknown;
      const failureFile = path.join(taskDir, "failure.json");
      if (fs.existsSync(failureFile)) {
        try {
          failure = JSON.parse(fs.readFileSync(failureFile, "utf8"));
        } catch {
          failure = { reason: "unreadable" };
        }
      }
      return { taskId: e.name, files, failure };
    });
  return records.sort((a, b) => b.taskId.localeCompare(a.taskId));
}

const PANEL_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>流水线控制台</title>
<style>
:root{
  --bg:#050B14;--bg2:#0A0F1D;--panel:rgba(13,22,38,.72);--panel2:rgba(16,28,48,.85);
  --cyan:#00F2FE;--green:#10B981;--red:#FF4D4D;--orange:#FF9F43;
  --ink:#D8F3FF;--muted:#7B8FA8;--line:rgba(0,242,254,.18);--line2:rgba(0,242,254,.35);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:var(--bg)
}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:
  radial-gradient(1000px 500px at 15% -10%,rgba(0,242,254,.10),transparent 60%),
  radial-gradient(700px 400px at 90% 0%,rgba(16,185,129,.07),transparent 55%),
  var(--bg);
  background-image:
    linear-gradient(rgba(0,242,254,.03) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,242,254,.03) 1px,transparent 1px);
  background-size:44px 44px}
button,input,textarea,select{font:inherit}
button{cursor:pointer;border:0}
button:disabled{opacity:.35;cursor:default}
a{color:var(--cyan)}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:rgba(0,242,254,.25);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}
::selection{background:rgba(0,242,254,.3)}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 28px;border-bottom:1px solid var(--line);background:rgba(5,11,20,.8);backdrop-filter:blur(12px);position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:center;gap:14px}
.brand .logo{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,rgba(0,242,254,.2),rgba(0,242,254,.05));border:1px solid var(--line2);display:grid;place-items:center;font-weight:800;font-size:18px;color:var(--cyan);box-shadow:0 0 20px rgba(0,242,254,.25),inset 0 0 12px rgba(0,242,254,.15)}
.brand h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.5px;color:var(--ink)}
.brand .tag{font-size:9px;color:var(--cyan);letter-spacing:2.5px;opacity:.8}
.top-actions{display:flex;gap:8px;align-items:center}
.status-pill{display:inline-flex;align-items:center;gap:7px;font-size:11px;padding:6px 14px;border-radius:999px;background:rgba(0,242,254,.08);border:1px solid var(--line2);letter-spacing:.5px}
.status-pill .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green)}
.status-pill.warn .dot{background:var(--orange);box-shadow:0 0 10px var(--orange);animation:pulse 1.2s ease-in-out infinite}
.status-pill.bad .dot{background:var(--red);box-shadow:0 0 10px var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.wrap{padding:24px 28px 40px;max-width:1500px;margin:0 auto}
.grid{display:grid;grid-template-columns:280px minmax(0,1fr) 320px;gap:16px;align-items:start}
.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;backdrop-filter:blur(8px);box-shadow:0 0 20px rgba(0,242,254,.04)}
.head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);background:rgba(0,242,254,.04)}
.head h2{font-size:12px;margin:0;font-weight:650;letter-spacing:1.5px;color:var(--cyan);text-transform:uppercase}
.head .hint{font-size:11px;color:var(--muted)}
.body{padding:16px}
.badge{display:inline-block;font-size:10px;padding:3px 10px;border-radius:999px;background:rgba(16,185,129,.12);color:var(--green);border:1px solid rgba(16,185,129,.3);font-weight:600;letter-spacing:.5px}
.badge.warn{background:rgba(255,159,67,.12);color:var(--orange);border-color:rgba(255,159,67,.35)}
.badge.bad{background:rgba(255,77,77,.12);color:var(--red);border-color:rgba(255,77,77,.35)}
.badge.idle{background:rgba(123,143,168,.1);color:var(--muted);border-color:var(--line)}
.label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--cyan);opacity:.7;margin:0 0 8px;font-weight:600}
input,textarea,select{width:100%;border:1px solid rgba(0,242,254,.2);border-radius:8px;padding:9px 12px;color:var(--ink);background:rgba(5,11,20,.6);outline:none;font-size:13px}
input:focus,textarea:focus,select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,242,254,.12),0 0 15px rgba(0,242,254,.15)}
textarea{resize:vertical;line-height:1.6}
input::placeholder,textarea::placeholder{color:#4A5B70}
.btn{border-radius:8px;padding:9px 16px;font-size:12px;font-weight:700;letter-spacing:.5px;background:linear-gradient(135deg,rgba(0,242,254,.25),rgba(0,242,254,.1));color:var(--cyan);border:1px solid var(--line2);transition:all .15s}
.btn:hover{box-shadow:0 0 18px rgba(0,242,254,.3)}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.btn.ghost:hover{color:var(--ink);border-color:var(--line2)}
.btn.danger{background:linear-gradient(135deg,rgba(255,77,77,.25),rgba(255,77,77,.1));color:var(--red);border-color:rgba(255,77,77,.4)}
.btn.danger:hover{box-shadow:0 0 18px rgba(255,77,77,.3)}
.btn.sm{padding:5px 10px;font-size:11px}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.msg{font-size:12px;margin-top:10px;line-height:1.6;color:var(--green)}
.msg.err{color:var(--red)}
.empty{padding:32px 16px;text-align:center;color:var(--muted);font-size:12px;line-height:1.8}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}

/* stage map */
.stage-map{display:flex;flex-direction:column;padding:4px 2px}
.stage-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;position:relative;border:1px solid transparent}
.stage-row.done{color:var(--muted)}
.stage-row.current{background:rgba(0,242,254,.08);border-color:var(--line2);box-shadow:0 0 15px rgba(0,242,254,.15)}
.stage-row.blocked{background:rgba(255,159,67,.08);border-color:rgba(255,159,67,.4)}
.stage-idx{width:20px;height:20px;border-radius:50%;background:rgba(5,11,20,.7);border:1px solid var(--line2);display:grid;place-items:center;font-size:9px;color:var(--muted);flex-shrink:0}
.stage-row.done .stage-idx{background:rgba(16,185,129,.15);border-color:var(--green);color:var(--green)}
.stage-row.current .stage-idx{background:var(--cyan);border-color:var(--cyan);color:#050B14;font-weight:800;box-shadow:0 0 12px var(--cyan)}
.stage-row.blocked .stage-idx{background:var(--orange);border-color:var(--orange);color:#050B14}
.stage-name{font-size:12px;flex:1;letter-spacing:.3px}
.stage-row.current .stage-name{font-weight:700;color:var(--cyan)}
.stage-state{font-size:9px;color:var(--muted)}
.stage-row.current .stage-state{color:var(--cyan)}
.stage-row.blocked .stage-state{color:var(--orange)}
.stage-connector{width:2px;height:5px;margin-left:17px;background:var(--line2)}
.stage-row.done .stage-connector{background:var(--green)}

/* gates */
.gates{display:flex;gap:6px;flex-wrap:wrap}
.gate{font-size:10px;padding:4px 9px;border-radius:5px;background:rgba(5,11,20,.6);border:1px solid var(--line);color:var(--muted);font-weight:700}
.gate.on{background:rgba(16,185,129,.15);border-color:var(--green);color:var(--green);box-shadow:0 0 10px rgba(16,185,129,.2)}

/* history timeline */
.timeline{position:relative;padding-left:20px}
.timeline::before{content:'';position:absolute;left:5px;top:4px;bottom:4px;width:2px;background:linear-gradient(var(--cyan),rgba(0,242,254,.05))}
.tl-item{position:relative;padding:9px 0 9px 2px}
.tl-item::before{content:'';position:absolute;left:-17px;top:15px;width:9px;height:9px;border-radius:50%;background:var(--bg2);border:2px solid var(--line2)}
.tl-item.done::before{background:rgba(16,185,129,.2);border-color:var(--green);box-shadow:0 0 8px var(--green)}
.tl-item.blocked::before{background:var(--orange);border-color:var(--orange);box-shadow:0 0 8px var(--orange)}
.tl-item.failed::before{background:var(--red);border-color:var(--red);box-shadow:0 0 8px var(--red)}
.tl-title{font-size:12px;font-weight:600;color:var(--ink)}
.tl-meta{font-size:10px;color:var(--muted);margin-top:2px}
.tl-note{font-size:11px;color:#9FB6CC;margin-top:4px;line-height:1.5}
.tl-gate{display:inline-block;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(0,242,254,.1);color:var(--cyan);margin-left:6px;font-weight:700}
.tl-gate.fail{background:rgba(255,77,77,.12);color:var(--red)}

/* output */
.output-box{background:rgba(3,8,16,.9);border:1px solid rgba(0,242,254,.15);border-radius:8px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#B8E6F5;box-shadow:inset 0 0 20px rgba(0,242,254,.05)}
.output-box .out-stderr{color:var(--orange)}

/* task list */
.task-card{border:1px solid rgba(0,242,254,.15);border-radius:10px;padding:13px;margin-bottom:10px;background:rgba(5,11,20,.5)}
.task-card:hover{border-color:var(--line2)}
.task-card .t-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.task-card .t-id{font-size:11px;color:var(--cyan);font-weight:700}
.task-card .t-role{font-size:9px;color:var(--muted);border:1px solid var(--line2);padding:1px 7px;border-radius:4px;letter-spacing:.5px}
.task-card .t-obj{font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px}

/* config forms */
.req{border:1px solid rgba(0,242,254,.12);border-radius:10px;padding:12px;margin-bottom:10px;background:rgba(5,11,20,.45)}
.item-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.item-head b{color:var(--cyan);font-size:12px}
.ac-list{margin-top:10px;padding-left:12px;border-left:2px solid var(--line2)}
.ac{border:1px solid rgba(0,242,254,.1);border-radius:8px;padding:9px;margin-bottom:8px;background:rgba(10,15,29,.5)}
.req input,.req textarea{font-size:12px;padding:7px 10px}
.req .label{margin:7px 0 3px;font-size:9px}

@media(max-width:1200px){.grid{grid-template-columns:240px minmax(0,1fr)}.col:last-child{grid-column:1/-1}}
@media(max-width:800px){.grid{grid-template-columns:minmax(0,1fr)}.topbar{padding:12px 16px}.wrap{padding:16px}.brand .tag{display:none}}
</style></head><body>
<div class="topbar">
  <div class="brand"><div class="logo">AO</div><div><h1>AGENT ORCHESTRATOR</h1><div class="tag">CYBER-HUD · MULTI-AGENT DIRECT CONTROL</div></div></div>
  <div class="top-actions">
    <span class="status-pill"><span class="dot"></span>ONLINE 127.0.0.1:18493</span>
    <span class="status-pill" id="runState">IDLE</span>
    <button class="btn ghost sm" id="exportJson">导出</button>
    <button class="btn ghost sm" id="importJson">导入</button>
    <input id="importFile" type="file" accept="application/json,.json" hidden>
  </div>
</div>
<div class="wrap">
  <div class="grid">
    <!-- 左：Agent 矩阵监视舱 -->
    <div class="col">
      <section class="card">
        <div class="head"><h2>Agent Matrix</h2><span class="badge" id="state">读取中</span></div>
        <div class="body">
          <div class="stage-map" id="stageMap"></div>
          <p class="label" style="margin-top:14px">质量门禁</p>
          <div class="gates" id="gates"></div>
        </div>
      </section>
      <section class="card">
        <div class="head"><h2>Intervention</h2><span class="badge">DIRECT</span></div>
        <div class="body">
          <p class="label">可推进到</p>
          <div class="actions" id="nextStages"></div>
          <div id="releaseBox" hidden>
            <p class="label" style="margin-top:14px">放行回哪个阶段</p>
            <input id="releaseTo" placeholder="例如 IMPLEMENT">
            <textarea id="releaseNote" placeholder="为什么可以继续（会记入历史）"></textarea>
            <div class="actions"><button class="btn" id="releaseBtn">放行</button><button class="btn danger" id="blockBtn">强制阻塞</button></div>
          </div>
          <div class="msg" id="actionMsg"></div>
        </div>
      </section>
    </div>

    <!-- 中：直接控制中心 -->
    <div class="col">
      <section class="card">
        <div class="head"><h2>Direct Control</h2><span class="hint" id="stageHint"></span></div>
        <div class="body">
          <p class="label">项目配置</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><p class="label">名称</p><input id="pName" placeholder="例如 fixture"></div>
            <div><p class="label">沙箱</p><input id="pSandbox" value="bypass"></div>
          </div>
          <p class="label" style="margin-top:12px">代码目录</p><input id="pRepo" placeholder="C:\\path\\to\\repo">
          <p class="label" style="margin-top:12px">模型</p><input id="pModel" value="deepseek-v4.1-flash-solo">
          <p class="label" style="margin-top:14px">需求</p>
          <div id="reqList"></div>
          <div class="actions"><button class="btn ghost sm" id="addReq">+ 需求</button></div>
          <p class="label" style="margin-top:14px">任务</p>
          <div id="taskForm"></div>
          <div class="actions"><button class="btn ghost sm" id="addTask">+ 任务</button><button class="btn" id="saveProject">保存配置</button></div>
          <div class="msg" id="projMsg"></div>
        </div>
      </section>
      <section class="card">
        <div class="head"><h2>Task Queue</h2><span class="badge idle" id="projState">未配置</span></div>
        <div class="body" id="taskList"><div class="empty">先保存项目配置。</div></div>
        <div class="body" style="padding-top:0"><button class="btn" id="runPlanBtn" style="width:100%">▶ 执行整个工作流</button></div>
      </section>
      <section class="card" id="outputCard" hidden>
        <div class="head"><h2>Live Terminal</h2><div class="actions" style="margin:0"><button class="btn danger sm" id="cancelBtn">中断</button></div></div>
        <div class="body"><div class="output-box" id="output"></div></div>
      </section>
    </div>

    <!-- 右：交互终端 + 历史 -->
    <div class="col">
      <section class="card">
        <div class="head"><h2>History</h2><span class="badge" id="count">0</span></div>
        <div class="body" style="padding:12px">
          <input id="historyFilter" placeholder="筛选：阶段 / 门禁 / 备注">
          <div class="timeline" id="history" style="margin-top:8px"><div class="empty">还没有阶段变化。</div></div>
        </div>
      </section>
      <section class="card">
        <div class="head"><h2>Run Records</h2><span class="badge" id="taskCount">0</span></div>
        <div class="body" id="tasks"><div class="empty">还没有任务记录。</div></div>
      </section>
    </div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const stageNames={INTAKE:'接单',CLARIFY:'澄清',BASELINE:'基线',SPEC:'需求规格',PLAN:'计划',DISPATCH:'派工',IMPLEMENT:'实现',REVIEW:'审查',VERIFY:'验证',INTEGRATE:'集成',ACCEPT:'验收',DELIVER:'交付',ARCHIVE:'归档',BLOCKED:'已阻塞'};
const gateOrder=['G0','G1','G2','G3','G4','G5'];
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
let lastBlockedFrom=null;
let projectLoaded=false;
async function load(){
  const r=await fetch('/api/state');const s=await r.json();
  $('stageHint').textContent=s.stage==='BLOCKED'?'等待人工处理':'当前阶段（代码：'+s.stage+'）';
  const badge=$('state');badge.textContent=s.blocked?'已阻塞':'进行中';badge.className='badge'+(s.blocked?' warn':'');
  renderStageMap(s);
  const gates=$('gates');gates.replaceChildren();
  for(const g of gateOrder){const on=s.passedGates.includes(g);gates.append(el('span','gate'+(on?' on':''),g+(on?' ✓':'')));}
  const lastBlocked=[...s.history].reverse().find(h=>h.to==='BLOCKED');
  lastBlockedFrom=lastBlocked?lastBlocked.from:null;
  $('releaseBox').hidden=!s.blocked;
  if(s.blocked&&lastBlockedFrom)$('releaseTo').value=lastBlockedFrom;
  const next=$('nextStages');next.replaceChildren();
  for(const edge of s.nextStages){
    if(edge.to==='BLOCKED')continue;
    const b=el('button','ghost',(stageNames[edge.to]||edge.to)+(edge.gate?' ('+edge.gate+')':''));
    b.onclick=()=>post('/api/advance',{to:edge.to,note:'从面板推进'});
    if(edge.gate)b.disabled=true;
    if(edge.gate)b.title='这一步需要门禁证据，跑一个任务来产生';
    next.append(b);
  }
  renderProject(s.project);
  renderTasks(s);
  renderRunning(s.running,s.lastRun,s.outputLines);
  $('count').textContent=String(s.history.length);
  const h=$('history');h.replaceChildren();
  if(!s.history.length)h.append(el('div','empty','还没有阶段变化。'));
  const filtered=[...s.history].reverse().filter(rec=>{
    if(!historyFilterValue)return true;
    const from=stageNames[rec.from]||rec.from,to=stageNames[rec.to]||rec.to;
    const hay=(from+' '+to+' '+(rec.gate||'')+' '+(rec.note||'')).toLowerCase();
    return hay.includes(historyFilterValue);
  });
  if(!filtered.length)h.append(el('div','empty','没有匹配的阶段变化。'));
  for(const rec of filtered){
    const item=el('div','item');
    const line=el('div',null);line.append(el('b',null,(stageNames[rec.from]||rec.from)+' → '+(stageNames[rec.to]||rec.to)));
    if(rec.gate)line.append(el('span','mono','  '+rec.gate+(rec.verdict&&rec.verdict.passed?' 通过':' 未通过')));
    item.append(line,el('div','mono',new Date(rec.at).toLocaleString()+(rec.note?' · '+rec.note:'')));
    if(rec.verdict&&!rec.verdict.passed&&rec.verdict.blocking.length){item.append(el('div','mono','拦截：'+rec.verdict.blocking.join('; ')));}
    h.append(item);
  }
  $('taskCount').textContent=String(s.tasks.length);
  const t=$('tasks');t.replaceChildren();
  if(!s.tasks.length)t.append(el('div','empty','还没有任务记录。'));
  for(const task of s.tasks){
    const item=el('div','item');
    item.append(el('b',null,task.taskId));
    item.append(el('div','mono',task.files.join(' · ')));
    if(task.failure){item.append(el('div','mono','失败：'+(task.failure.reason||'')+' — '+(task.failure.detail||'')));}
    t.append(item);
  }
}
function renderStageMap(s){
  const map=$('stageMap');if(!map)return;
  map.replaceChildren();
  const order=Object.keys(stageNames).filter(k=>k!=='BLOCKED');
  const idx=order.indexOf(s.stage);
  order.forEach((name,i)=>{
    const row=el('div','stage-row');
    if(i<idx)row.className='stage-row done';
    else if(i===idx)row.className='stage-row current';
    if(s.stage==='BLOCKED'&&i===idx-1)row.className='stage-row blocked';
    row.append(el('span','stage-idx',String(i+1).padStart(2,'0')));
    row.append(el('span','stage-name',stageNames[name]));
    if(i===idx)row.append(el('span','stage-state','ACTIVE'));
    map.append(row);
    if(i<order.length-1)map.append(el('div','stage-connector'));
  });
}
/**
 * The form keeps its own model. Loading from the server only happens once, so
 * a half-typed requirement is not overwritten by the 3-second refresh.
 */
const form={requirements:[],tasks:[]};
function reqRow(req,ri){
  const box=el('div','req');
  const head=el('div','item-head');
  head.append(el('b',null,req.req_id||'新需求'));
  const rm=el('button','ghost','删除');
  rm.onclick=()=>{form.requirements.splice(ri,1);drawForm();};
  head.append(rm);box.append(head);

  const idIn=el('input');idIn.value=req.req_id||'';idIn.placeholder='REQ-1';
  idIn.oninput=()=>{req.req_id=idIn.value;};
  const stIn=el('textarea');stIn.value=req.statement||'';stIn.placeholder='这条需求要解决什么';
  stIn.oninput=()=>{req.statement=stIn.value;};
  box.append(el('p','label','需求编号'),idIn,el('p','label','描述'),stIn);

  const acBox=el('div','ac-list');
  (req.acceptance||[]).forEach((ac,ai)=>{
    const a=el('div','ac');
    const ah=el('div','item-head');
    ah.append(el('b',null,ac.ac_id||'新验收项'));
    const ar=el('button','ghost','删除');
    ar.onclick=()=>{req.acceptance.splice(ai,1);drawForm();};
    ah.append(ar);a.append(ah);
    const acId=el('input');acId.value=ac.ac_id||'';acId.placeholder='AC-1';
    acId.oninput=()=>{ac.ac_id=acId.value;};
    const desc=el('input');desc.value=ac.description||'';desc.placeholder='怎么算通过';
    desc.oninput=()=>{ac.description=desc.value;};
    const kind=el('input');kind.value=ac.kind||'automated';kind.placeholder='automated 或 manual';
    kind.oninput=()=>{ac.kind=kind.value;ac.requirement_id=req.req_id;};
    const cmd=el('input');cmd.value=ac.verification_command||'';cmd.placeholder='自动检查用的命令';
    cmd.oninput=()=>{ac.verification_command=cmd.value;};
    a.append(el('p','label','验收编号'),acId,el('p','label','描述'),desc,el('p','label','类型'),kind,el('p','label','命令（automated 必填）'),cmd);
    acBox.append(a);
  });
  const addAc=el('button','ghost','+ 加验收项');
  addAc.onclick=()=>{(req.acceptance=req.acceptance||[]).push({ac_id:'',requirement_id:req.req_id||'',description:'',kind:'automated',verification_command:''});drawForm();};
  acBox.append(addAc);
  box.append(acBox);
  return box;
}
function taskRow(task,ti){
  const box=el('div','req');
  const head=el('div','item-head');
  head.append(el('b',null,task.role),el('span','mono','  '+(task.task_id||'')));
  const rm=el('button','ghost','删除');
  rm.onclick=()=>{form.tasks.splice(ti,1);drawForm();};
  head.append(rm);box.append(head);
  const mk=(label,key,placeholder)=>{const i=el('input');i.value=task[key]||'';i.placeholder=placeholder;i.oninput=()=>{task[key]=i.value;};return [el('p','label',label),i];};
  const idI=mk('任务编号','task_id','T-1');
  const roleI=mk('角色','role','developer / tester / reviewer');
  const objI=mk('目标','objective','要做什么');
  const pathsI=mk('可写目录（逗号分隔）','allowed_paths','src, test');
  const delivI=mk('交付物（逗号分隔）','deliverables','src/x.js');
  const acsI=mk('验收编号（逗号分隔）','acceptance_ids','AC-1');
  const depsI=mk('依赖任务（逗号分隔）','dependencies','T-0');
  for(const pair of [idI,roleI,objI,pathsI,delivI,acsI,depsI])box.append(...pair);
  // Array fields need splitting on comma; bind once after the inputs exist.
  pathsI[1].oninput=()=>{task.allowed_paths=pathsI[1].value.split(',').map(s=>s.trim()).filter(Boolean);};
  delivI[1].oninput=()=>{task.deliverables=delivI[1].value.split(',').map(s=>s.trim()).filter(Boolean);};
  acsI[1].oninput=()=>{task.acceptance_ids=acsI[1].value.split(',').map(s=>s.trim()).filter(Boolean);};
  depsI[1].oninput=()=>{task.dependencies=depsI[1].value.split(',').map(s=>s.trim()).filter(Boolean);};
  return box;
}
function drawForm(){
  const rl=$('reqList');rl.replaceChildren();
  if(!form.requirements.length)rl.append(el('div','empty','还没有需求。点下面的按钮加一条。'));
  form.requirements.forEach((r,i)=>rl.append(reqRow(r,i)));
  const tf=$('taskForm');tf.replaceChildren();
  if(!form.tasks.length)tf.append(el('div','empty','还没有任务。点下面的按钮加一个。'));
  form.tasks.forEach((t,i)=>tf.append(taskRow(t,i)));
}
function renderProject(project){
  const badge=$('projState');
  if(!project){badge.textContent='未配置';badge.className='badge warn';return;}
  badge.textContent=project.name;badge.className='badge';
  if(!projectLoaded){
    $('pName').value=project.name;
    $('pRepo').value=project.repo_path;
    $('pModel').value=project.model;
    $('pSandbox').value=project.sandbox;
    form.requirements=JSON.parse(JSON.stringify(project.requirements||[]));
    form.tasks=JSON.parse(JSON.stringify(project.tasks||[]));
    drawForm();
    projectLoaded=true;
  }
}
function renderTasks(s){
  const list=$('taskList');
  if(!s.project){list.replaceChildren(el('div','empty','先保存项目配置。'));return;}
  const fingerprint=JSON.stringify([s.project.tasks.map(t=>t.task_id),s.running,s.lastRun]);
  if(list.dataset.fp===fingerprint)return;
  list.dataset.fp=fingerprint;
  list.replaceChildren();
  for(const task of s.project.tasks){
    const item=el('div','item');
    const head=el('div');
    head.append(el('b',null,task.role),el('span','mono','  '+task.task_id));
    item.append(head,el('div','mono',task.objective.slice(0,160)));
    const btn=el('button',null,'运行这个任务');
    btn.style.marginTop='8px';
    btn.disabled=!!s.running;
    btn.onclick=()=>runTask(task.task_id);
    item.append(btn);
    list.append(item);
  }
}
function renderRunning(running,lastRun,outputLines){
  const badge=$('runState');
  const outBox=$('outputCard');
  if(running){
    // A plan's taskId is the literal "PLAN"; currentTask is the task actually
    // in flight. Show both so the badge never claims a plan is a single task.
    const shown=running.currentTask&&running.currentTask!==running.taskId
      ?running.taskId+' › '+running.currentTask
      :(running.currentTask||running.taskId);
    badge.textContent='运行中：'+shown+(running.cancelling?'（正在取消）':'');badge.className='badge warn';
    outBox.hidden=false;$('cancelBtn').disabled=running.cancelling;
    $('output').textContent=(outputLines||[]).join('').slice(-2000);
    return;
  }
  if(lastRun){
    badge.textContent=(lastRun.ok?'完成':'失败')+'：'+lastRun.taskId;badge.className='badge'+(lastRun.ok?'':' bad');
    if(outputLines&&outputLines.length){outBox.hidden=false;$('output').textContent=outputLines.join('').slice(-2000);}
    return;
  }
  badge.textContent='空闲';badge.className='badge';
}
$('cancelBtn').onclick=async()=>{
  const m=$('actionMsg');
  const r=await fetch('/api/cancel',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=v.error||'取消失败';return;}
  m.className='msg';m.textContent='已请求取消';load();
};
async function runTask(taskId){
  const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId})});
  const v=await r.json();
  const m=$('actionMsg');
  if(!r.ok){m.className='msg err';m.textContent=v.error||'启动失败';return;}
  m.className='msg';m.textContent='已启动，任务在后台跑，页面每 3 秒刷新';load();
}
$('runPlanBtn').onclick=async()=>{
  const m=$('actionMsg');
  const r=await fetch('/api/run-plan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=v.error||'启动失败';return;}
  m.className='msg';m.textContent='已启动整个计划，后台按依赖顺序跑';load();
};
$('saveProject').onclick=async()=>{
  const m=$('projMsg');
  // Fill the fields the form cannot show, then send the whole model. The
  // server validates it; the browser does not try to be clever about shape.
  const requirements=form.requirements.map(r=>({
    ...r,
    acceptance:(r.acceptance||[]).map(a=>({
      ...a,
      requirement_id:r.req_id,
      ...(a.kind==='manual'?{manual_check:a.manual_check||{owner:'He',procedure:'人工确认'}}:{}),
      ...(a.kind==='automated'&&!a.verification_command?{}:{}),
    })),
  }));
  const tasks=form.tasks.map(t=>({
    ...t,
    repo_path:$('pRepo').value.trim(),
    base_revision:t.base_revision||'init',
    allowed_paths:t.allowed_paths||[],
    deliverables:t.deliverables&&t.deliverables.length?t.deliverables:['(none)'],
    acceptance_ids:t.acceptance_ids||[],
    verification_commands:t.verification_commands||[],
  }));
  const body={name:$('pName').value.trim(),repo_path:$('pRepo').value.trim(),model:$('pModel').value.trim(),sandbox:$('pSandbox').value.trim()||'bypass',requirements,tasks};
  const r=await fetch('/api/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=v.error||'保存失败';return;}
  m.className='msg';m.textContent='已保存';projectLoaded=false;load();
};
$('addReq').onclick=()=>{form.requirements.push({req_id:'',statement:'',acceptance:[]});drawForm();};
$('addTask').onclick=()=>{form.tasks.push({task_id:'',role:'developer',objective:'',allowed_paths:[],deliverables:[],acceptance_ids:[],dependencies:[]});drawForm();};
$('exportJson').onclick=()=>{
  const payload={
    name:$('pName').value.trim(),repo_path:$('pRepo').value.trim(),
    model:$('pModel').value.trim(),sandbox:$('pSandbox').value.trim()||'bypass',
    requirements:form.requirements,tasks:form.tasks,
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=el('a');a.href=URL.createObjectURL(blob);a.download='project-config.json';a.click();
  URL.revokeObjectURL(a.href);
};
$('importJson').onclick=()=>{$('importFile').click();};
$('importFile').onchange=async(e)=>{
  const file=e.target.files[0];
  if(!file)return;
  const text=await file.text();
  const m=$('projMsg');
  try{
    const data=JSON.parse(text);
    if(data.name)$('pName').value=data.name;
    if(data.repo_path)$('pRepo').value=data.repo_path;
    if(data.model)$('pModel').value=data.model;
    if(data.sandbox)$('pSandbox').value=data.sandbox;
    form.requirements=JSON.parse(JSON.stringify(data.requirements||[]));
    form.tasks=JSON.parse(JSON.stringify(data.tasks||[]));
    projectLoaded=false;drawForm();
    m.className='msg';m.textContent='已导入，检查后点保存';
  }catch(err){m.className='msg err';m.textContent='导入失败：'+err.message;}
  e.target.value='';
};
let historyFilterValue='';
$('historyFilter').oninput=(e)=>{historyFilterValue=e.target.value.trim().toLowerCase();};
drawForm();
async function post(route,body){
  const r=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const v=await r.json();const m=$('actionMsg');
  if(!r.ok){m.className='msg err';m.textContent=v.error||v.refused?.detail||'操作失败';return;}
  m.className='msg';m.textContent='已记录';load();
}
$('releaseBtn').onclick=()=>post('/api/release',{to:$('releaseTo').value.trim(),from:lastBlockedFrom,note:$('releaseNote').value.trim()||'人工放行'});
$('blockBtn').onclick=()=>post('/api/block',{note:$('releaseNote').value.trim()||'人工阻塞'});
load();setInterval(load,3000);
</script></body></html>`;
