/**
 * Print what the agent detector reports, including routes and model lists.
 *
 * Useful after installing or reconfiguring an agent: it shows whether the
 * detector sees the binary, which route it would take, and which model names
 * the panel can offer for it.
 */
import { detectAgents } from "../dist/workflow/agents.js";

for (const agent of detectAgents()) {
  console.log(`${agent.available ? "OK " : "-- "} ${agent.id.padEnd(16)} ${agent.version ?? ""}`);
  if (agent.reason) console.log(`      reason: ${agent.reason}`);
  if (agent.route) {
    console.log(`      route: ${agent.route.kind}` +
      (agent.route.kind === "gateway" ? ` -> ${agent.route.baseUrl} (${agent.route.modelMap.map((m) => m.to).join("/")})` : ""));
  }
  if (agent.models?.length) console.log(`      models: ${agent.models.join(", ")}`);
}
