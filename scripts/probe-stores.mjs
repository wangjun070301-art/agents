/**
 * Read the cc-switch and Agent2API databases.
 *
 * Neither ships a CLI; both are desktop apps with a local SQLite store. This
 * script only reads, so it is safe to run against a live app.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const stores = [
  ["cc-switch", path.join(os.homedir(), ".cc-switch", "cc-switch.db")],
  ["agent2api", path.join(os.homedir(), ".agent2api", "agent2api.db")],
];

for (const [name, file] of stores) {
  console.log(`\n=== ${name} ===`);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    console.log("cannot open:", error.message);
    continue;
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log("tables:", tables.map((t) => t.name).join(", "));
    for (const { name: table } of tables) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
      console.log(`  ${table}: ${count.n} row(s)`);
    }
  } finally {
    db.close();
  }
}
