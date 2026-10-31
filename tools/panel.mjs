#!/usr/bin/env node
/**
 * Start the pipeline control panel.
 *
 * Usage:
 *   node tools/panel.mjs [--state DIR] [--port N]
 *
 * Opens on http://127.0.0.1:18493 by default. The state directory is where
 * the scheduler writes pipeline.json and tasks/, so pointing both at the same
 * directory is what makes the panel show real progress.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createPanel } from "../dist/workflow/server.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const stateDir = path.resolve(arg("--state", path.join(repo, "workflow-state")));
const port = Number(arg("--port", "18493"));

fs.mkdirSync(stateDir, { recursive: true });

const panel = createPanel({ stateDir, port });
await panel.start();
console.log(`[panel] state: ${stateDir}`);
console.log(`[panel] open:  http://127.0.0.1:${port}`);
console.log("[panel] Ctrl+C to stop");

const shutdown = async () => {
  await panel.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
