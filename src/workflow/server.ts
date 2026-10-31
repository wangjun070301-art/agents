import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Pipeline } from "./pipeline.js";
import type { Stage } from "./contracts.js";

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
@media(max-width:880px){.row{grid-template-columns:minmax(0,1fr)}body{padding:20px}}
</style></head><body>
<h1>流水线控制台</h1>
<p class="sub">只读状态 + 人工放行。启动任务请在命令行运行调度器。</p>
<div class="row">
  <section class="card"><div class="head"><h2>当前阶段</h2><span class="badge" id="state">读取中</span></div>
    <div class="body"><p class="stage" id="stage">—</p><p class="label" id="stageHint"></p>
      <div class="gates" id="gates"></div>
      <div id="releaseBox" hidden>
        <p class="label" style="margin-top:20px">放行回哪个阶段</p>
        <input id="releaseTo" placeholder="例如 IMPLEMENT">
        <textarea id="releaseNote" placeholder="为什么可以继续（会记入历史）"></textarea>
        <div class="actions"><button id="releaseBtn">放行</button><button class="ghost" id="blockBtn">改为阻塞</button></div>
        <div class="msg" id="actionMsg"></div>
      </div>
    </div>
  </section>
  <section class="card"><div class="head"><h2>阶段历史</h2><span class="badge" id="count">0</span></div>
    <div class="body" id="history"><div class="empty">还没有阶段变化。</div></div>
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
  $('count').textContent=String(s.history.length);
  const h=$('history');h.replaceChildren();
  if(!s.history.length)h.append(el('div','empty','还没有阶段变化。'));
  for(const rec of [...s.history].reverse()){
    const item=el('div','item');
    const line=el('div',null);line.append(el('b',null,(stageNames[rec.from]||rec.from)+' → '+(stageNames[rec.to]||rec.to)));
    if(rec.gate)line.append(el('span','mono','  '+rec.gate+(rec.verdict&&rec.verdict.passed?' 通过':' 未通过')));
    item.append(line,el('div','mono',new Date(rec.at).toLocaleString()+(rec.note?' · '+rec.note:''));
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
    if(task.failure){item.append(el('div','mono','失败：'+(task.failure.reason||'')+' — '+(task.failure.detail||''));}
    t.append(item);
  }
}
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
