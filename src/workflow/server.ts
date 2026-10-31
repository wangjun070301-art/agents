import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Pipeline } from "./pipeline.js";
import type { Stage } from "./contracts.js";
import { readProject, writeProject, codexHomeFor, defaultCodexPath, type Project } from "./project.js";
import { CodexAdapter } from "./adapters/codex.js";
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
  const stateDir = fs.realpathSync(options.stateDir);
  const stateFile = path.join(stateDir, "pipeline.json");
  const pipeline = Pipeline.restore(stateFile);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18493;
  /** A run in flight, so the UI cannot start two at once. */
  let running: { taskId: string; startedAt: string } | undefined;
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
    running: running ?? null,
    lastRun: lastRun ?? null,
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
          if (running) {
            send(res, 409, JSON.stringify({ error: `a run is already in progress: ${running.taskId}` }));
            return;
          }
          running = { taskId: task.task_id, startedAt: new Date().toISOString() };
          send(res, 202, JSON.stringify({ accepted: true, taskId: task.task_id }));

          // Run after responding, so the UI gets its acknowledgement at once
          // instead of waiting on a child process that may take minutes.
          void executeTask(project, task, stateDir, options.codexPath)
            .then((result) => {
              lastRun = {
                taskId: task.task_id,
                ok: result.ok,
                finishedAt: new Date().toISOString(),
                ...(result.failure ? { failure: result.failure } : {}),
              };
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
              running = undefined;
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
          if (running) {
            send(res, 409, JSON.stringify({ error: `a run is already in progress: ${running.taskId}` }));
            return;
          }
          running = { taskId: "PLAN", startedAt: new Date().toISOString() };
          send(res, 202, JSON.stringify({ accepted: true, taskId: "PLAN" }));
          void executePlan(project, stateDir, options.codexPath)
            .then((result) => {
              lastRun = {
                taskId: "PLAN",
                ok: result.failed.length === 0,
                finishedAt: new Date().toISOString(),
                ...(result.failed.length ? { failure: result } : {}),
              };
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
              running = undefined;
            });
        })
        .catch((error: unknown) => {
          send(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
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
        server.listen(port, host, () => resolve(port));
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
  });
  const pipeline = Pipeline.restore(path.join(stateDir, "pipeline.json"));
  const scheduler = new Scheduler({
    adapter,
    requirements: project.requirements,
    pipeline,
    maxAttempts: 2,
    stateDir,
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
  });
  const pipeline = Pipeline.restore(path.join(stateDir, "pipeline.json"));
  const scheduler = new Scheduler({ adapter, requirements: project.requirements, pipeline, maxAttempts: 2, stateDir });
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
:root{--bg:#f7f7f4;--panel:#fff;--ink:#1d221d;--muted:#767d74;--line:#e5e7e0;--green:#3b5c3e;--amber:#9a6a2c;--red:#9c4034;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
*{box-sizing:border-box}body{margin:0;padding:32px;max-width:1180px}
h1{font-size:22px;margin:0 0 6px;font-weight:650;letter-spacing:-.3px}
.sub{font-size:12px;color:var(--muted);margin:0 0 26px}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:20px;align-items:start}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px}
.head h2{font-size:14px;margin:0;font-weight:600}
.body{padding:18px 20px}
.stage{font-size:30px;font-weight:650;letter-spacing:-.6px;margin:0 0 4px}
.badge{display:inline-block;font-size:11px;padding:4px 9px;border-radius:6px;background:#eef3ea;color:var(--green)}
.badge.warn{background:#faf1de;color:var(--amber)}
.badge.bad{background:#fbece9;color:var(--red)}
.gates{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 0}
.gate{font-size:11px;padding:5px 9px;border-radius:6px;background:#f2f4ee;color:var(--muted)}
.gate.on{background:var(--green);color:#fff}
.label{font-size:11px;letter-spacing:1.2px;color:var(--muted);margin:0 0 10px}
.item{padding:12px 0;border-bottom:1px solid #f0f2ec;font-size:13px;line-height:1.7}
.item:last-child{border-bottom:0}
.item b{font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
textarea,input{width:100%;border:1px solid #dfe3da;border-radius:8px;padding:10px 11px;font:inherit;font-size:13px;background:#fcfdfb;outline:none}
textarea:focus,input:focus{border-color:#8fa886;box-shadow:0 0 0 3px #eef3ea}
textarea{min-height:64px;resize:vertical}
button{border:0;border-radius:8px;padding:10px 16px;background:var(--green);color:#fff;font-size:13px;cursor:pointer}
button.ghost{background:#f2f4ee;color:var(--ink);border:1px solid var(--line)}
button:disabled{opacity:.4;cursor:default}
.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.msg{font-size:12px;margin-top:10px;line-height:1.7}
.msg.err{color:var(--red)}
.empty{padding:34px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.req{border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px;background:#fcfdfb}
.item-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.ac-list{margin-top:12px;padding-left:12px;border-left:2px solid #eef1e9}
.ac{border:1px solid #eef1e9;border-radius:8px;padding:10px;margin-bottom:8px;background:#fff}
.req input,.req textarea{font-size:12px;padding:8px 10px}
.req .label{margin:8px 0 4px;font-size:10px}
@media(max-width:880px){.row{grid-template-columns:minmax(0,1fr)}body{padding:20px}}
</style></head><body>
<h1>流水线控制台</h1>
<p class="sub">配置项目、启动任务、推进阶段、人工放行。所有操作都记入历史。</p>
<div class="row">
  <section class="card"><div class="head"><h2>当前阶段</h2><span class="badge" id="state">读取中</span></div>
    <div class="body"><p class="stage" id="stage">—</p><p class="label" id="stageHint"></p>
      <div class="gates" id="gates"></div>
      <p class="label" style="margin-top:20px">可推进到</p>
      <div class="actions" id="nextStages"></div>
      <div id="releaseBox" hidden>
        <p class="label" style="margin-top:18px">放行回哪个阶段</p>
        <input id="releaseTo" placeholder="例如 IMPLEMENT">
        <textarea id="releaseNote" placeholder="为什么可以继续（会记入历史）"></textarea>
        <div class="actions"><button id="releaseBtn">放行</button><button class="ghost" id="blockBtn">改为阻塞</button></div>
      </div>
      <div class="msg" id="actionMsg"></div>
    </div>
  </section>
  <section class="card"><div class="head"><h2>阶段历史</h2><span class="badge" id="count">0</span></div>
    <div class="body" id="history"><div class="empty">还没有阶段变化。</div></div>
  </section>
</div>
<div class="row" style="margin-top:20px">
  <section class="card"><div class="head"><h2>项目配置</h2><span class="badge" id="projState">未配置</span></div>
    <div class="body">
      <p class="label">名称</p><input id="pName" placeholder="例如 fixture">
      <p class="label" style="margin-top:12px">代码目录（绝对路径）</p><input id="pRepo" placeholder="C:\\path\\to\\repo">
      <p class="label" style="margin-top:12px">模型</p><input id="pModel" value="deepseek-v4.1-flash-solo">
      <p class="label" style="margin-top:12px">沙箱</p><input id="pSandbox" value="bypass" placeholder="read-only / workspace-write / bypass">
      <p class="label" style="margin-top:18px">需求（每条需求至少一个验收项）</p>
      <div id="reqList"></div>
      <div class="actions"><button class="ghost" id="addReq">+ 加一条需求</button></div>
      <p class="label" style="margin-top:18px">任务</p>
      <div id="taskForm"></div>
      <div class="actions"><button class="ghost" id="addTask">+ 加一个任务</button></div>
      <div class="actions" style="margin-top:18px"><button id="saveProject">保存配置</button></div>
      <div class="msg" id="projMsg"></div>
    </div>
  </section>
  <section class="card"><div class="head"><h2>任务</h2><span class="badge" id="runState">空闲</span></div>
    <div class="body" id="taskList"><div class="empty">先保存项目配置。</div></div>
    <div class="body" style="padding-top:0"><button id="runPlanBtn" style="width:100%">跑整个计划（按依赖顺序）</button></div>
  </section>
</div>
<section class="card" style="margin-top:20px"><div class="head"><h2>任务记录</h2><span class="badge" id="taskCount">0</span></div>
  <div class="body" id="tasks"><div class="empty">还没有任务记录。命令行跑一次任务后，这里会出现。</div></div>
</section>
<script>
const $=id=>document.getElementById(id);
const stageNames={INTAKE:'接单',CLARIFY:'澄清',BASELINE:'基线',SPEC:'需求规格',PLAN:'计划',DISPATCH:'派工',IMPLEMENT:'实现',REVIEW:'审查',VERIFY:'验证',INTEGRATE:'集成',ACCEPT:'验收',DELIVER:'交付',ARCHIVE:'归档',BLOCKED:'已阻塞'};
const gateOrder=['G0','G1','G2','G3','G4','G5'];
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
let lastBlockedFrom=null;
let projectLoaded=false;
async function load(){
  const r=await fetch('/api/state');const s=await r.json();
  $('stage').textContent=stageNames[s.stage]||s.stage;
  $('stageHint').textContent=s.stage==='BLOCKED'?'等待人工处理':'当前阶段（代码：'+s.stage+'）';
  const badge=$('state');badge.textContent=s.blocked?'已阻塞':'进行中';badge.className='badge'+(s.blocked?' warn':'');
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
  renderRunning(s.running,s.lastRun);
  $('count').textContent=String(s.history.length);
  const h=$('history');h.replaceChildren();
  if(!s.history.length)h.append(el('div','empty','还没有阶段变化。'));
  for(const rec of [...s.history].reverse()){
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
function renderRunning(running,lastRun){
  const badge=$('runState');
  if(running){badge.textContent='运行中：'+running.taskId;badge.className='badge warn';return;}
  if(lastRun){badge.textContent=(lastRun.ok?'完成':'失败')+'：'+lastRun.taskId;badge.className='badge'+(lastRun.ok?'':' bad');return;}
  badge.textContent='空闲';badge.className='badge';
}
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
