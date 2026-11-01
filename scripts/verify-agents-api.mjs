/**
 * Check the agent endpoints through a real panel instance.
 *
 * Two things matter: `/api/state` must describe each agent's route and models,
 * and `/api/agents` must accept a role binding with a model attached.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPanel } from "../dist/workflow/server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-api-"));
const panel = createPanel({ stateDir: dir, port: 0 });
await panel.start();
const base = `http://127.0.0.1:${panel.server.address().port}`;

try {
  const state = await (await fetch(`${base}/api/state`)).json();
  console.log("agents:");
  for (const agent of state.agents) {
    const route = agent.route ? agent.route.kind : "-";
    const models = agent.models ? agent.models.join("/") : "-";
    console.log(`  ${agent.available ? "OK" : "--"} ${agent.id.padEnd(16)} route=${route} models=${models}`);
    if (agent.reason) console.log(`     ${agent.reason}`);
  }

  const save = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewer: "claude", reviewer_model: "claude-sonnet-4-5" }),
  });
  console.log("\nsave:", save.status, await save.text());

  const after = await (await fetch(`${base}/api/state`)).json();
  console.log("bindings:", JSON.stringify(after.bindings));

  const bad = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewer: "claude", reviewer_model: "gpt-4" }),
  });
  console.log("reject unknown model:", bad.status, await bad.text());
} finally {
  await panel.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
