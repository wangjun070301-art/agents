import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".agent2api", "agent2api.db"), { readOnly: true });
const rows = db.prepare("SELECT key, substr(value,1,120) AS v FROM kv").all();
for (const row of rows) {
  console.log(`${row.key} = ${String(row.v).replace(/\s+/g, " ")}`);
}
console.log("\n=== accounts ===");
const accounts = db.prepare("SELECT * FROM accounts").all();
for (const a of accounts) {
  const brief = {};
  for (const [k, v] of Object.entries(a)) {
    if (/token|secret|key/i.test(k)) continue;
    brief[k] = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
  }
  console.log(JSON.stringify(brief));
}
db.close();
