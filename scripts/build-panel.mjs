/**
 * Assemble the control panel HTML from its three parts.
 *
 * The panel lives as one template literal inside server.ts, which makes it
 * awkward to edit: a 30 KB blob with no syntax highlighting and no way to
 * lint it. These source files are the real source; this script joins them and
 * rewrites the literal in server.ts.
 *
 * Run: node scripts/build-panel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(repo, "src", "workflow");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

const css = read("panel.css.txt");
const body = read("panel.body.txt");
const js = read("panel.js.txt");

const html = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>流水线控制台</title>",
  "<style>",
  css.trimEnd(),
  "</style></head><body>",
  body.trimEnd(),
  "<script>",
  js.trimEnd(),
  "</script></body></html>",
].join("\n");

const serverFile = path.join(dir, "server.ts");
let source = fs.readFileSync(serverFile, "utf8");

const START = "const PANEL_HTML = String.raw`";
const startAt = source.indexOf(START);
if (startAt < 0) throw new Error("PANEL_HTML literal not found");
const bodyStart = startAt + START.length;
const endAt = source.indexOf("`;", source.indexOf("</script></body></html>", bodyStart));
if (endAt < 0) throw new Error("PANEL_HTML literal end not found");

// String.raw cannot contain a backtick, and the panel has none.
if (html.includes("`")) throw new Error("panel HTML contains a backtick");

source = source.slice(0, bodyStart) + html + source.slice(endAt);
fs.writeFileSync(serverFile, source, "utf8");
console.log(`panel rebuilt: ${html.length} chars -> ${path.relative(repo, serverFile)}`);
