/**
 * Inspect the cc-switch local proxy and the providers it fronts.
 *
 * cc-switch runs a local proxy in front of several providers. If it is running,
 * that proxy is the natural place to point Claude Code: it can map an
 * Anthropic-shaped request onto whatever model the provider actually offers.
 * This script only reads the database and probes localhost.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });

console.log("=== proxy_config ===");
for (const row of db.prepare("SELECT * FROM proxy_config").all()) {
  console.log(JSON.stringify(row));
}

console.log("\n=== providers (id, name, kind, base) ===");
for (const row of db.prepare("SELECT * FROM providers").all()) {
  const r = row;
  const keys = Object.keys(r).filter((k) => !/key|token|secret/i.test(k));
  const brief = {};
  for (const k of keys) brief[k] = typeof r[k] === "string" && r[k].length > 80 ? r[k].slice(0, 80) + "…" : r[k];
  console.log(JSON.stringify(brief));
}

console.log("\n=== provider_endpoints ===");
for (const row of db.prepare("SELECT * FROM provider_endpoints").all()) {
  const r = row;
  const keys = Object.keys(r).filter((k) => !/key|token|secret/i.test(k));
  const brief = {};
  for (const k of keys) brief[k] = r[k];
  console.log(JSON.stringify(brief));
}
db.close();

console.log("\n=== listening ports (local proxy candidates) ===");
const { execFileSync } = await import("node:child_process");
try {
  const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  const local = out
    .split(/\r?\n/)
    .filter((line) => /LISTENING/.test(line) && /127\.0\.0\.1/.test(line))
    .map((line) => line.trim().split(/\s+/))
    .map((parts) => ({ address: parts[1], pid: parts[4] }));
  const pids = [...new Set(local.map((l) => l.pid))];
  const names = new Map();
  for (const pid of pids) {
    try {
      const task = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const name = task.split(",")[0]?.replace(/"/g, "");
      if (name) names.set(pid, name);
    } catch {}
  }
  for (const entry of local) {
    console.log(`${entry.address.padEnd(24)} pid=${entry.pid} ${names.get(entry.pid) ?? "?"}`);
  }
} catch (error) {
  console.log("netstat failed:", error.message);
}
