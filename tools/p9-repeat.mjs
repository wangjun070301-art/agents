#!/usr/bin/env node
/**
 * P9: repetition stability of the real end-to-end path.
 *
 * The P8 drill runs once. Twice during its development, the same prompt
 * produced different shapes from the same model, so "it passed once" is not
 * evidence. This runs the real chain N times and reports how many reached
 * DELIVER, and for each failure, which gate refused and why.
 *
 * Usage: node tools/p9-repeat.mjs --runs 5 [--sandbox bypass]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const runs = Number(arg("--runs", "5"));
const sandbox = arg("--sandbox", "bypass");
const acceptBy = arg("--accept-by", "He");
const acceptNote = arg("--accept-note", "read the diff and the test output before delivery");

const outcomes = [];
const startedAt = Date.now();

for (let i = 1; i <= runs; i += 1) {
  const logFile = path.join(process.env.TEMP ?? "/tmp", `p9-run-${i}.log`);
  const result = await new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        path.join(repo, "tools", "p8-full-path.mjs"),
        "--sandbox",
        sandbox,
        "--accept-by",
        acceptBy,
        "--accept-note",
        acceptNote,
      ],
      { cwd: repo, env: { ...process.env, PATH: `D:\\node;${process.env.PATH ?? ""}` } },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => {
      fs.writeFileSync(logFile, out, "utf8");
      resolve({ code: code ?? -1, out, logFile });
    });
  });

  const summary = /(\d+)\/(\d+) checks passed/.exec(result.out);
  const stage = /\[p8\] final stage (\w+)/.exec(result.out);
  const failures = [...result.out.matchAll(/FAIL\s+\[([^\]]+)\] ([^\n]+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
  outcomes.push({
    run: i,
    exit: result.code,
    checks: summary ? `${summary[1]}/${summary[2]}` : "unknown",
    finalStage: stage?.[1] ?? "unknown",
    failures,
    logFile: result.logFile,
  });
  console.log(
    `[p9] run ${i}/${runs}: exit=${result.code} checks=${outcomes.at(-1).checks} stage=${outcomes.at(-1).finalStage}` +
      (failures.length ? ` failures=${failures.length}` : ""),
  );
  for (const f of failures) console.log(`        ${f}`);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
const delivered = outcomes.filter((o) => o.finalStage === "ARCHIVE").length;
const perfect = outcomes.filter((o) => o.exit === 0).length;

console.log("");
console.log(`${perfect}/${runs} runs passed every check (elapsed ${elapsed}s)`);
console.log(`${delivered}/${runs} runs reached ARCHIVE`);
if (perfect !== runs) {
  console.log("runs that did not pass:");
  for (const o of outcomes.filter((x) => x.exit !== 0)) {
    console.log(`  run ${o.run}: ${o.checks} checks, stage ${o.finalStage}, log ${o.logFile}`);
    for (const f of o.failures) console.log(`    - ${f}`);
  }
}

process.exit(perfect === runs ? 0 : 1);
