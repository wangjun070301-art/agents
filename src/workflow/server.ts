import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Pipeline } from "./pipeline.js";
import type { Stage, TaskEnvelope } from "./contracts.js";
import {
  readProject,
  writeProject,
  codexHomeFor,
  defaultCodexPath,
  describeProjectError,
  type Project,
} from "./project.js";
import { CodexAdapter } from "./adapters/codex.js";
import { redactSecrets } from "./adapters/codex.js";
import { Scheduler } from "./scheduler.js";
import { LEGAL_TRANSITIONS, gateFor } from "./states.js";
import { evaluateGate } from "./gates.js";
import { detectEnvironment } from "./environment.js";
import { detectAgents, readBindings, writeBindings, agentForRole, ROLES, type RoleBindings } from "./agents.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import type { WorkflowAdapter } from "./adapters.js";

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
  /**
   * Probed once at startup. Codex installs and auth do not change while the
   * panel is open, and re-probing on every 3-second poll would spawn `where`.
   */
  const environment = detectEnvironment();
  /**
   * Agents are probed once too: the binaries and their versions do not change
   * while the panel is open.
   */
  const agents = detectAgents();
  /** A run in flight, with the adapter so the UI can cancel it. */
  let active: {
    taskId: string;
    adapter: WorkflowAdapter | null;
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
    environment,
    agents,
    bindings: readBindings(stateDir),
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
          send(res, 400, JSON.stringify({ error: describeProjectError(error) }));
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agents") {
      readJson(req)
        .then((body) => {
          const bindings = writeBindings(stateDir, body);
          send(res, 200, JSON.stringify({ ok: true, bindings }));
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
/**
 * The agent that runs a task, chosen by the role it was given.
 *
 * A task's role is a capability slot; the binding says which agent fills that
 * slot. Unbound roles fall back to Codex, so an untouched install behaves
 * exactly as before.
 */
function buildAdapterFor(
  project: Project,
  task: Project["tasks"][number],
  stateDir: string,
  codexPath: string | undefined,
  onOutput?: (chunk: string) => void,
): WorkflowAdapter {
  const bindings = readBindings(stateDir);
  const agent = agentForRole(bindings, task.role);

  if (agent === "claude") {
    const binary = detectAgents().find((a) => a.id === "claude")?.binary;
    if (!binary) {
      throw new Error("角色 " + task.role + " 绑定了 Claude Code，但这台机器上找不到 claude 命令");
    }
    return new ClaudeAdapter({
      claudePath: binary,
      repoPath: task.repo_path,
      model: project.model,
      ...(onOutput ? { onOutput } : {}),
    });
  }

  if (agent !== "codex") {
    throw new Error(
      "角色 " + task.role + " 绑定了 " + agent + "，这个 agent 在当前机器上还不能执行任务",
    );
  }

  const home = codexHomeFor(stateDir);
  fs.mkdirSync(home, { recursive: true });
  // The adapter needs a writable CODEX_HOME with auth in it. Copy the user's
  // once, so a run does not depend on the live home being writable.
  for (const file of ["auth.json", "config.toml", "cc-switch-model-catalog.json"]) {
    const from = path.join(process.env.USERPROFILE ?? "", ".codex", file);
    const to = path.join(home, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  return new CodexAdapter({
    codexPath: codexPath ?? defaultCodexPath(),
    codexHome: home,
    model: project.model,
    sandbox: project.sandbox,
    observeWorktree: true,
    ...(onOutput ? { onOutput } : {}),
  });
}

async function executeTask(
  project: Project,
  task: Project["tasks"][number],
  stateDir: string,
  codexPath: string | undefined,
  hooks?: {
    onCreated?: (adapter: WorkflowAdapter) => void;
    onTaskStart?: (taskId: string) => void;
    isCancelled?: () => boolean;
    onOutput?: (chunk: string) => void;
  },
): Promise<{ ok: boolean; failure?: unknown }> {
  const adapter = buildAdapterFor(project, task, stateDir, codexPath, hooks?.onOutput);
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
/**
 * One adapter that dispatches each task to the agent bound to its role.
 *
 * A plan mixes roles, so a single concrete adapter cannot serve it. This
 * wrapper builds the right adapter per task, keeps it for resume and cancel,
 * and forwards evidence to whichever adapter actually ran the task.
 */
function roleRoutingAdapter(
  project: Project,
  stateDir: string,
  codexPath: string | undefined,
  onOutput?: (chunk: string) => void,
): WorkflowAdapter & { cancel(taskId: string): Promise<void> } {
  const used = new Map<string, WorkflowAdapter>();

  return {
    id: "role-router",
    label: "按角色分派",
    async capabilityCheck() {
      return {
        adapter_id: "role-router",
        version: "1",
        available: true,
        models: [],
        working_directories: [project.repo_path],
        can_run_tests: true,
        can_resume: true,
        detail: "按每个任务的角色选择 agent",
      };
    },
    async execute(envelope: TaskEnvelope) {
      const adapter = buildAdapterFor(project, envelope, stateDir, codexPath, onOutput);
      used.set(envelope.task_id, adapter);
      return adapter.execute(envelope);
    },
    async resume(taskId: string, feedback: string) {
      const adapter = used.get(taskId);
      if (!adapter) throw new Error(`没有记录 ${taskId} 用的是哪个 agent`);
      return adapter.resume(taskId, feedback);
    },
    async cancel(taskId: string) {
      await used.get(taskId)?.cancel(taskId);
    },
    async collectEvidence(taskId: string) {
      const adapter = used.get(taskId);
      if (!adapter) throw new Error(`没有记录 ${taskId} 用的是哪个 agent`);
      return adapter.collectEvidence(taskId);
    },
  };
}

async function executePlan(
  project: Project,
  stateDir: string,
  codexPath: string | undefined,
  hooks?: {
    onCreated?: (adapter: WorkflowAdapter) => void;
    onTaskStart?: (taskId: string) => void;
    isCancelled?: () => boolean;
    onOutput?: (chunk: string) => void;
  },
): Promise<{ completed: string[]; failed: Array<{ taskId: string; reason: string }>; skipped: Array<{ taskId: string; because: string }> }> {
  // A plan mixes roles, so the adapter is chosen per task, not once up front.
  const adapter = roleRoutingAdapter(project, stateDir, codexPath, hooks?.onOutput);
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
  --bg:#0B1016;--panel:#121A24;--panel2:#182432;
  --accent:#4FC3F7;--ok:#4ADE80;--warn:#FBBF24;--bad:#F87171;
  --ink:#E4EDF5;--muted:#8598AB;--line:#22303F;
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--ink);background:var(--bg)
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);font-size:14px;line-height:1.7}
button,input,textarea,select{font:inherit}
button{cursor:pointer;border:0}
button:disabled{opacity:.4;cursor:default}
code{background:#1B2735;padding:1px 5px;border-radius:4px;font-size:12px;color:#9FD5F5}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 28px;border-bottom:1px solid var(--line);background:var(--panel);
  position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:12px}
.brand .logo{width:34px;height:34px;border-radius:8px;background:#1B2735;
  border:1px solid var(--line);display:grid;place-items:center;
  font-weight:700;font-size:15px;color:var(--accent)}
.brand h1{font-size:16px;margin:0;font-weight:600}
.brand .tag{font-size:11px;color:var(--muted);margin-top:1px}
.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.status-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;
  padding:5px 12px;border-radius:999px;background:var(--panel2);border:1px solid var(--line)}
.status-pill .dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}

.wrap{padding:22px 28px 60px;max-width:980px;margin:0 auto}

.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  margin-bottom:16px;overflow:hidden}
.step{box-shadow:0 1px 3px rgba(0,0,0,.25)}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel2)}
.step-title{display:flex;align-items:center;gap:12px}
.step-no{width:26px;height:26px;border-radius:50%;background:var(--accent);
  color:#0B1016;font-weight:700;font-size:13px;display:grid;place-items:center;flex-shrink:0}
.step-title h2{font-size:15px;margin:0;font-weight:600}
.head .hint{font-size:12px;color:var(--muted)}
.body{padding:18px 20px}
.lead{margin:0 0 16px;color:var(--muted);font-size:13px}
.sub-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}

.label{font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:500}
.hintline{font-size:12px;color:var(--muted);margin:5px 0 0;opacity:.85}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}

input,textarea,select{width:100%;border:1px solid var(--line);border-radius:8px;
  padding:9px 12px;color:var(--ink);background:#0E1620;outline:none;font-size:13px}
input:focus,textarea:focus,select:focus{border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(79,195,247,.12)}
textarea{resize:vertical;line-height:1.6;min-height:64px}
input::placeholder,textarea::placeholder{color:#4E6076}

.btn{border-radius:8px;padding:9px 18px;font-size:13px;font-weight:600;
  background:var(--accent);color:#0B1016}
.btn:hover{filter:brightness(1.1)}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.btn.ghost:hover{color:var(--ink);border-color:#2F4356}
.btn.danger{background:transparent;color:var(--bad);border:1px solid #5A2A2A}
.btn.sm{padding:5px 12px;font-size:12px}
.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.msg{font-size:13px;margin-top:12px;color:var(--ok)}
.msg.err{color:var(--bad)}
.empty{padding:26px 12px;text-align:center;color:var(--muted);font-size:13px}
.mono{font-family:Consolas,monospace;font-size:12px}

.badge{display:inline-block;font-size:11px;padding:3px 10px;border-radius:999px;
  background:rgba(74,222,128,.12);color:var(--ok);border:1px solid rgba(74,222,128,.3);font-weight:600}
.badge.warn{background:rgba(251,191,36,.12);color:var(--warn);border-color:rgba(251,191,36,.35)}
.badge.bad{background:rgba(248,113,113,.12);color:var(--bad);border-color:rgba(248,113,113,.35)}
.badge.idle{background:var(--panel2);color:var(--muted);border-color:var(--line)}

/* 需求 / 任务卡片 */
.req{border:1px solid var(--line);border-radius:10px;padding:14px;
  margin-bottom:12px;background:#0E1620}
.item-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}
.item-head b{color:var(--accent);font-size:13px}
.ac-list{margin-top:10px;padding-left:14px;border-left:2px solid var(--line)}
.ac{border:1px solid var(--line);border-radius:8px;padding:11px;
  margin-bottom:10px;background:#121A24}
.req input,.req textarea{font-size:13px;padding:8px 10px}
.req .label{margin:9px 0 4px;font-size:11px}

/* 阶段地图 */
.stage-map{display:flex;flex-direction:column}
.stage-row{display:flex;align-items:center;gap:10px;padding:5px 8px;
  border-radius:6px;border:1px solid transparent;font-size:13px}
.stage-row.done{color:var(--muted)}
.stage-row.current{background:rgba(79,195,247,.08);border-color:#2E5A76;color:var(--accent);font-weight:600}
.stage-row.blocked{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.4);color:var(--warn)}
.stage-idx{width:22px;height:22px;border-radius:50%;background:#0E1620;
  border:1px solid var(--line);display:grid;place-items:center;font-size:10px;color:var(--muted);flex-shrink:0}
.stage-row.done .stage-idx{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.4);color:var(--ok)}
.stage-row.current .stage-idx{background:var(--accent);border-color:var(--accent);color:#0B1016;font-weight:700}
.stage-row.blocked .stage-idx{background:var(--warn);border-color:var(--warn);color:#0B1016}
.stage-name{flex:1}
.stage-state{font-size:10px;color:var(--muted)}
.stage-connector{width:2px;height:4px;margin-left:18px;background:var(--line)}

/* 门禁 */
.gates{display:flex;gap:6px;flex-wrap:wrap}
.gate{font-size:11px;padding:4px 10px;border-radius:5px;background:#0E1620;
  border:1px solid var(--line);color:var(--muted);font-weight:600}
.gate.on{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.4);color:var(--ok)}

/* 历史 */
.timeline{position:relative;padding-left:18px}
.timeline::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;
  width:2px;background:var(--line)}
.item{padding:9px 0 9px 2px;position:relative}
.item::before{content:'';position:absolute;left:-15px;top:15px;width:8px;height:8px;
  border-radius:50%;background:var(--panel);border:2px solid var(--line)}
.item b{font-size:13px}
.item .mono{color:var(--muted);margin-top:2px}

/* 输出 */
.output-box{background:#080D13;border:1px solid var(--line);border-radius:8px;
  padding:12px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;
  max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#A9C4D8}

/* 折叠区 */
.fold{background:var(--panel)}
.fold summary{display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:13px 20px;cursor:pointer;list-style:none;
  background:var(--panel2);font-weight:500}
.fold summary::-webkit-details-marker{display:none}
.fold summary::before{content:'▸';color:var(--muted);margin-right:8px;transition:transform .15s}
.fold[open] summary::before{transform:rotate(90deg)}
.fold-title{flex:1;font-size:14px}

@media(max-width:820px){
  .wrap{padding:16px}
  .grid2{grid-template-columns:1fr}
  .brand .tag{display:none}
}

/* agent 列表与角色分派 */
.agent-list{display:flex;flex-direction:column;gap:8px}
.agent{display:flex;align-items:center;gap:12px;padding:11px 14px;
  border:1px solid var(--line);border-radius:9px;background:#0E1620}
.agent .name{font-weight:600;font-size:13px;min-width:130px}
.agent .ver{font-size:11px;color:var(--muted);font-family:Consolas,monospace}
.agent .why{font-size:11px;color:var(--warn);flex:1}
.agent.ok{border-color:rgba(74,222,128,.3)}
.agent.off{opacity:.62}
.dot-ok{width:8px;height:8px;border-radius:50%;background:var(--ok);flex-shrink:0}
.dot-off{width:8px;height:8px;border-radius:50%;background:#5A6B7D;flex-shrink:0}

.role-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.role-row{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:#0E1620}
.role-row .rname{font-size:13px}
.role-row select{width:auto;min-width:140px;padding:6px 10px;font-size:12px}

@media(max-width:820px){
  .role-grid{grid-template-columns:1fr}
}
</style></head><body>
<div class="topbar">
  <div class="brand"><div class="logo">AO</div><div><h1>流水线控制台</h1><div class="tag">四步走完一个任务</div></div></div>
  <div class="top-actions">
    <span class="status-pill"><span class="dot"></span>已连接</span>
    <span class="status-pill" id="runState">空闲</span>
    <button class="btn ghost sm" id="exportJson">导出配置</button>
    <button class="btn ghost sm" id="importJson">导入配置</button>
    <input id="importFile" type="file" accept="application/json,.json" hidden>
  </div>
</div>

<div class="wrap">

  <!-- 第 0 步：选 agent -->
  <section class="card step">
    <div class="head">
      <div class="step-title"><span class="step-no">0</span><h2>谁来干活</h2></div>
      <span class="hint">本机已安装的 agent</span>
    </div>
    <div class="body">
      <p class="lead">每个角色交给一个 agent。不选就默认用 Codex。</p>
      <div class="agent-list" id="agentList"></div>
      <p class="label" style="margin-top:16px">角色分派</p>
      <div class="role-grid" id="roleGrid"></div>
      <div class="actions"><button class="btn" id="saveAgents">保存分派</button></div>
      <div class="msg" id="agentMsg"></div>
    </div>
  </section>

  <!-- 第 1 步 -->
  <section class="card step">
    <div class="head">
      <div class="step-title"><span class="step-no">1</span><h2>选一个项目</h2></div>
      <span class="badge idle" id="projState">未配置</span>
    </div>
    <div class="body">
      <p class="lead">先告诉它要在哪个代码目录里干活。</p>

      <div class="env" id="envBox">正在检测本机环境…</div>

      <div class="grid2">
        <div>
          <p class="label">项目名称</p>
          <input id="pName" placeholder="随便起，例如 myproj">
          <p class="hintline">只用来显示，不影响执行。</p>
        </div>
        <div>
          <p class="label">权限模式</p>
          <select id="pSandbox"></select>
          <p class="hintline">bypass 让子进程能执行命令；其余两种只能读或只能改工作区。</p>
        </div>
      </div>

      <p class="label">代码目录（绝对路径，必须已存在）</p>
      <input id="pRepo" placeholder="C:\work\myproj">
      <p class="hintline">例：<code>C:\work\myproj</code>。填错会直接报「目录不存在」。</p>

      <p class="label">模型</p>
      <select id="pModel"></select>
      <p class="hintline" id="modelHint">从本机模型目录读取，不用手填。</p>

      <div class="actions"><button class="btn" id="saveProject">保存项目</button></div>
      <div class="msg" id="projMsg"></div>
    </div>
  </section>

  <!-- 第 2 步 -->
  <section class="card step">
    <div class="head">
      <div class="step-title"><span class="step-no">2</span><h2>说清要做什么</h2></div>
      <span class="hint">需求 + 怎么算通过</span>
    </div>
    <div class="body">
      <p class="lead">一条需求配一个验收项：一条说「要什么」，一条说「怎么算做到」。</p>
      <div id="reqList"></div>
      <div class="actions"><button class="btn ghost" id="addReq">+ 加一条需求</button></div>
    </div>
  </section>

  <!-- 第 3 步 -->
  <section class="card step">
    <div class="head">
      <div class="step-title"><span class="step-no">3</span><h2>拆成几个任务</h2></div>
      <span class="hint">每个任务交给一个子进程做</span>
    </div>
    <div class="body">
      <p class="lead">任务按依赖顺序执行。有依赖的填「依赖任务」，没有就留空。</p>
      <div id="taskForm"></div>
      <div class="actions"><button class="btn ghost" id="addTask">+ 加一个任务</button></div>
    </div>
  </section>

  <!-- 第 4 步 -->
  <section class="card step">
    <div class="head">
      <div class="step-title"><span class="step-no">4</span><h2>跑起来</h2></div>
      <span class="hint">跑完会自动推进阶段</span>
    </div>
    <div class="body">
      <p class="lead">保存过项目之后，这里会列出任务。点「开始执行」按依赖顺序跑完整份计划。</p>
      <div id="taskList"><div class="empty">先在第 1 步保存项目。</div></div>
      <div class="actions"><button class="btn" id="runPlanBtn" style="width:100%">▶ 开始执行</button></div>

      <section id="outputCard" hidden style="margin-top:14px">
        <div class="sub-head">
          <span class="label" style="margin:0">实时输出</span>
          <button class="btn danger sm" id="cancelBtn">中断</button>
        </div>
        <div class="output-box" id="output"></div>
      </section>
    </div>
  </section>

  <!-- 折叠区 -->
  <details class="card fold">
    <summary><span class="fold-title">流水线进度</span><span class="badge" id="state">读取中</span></summary>
    <div class="body">
      <p class="hintline" id="stageHint"></p>
      <div class="stage-map" id="stageMap"></div>
      <p class="label" style="margin-top:14px">质量门禁</p>
      <div class="gates" id="gates"></div>
      <p class="label" style="margin-top:16px">可推进到</p>
      <div class="actions" id="nextStages"></div>
      <div id="releaseBox" hidden>
        <p class="label" style="margin-top:14px">放行回哪个阶段</p>
        <input id="releaseTo" placeholder="例如 IMPLEMENT">
        <p class="label" style="margin-top:10px">为什么可以继续（会记入历史）</p>
        <textarea id="releaseNote" placeholder="写清原因，别写空话"></textarea>
        <div class="actions"><button class="btn" id="releaseBtn">放行</button><button class="btn danger" id="blockBtn">强制阻塞</button></div>
      </div>
    </div>
  </details>

  <details class="card fold">
    <summary><span class="fold-title">历史记录</span><span class="badge" id="count">0</span></summary>
    <div class="body">
      <input id="historyFilter" placeholder="筛选：阶段 / 门禁 / 备注">
      <div class="timeline" id="history" style="margin-top:10px"><div class="empty">还没有阶段变化。</div></div>
    </div>
  </details>

  <details class="card fold">
    <summary><span class="fold-title">运行记录</span><span class="badge" id="taskCount">0</span></summary>
    <div class="body" id="tasks"><div class="empty">还没有任务记录。</div></div>
  </details>

  <div class="msg" id="actionMsg"></div>
</div>
<script>
const $=id=>document.getElementById(id);
const stageNames={INTAKE:'接单',CLARIFY:'澄清',BASELINE:'基线',SPEC:'需求规格',PLAN:'计划',DISPATCH:'派工',IMPLEMENT:'实现',REVIEW:'审查',VERIFY:'验证',INTEGRATE:'集成',ACCEPT:'验收',DELIVER:'交付',ARCHIVE:'归档',BLOCKED:'已阻塞'};
const gateOrder=['G0','G1','G2','G3','G4','G5'];
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const hint=(text)=>el('p','hintline',text);
let lastBlockedFrom=null;
let projectLoaded=false;
let historyFilterValue='';
let agentsLoaded=false;
let roleDraft={};

/* ---------- 第 0 步：agent 与角色 ---------- */
const roleNames={analyst:'分析',architect:'架构',developer:'实现',reviewer:'审查',tester:'测试',integrator:'集成'};

function renderAgents(s){
  const list=$('agentList');
  if(!s.agents){list.textContent='读取中…';return;}
  list.replaceChildren();
  for(const a of s.agents){
    const row=el('div','agent '+(a.available?'ok':'off'));
    row.append(el('span',a.available?'dot-ok':'dot-off'));
    row.append(el('span','name',a.label));
    if(a.version)row.append(el('span','ver',a.version));
    if(!a.available)row.append(el('span','why',a.reason));
    list.append(row);
  }

  const grid=$('roleGrid');
  if(!agentsLoaded){
    roleDraft={...(s.bindings||{})};
    grid.replaceChildren();
    for(const role of Object.keys(roleNames)){
      const row=el('div','role-row');
      row.append(el('span','rname',roleNames[role]));
      const sel=el('select');
      const def=el('option',null,'默认（Codex）');def.value='';sel.append(def);
      for(const a of s.agents){
        const o=el('option',null,a.label+(a.available?'':'（不可用）'));
        o.value=a.id;
        sel.append(o);
      }
      sel.value=roleDraft[role]||'';
      sel.onchange=()=>{
        if(sel.value)roleDraft[role]=sel.value;else delete roleDraft[role];
      };
      row.append(sel);
      grid.append(row);
    }
    agentsLoaded=true;
  }
}

$('saveAgents').onclick=async()=>{
  const m=$('agentMsg');
  const r=await fetch('/api/agents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(roleDraft)});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=v.error||'保存失败';return;}
  m.className='msg';m.textContent='分派已保存';
  agentsLoaded=false;
  load();
};

/* ---------- 第 1 步：项目 ---------- */
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

$('saveProject').onclick=async()=>{
  const m=$('projMsg');
  // Check what the form already knows before spending a round trip. The
  // server validates too, but a blank form should say which box is blank.
  const missing=[];
  if(!$('pName').value.trim())missing.push('项目名称');
  if(!$('pRepo').value.trim())missing.push('代码目录');
  if(!$('pModel').value.trim())missing.push('模型');
  if(!form.requirements.length)missing.push('至少一条需求');
  if(!form.tasks.length)missing.push('至少一个任务');
  if(missing.length){
    m.className='msg err';
    m.textContent='还缺：'+missing.join('、')+'。填完再保存。';
    return;
  }
  const requirements=form.requirements.map(r=>({
    ...r,
    acceptance:(r.acceptance||[]).map(a=>({
      ...a,
      requirement_id:r.req_id,
      ...(a.kind==='manual'?{manual_check:a.manual_check||{owner:'He',procedure:'人工确认'}}:{}),
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
  const body={
    name:$('pName').value.trim(),
    repo_path:$('pRepo').value.trim(),
    model:$('pModel').value.trim(),
    sandbox:$('pSandbox').value.trim()||'bypass',
    requirements,tasks,
  };
  const r=await fetch('/api/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=translateError(v.error||'保存失败');return;}
  m.className='msg';m.textContent='已保存';projectLoaded=false;load();
};

/* 把后端英文报错翻成人话 */
function translateError(text){
  // A Zod dump arrives as a JSON array; the server already turns it into
  // sentences, but an older server may still send the raw form.
  if(/^\s*\[/.test(text)){
    try{
      const issues=JSON.parse(text);
      const labels={name:'项目名称',repo_path:'代码目录',model:'模型',sandbox:'沙箱',
                    requirements:'需求',tasks:'任务'};
      const parts=issues.map(i=>{
        const k=String(i.path?.[0]??'');
        const label=labels[k]||k;
        return i.code==='too_small'
          ?(i.type==='array'?label+'至少要有 1 条':label+'不能为空')
          :label;
      });
      if(parts.length)return '还缺：'+parts.join('、')+'。';
    }catch{}
  }
  if(/repo_path does not exist/.test(text))return '代码目录不存在，检查路径是否填对。';
  if(/no project configured/.test(text))return '还没有保存项目，先完成第 1 步。';
  if(/a run is already in progress/.test(text))return '已有任务在跑，等它结束或点中断。';
  if(/nothing is running/.test(text))return '当前没有任务在跑。';
  if(/gated by/.test(text))return '这一步有质量门禁，需要先跑任务产出证据。';
  if(/does not exist/.test(text))return '目录不存在：'+text;
  return text;
}

/* ---------- 第 2 步：需求 ---------- */
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
  const stIn=el('textarea');stIn.value=req.statement||'';stIn.placeholder='例如：让 add() 返回两数之和';
  stIn.oninput=()=>{req.statement=stIn.value;};

  box.append(el('p','label','需求编号'),idIn,
             hint('从 REQ-1 开始，往后递增。'),
             el('p','label','这条需求要解决什么'),stIn,
             hint('用一句话说清目标，别写实现细节。'));

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
    const desc=el('input');desc.value=ac.description||'';desc.placeholder='例如：add(1,2) 返回 3';
    desc.oninput=()=>{ac.description=desc.value;};

    const kind=el('select');
    [['automated','自动检查（跑命令）'],['manual','人工确认']].forEach(([v,t])=>{
      const o=el('option',null,t);o.value=v;kind.append(o);
    });
    kind.value=ac.kind||'automated';
    kind.onchange=()=>{ac.kind=kind.value;ac.requirement_id=req.req_id;drawForm();};

    a.append(el('p','label','验收编号'),acId,
             el('p','label','怎么算通过'),desc,
             hint('写成可判断的事实，不要写「做得好」。'),
             el('p','label','检查方式'),kind);

    if(ac.kind!=='manual'){
      const cmd=el('input');cmd.value=ac.verification_command||'';
      cmd.placeholder='例如：node --test';
      cmd.oninput=()=>{ac.verification_command=cmd.value;};
      a.append(el('p','label','跑哪条命令'),cmd,
               hint('必须真的输出测试结果。只打印 ok 的脚本会被门禁拒绝。'));
    }
    acBox.append(a);
  });

  const addAc=el('button','ghost','+ 加验收项');
  addAc.onclick=()=>{
    (req.acceptance=req.acceptance||[]).push({
      ac_id:'',requirement_id:req.req_id||'',description:'',kind:'automated',verification_command:''
    });
    drawForm();
  };
  acBox.append(addAc);
  box.append(acBox);
  return box;
}

/* ---------- 第 3 步：任务 ---------- */
function taskRow(task,ti){
  const box=el('div','req');
  const head=el('div','item-head');
  head.append(el('b',null,(task.task_id||'新任务')+' · '+(task.role||'developer')));
  const rm=el('button','ghost','删除');
  rm.onclick=()=>{form.tasks.splice(ti,1);drawForm();};
  head.append(rm);box.append(head);

  const mk=(label,key,placeholder,help)=>{
    const i=el('input');i.value=task[key]||'';i.placeholder=placeholder;
    i.oninput=()=>{task[key]=i.value;};
    const parts=[el('p','label',label),i];
    if(help)parts.push(hint(help));
    return parts;
  };
  const list=(label,key,placeholder,help,parse)=>{
    const i=el('input');i.value=(task[key]||[]).join(', ');i.placeholder=placeholder;
    i.oninput=()=>{task[key]=parse(i.value);};
    const parts=[el('p','label',label),i];
    if(help)parts.push(hint(help));
    return parts;
  };
  const comma=v=>v.split(',').map(s=>s.trim()).filter(Boolean);

  const roleSel=el('select');
  [['developer','developer · 写代码'],['tester','tester · 写测试'],['reviewer','reviewer · 审查']].forEach(([v,t])=>{
    const o=el('option',null,t);o.value=v;roleSel.append(o);
  });
  roleSel.value=task.role||'developer';
  roleSel.onchange=()=>{task.role=roleSel.value;drawForm();};

  box.append(...mk('任务编号','task_id','T-1','从 T-1 开始。'),
             el('p','label','角色'),roleSel,
             ...mk('这个任务要做什么','objective','例如：实现 add() 并写测试',''),
             ...list('允许修改哪些文件','allowed_paths','src/a.js, test/a.test.js',
                    '逗号分隔。写相对路径，越界的改动会被拦下。',comma),
             ...list('产出哪些文件','deliverables','src/a.js',
                    '逗号分隔。不改文件的任务填 (none)。',comma),
             ...list('对应哪些验收项','acceptance_ids','AC-1',
                    '逗号分隔，必须是第 2 步里存在的编号。',comma),
             ...list('依赖哪些任务','dependencies','T-0',
                    '逗号分隔。没有依赖就留空。',comma));
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

$('addReq').onclick=()=>{
  const n=form.requirements.length+1;
  form.requirements.push({req_id:'REQ-'+n,statement:'',acceptance:[
    {ac_id:'AC-'+n,requirement_id:'REQ-'+n,description:'',kind:'automated',verification_command:''}
  ]});
  drawForm();
};
$('addTask').onclick=()=>{
  const n=form.tasks.length+1;
  form.tasks.push({task_id:'T-'+n,role:'developer',objective:'',allowed_paths:[],deliverables:[],acceptance_ids:[],dependencies:[]});
  drawForm();
};

/* ---------- 第 4 步：运行 ---------- */
function renderTasks(s){
  const list=$('taskList');
  if(!s.project){list.replaceChildren(el('div','empty','先在第 1 步保存项目。'));return;}
  const fp=JSON.stringify([s.project.tasks.map(t=>t.task_id),s.running,s.lastRun]);
  if(list.dataset.fp===fp)return;
  list.dataset.fp=fp;
  list.replaceChildren();
  for(const task of s.project.tasks){
    const card=el('div','req');
    const head=el('div','item-head');
    head.append(el('b',null,stageRole(task.role)+' · '+task.task_id));
    card.append(head,el('div','mono',task.objective));
    const btn=el('button','ghost sm','只跑这个任务');
    btn.style.marginTop='10px';
    btn.disabled=!!s.running;
    btn.onclick=()=>runTask(task.task_id);
    card.append(btn);
    list.append(card);
  }
}
function stageRole(r){
  return ({developer:'开发者',tester:'测试',reviewer:'审查'})[r]||r;
}

function renderRunning(running,lastRun,outputLines){
  const badge=$('runState');
  const outBox=$('outputCard');
  if(running){
    const shown=running.currentTask&&running.currentTask!==running.taskId
      ?running.taskId+' › '+running.currentTask
      :(running.currentTask||running.taskId);
    badge.textContent='运行中：'+shown+(running.cancelling?'（正在取消）':'');
    badge.className='badge warn';
    outBox.hidden=false;
    $('cancelBtn').disabled=running.cancelling;
    $('output').textContent=(outputLines||[]).join('').slice(-4000);
    return;
  }
  if(lastRun){
    badge.textContent=(lastRun.ok?'完成':'失败')+'：'+lastRun.taskId;
    badge.className='badge'+(lastRun.ok?'':' bad');
    if(outputLines&&outputLines.length){
      outBox.hidden=false;
      $('output').textContent=outputLines.join('').slice(-4000);
    }
    return;
  }
  badge.textContent='空闲';badge.className='badge';
}

$('runPlanBtn').onclick=async()=>{
  const m=$('actionMsg');
  const r=await fetch('/api/run-plan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=translateError(v.error||'启动失败');return;}
  m.className='msg';m.textContent='已开始，按依赖顺序跑';
  load();
};
async function runTask(taskId){
  const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId})});
  const v=await r.json();
  const m=$('actionMsg');
  if(!r.ok){m.className='msg err';m.textContent=translateError(v.error||'启动失败');return;}
  m.className='msg';m.textContent='已开始跑 '+taskId;
  load();
}
$('cancelBtn').onclick=async()=>{
  const m=$('actionMsg');
  const r=await fetch('/api/cancel',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const v=await r.json();
  if(!r.ok){m.className='msg err';m.textContent=translateError(v.error||'取消失败');return;}
  m.className='msg';m.textContent='已请求中断，剩下的任务不会再派';
  load();
};

/* ---------- 折叠区 ---------- */
function renderStageMap(s){
  const map=$('stageMap');if(!map)return;
  map.replaceChildren();
  const order=Object.keys(stageNames).filter(k=>k!=='BLOCKED');
  const idx=order.indexOf(s.stage);
  order.forEach((name,i)=>{
    const row=el('div','stage-row');
    if(i<idx)row.className='stage-row done';
    else if(i===idx)row.className='stage-row current';
    if(s.stage==='BLOCKED'&&i===Math.max(idx-1,0))row.className='stage-row blocked';
    row.append(el('span','stage-idx',String(i+1)));
    row.append(el('span','stage-name',stageNames[name]));
    if(i===idx)row.append(el('span','stage-state','当前'));
    map.append(row);
    if(i<order.length-1)map.append(el('div','stage-connector'));
  });
}

async function load(){
  const r=await fetch('/api/state');const s=await r.json();

  renderAgents(s);

  $('stageHint').textContent=s.stage==='BLOCKED'
    ?'流水线已阻塞，等你在下面放行。'
    :'当前阶段：'+stageNames[s.stage]+'（'+s.stage+'）';
  const badge=$('state');
  badge.textContent=s.blocked?'已阻塞':'进行中';
  badge.className='badge'+(s.blocked?' warn':'');

  renderStageMap(s);
  const gates=$('gates');gates.replaceChildren();
  for(const g of gateOrder){
    const on=s.passedGates.includes(g);
    const label=g+(on?' ✓':'');
    gates.append(el('span','gate'+(on?' on':''),label));
  }

  const lastBlocked=[...s.history].reverse().find(h=>h.to==='BLOCKED');
  lastBlockedFrom=lastBlocked?lastBlocked.from:null;
  $('releaseBox').hidden=!s.blocked;
  if(s.blocked&&lastBlockedFrom)$('releaseTo').value=lastBlockedFrom;

  const next=$('nextStages');next.replaceChildren();
  for(const edge of s.nextStages){
    if(edge.to==='BLOCKED')continue;
    const b=el('button','ghost sm',stageNames[edge.to]+(edge.gate?' · '+edge.gate:''));
    b.onclick=()=>post('/api/advance',{to:edge.to,note:'从面板推进'});
    if(edge.gate){b.disabled=true;b.title='这一步需要门禁证据，先跑任务';}
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
    return (from+' '+to+' '+(rec.gate||'')+' '+(rec.note||'')).toLowerCase().includes(historyFilterValue);
  });
  if(!filtered.length)h.append(el('div','empty','没有匹配的记录。'));
  for(const rec of filtered){
    const item=el('div','item');
    const line=el('div');
    line.append(el('b',null,(stageNames[rec.from]||rec.from)+' → '+(stageNames[rec.to]||rec.to)));
    if(rec.gate)line.append(el('span','mono','  '+rec.gate+(rec.verdict&&rec.verdict.passed?' 通过':' 未通过')));
    item.append(line,el('div','mono',new Date(rec.at).toLocaleString()+(rec.note?' · '+rec.note:'')));
    if(rec.verdict&&!rec.verdict.passed&&rec.verdict.blocking.length){
      item.append(el('div','mono','拦截：'+rec.verdict.blocking.join('; ')));
    }
    h.append(item);
  }

  $('taskCount').textContent=String(s.tasks.length);
  const t=$('tasks');t.replaceChildren();
  if(!s.tasks.length)t.append(el('div','empty','还没有任务记录。'));
  for(const task of s.tasks){
    const item=el('div','item');
    item.append(el('b',null,task.taskId));
    item.append(el('div','mono',task.files.join(' · ')));
    if(task.failure){
      const f=task.failure;
      item.append(el('div','mono','失败：'+translateFailure(f.reason)+' — '+(f.detail||'')));
    }
    t.append(item);
  }
}
function translateFailure(reason){
  return ({
    'adapter-error':'子进程出错',
    'attempts-exhausted':'重试次数用完',
    'gate-refused':'门禁拒绝',
    'no-progress':'没有进展',
    'cancelled':'已取消',
    'panel-error':'面板出错',
    'unreadable':'记录损坏',
  })[reason]||reason;
}

$('historyFilter').oninput=e=>{historyFilterValue=e.target.value.trim().toLowerCase();};

async function post(route,body){
  const r=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const v=await r.json();
  const m=$('actionMsg');
  if(!r.ok){
    m.className='msg err';
    m.textContent=translateError(v.error||v.refused?.detail||'操作失败');
    return;
  }
  m.className='msg';m.textContent='已记录';
  load();
}
$('releaseBtn').onclick=()=>post('/api/release',{
  to:$('releaseTo').value.trim(),from:lastBlockedFrom,
  note:$('releaseNote').value.trim()||'人工放行'
});
$('blockBtn').onclick=()=>post('/api/block',{note:$('releaseNote').value.trim()||'人工阻塞'});

/* ---------- 导入导出 ---------- */
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
$('importFile').onchange=async e=>{
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
  }catch(err){
    m.className='msg err';m.textContent='导入失败：'+err.message;
  }
  e.target.value='';
};

drawForm();
load();
setInterval(load,3000);
</script></body></html>`;
