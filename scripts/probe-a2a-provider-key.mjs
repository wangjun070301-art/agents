/**
 * Find the Agent2API key that cc-switch already stored.
 *
 * Agent2API keeps its own key encrypted, but cc-switch points its `codearts`
 * and `trae` providers at Agent2API and stores the key in plain text. Reading
 * it here means the panel can talk to Agent2API without asking for a secret.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
const rows = db.prepare("SELECT name, settings_config, website_url FROM providers").all();
const seen = new Set();
for (const row of rows) {
  const config = String(row.settings_config ?? "");
  const match = config.match(/sk-a2a-[0-9a-f]{8,}/);
  if (!match) continue;
  if (seen.has(match[0])) continue;
  seen.add(match[0]);
  console.log(`${row.name.padEnd(12)} ${match[0]}  base=${row.website_url}`);
}
db.close();
