#!/usr/bin/env node
/**
 * P11: repetition stability of the real multi-task plan.
 *
 * P10 ran the three-child plan once. P9 already showed that a single pass is
 * not evidence, so this runs the same plan N times and reports how many reached
 * a clean 7/7, plus which check failed on any run that did not.
 *
 * Usage: node tools/p11-repeat-plan.mjs --runs 3 [--sandbox bypass]
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
const runs = Number(arg("--runs", "3"));
const sandbox = arg("--sandbox", "bypass");

const outcomes = [];
const startedAt = Date.now();

for (let i = 1; i <= runs; i += 1) {
  const logFile = path.join(process.env.TEMP ?? "/tmp", `p11-run-${i}.log`);
  const result = await new Promise((resolve) => {
    const child = spawn(
      "node",
      [path.join(repo, "tools", "p10-real-plan.mjs"), "--sandbox", sandbox],
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
  // The drill prints completed=["T-A","T-B","T-JOIN"], with quotes around each
  // id. Strip them so the count compares against plain ids.
  const completed = /completed=\[([^\]]*)\]/.exec(result.out);
  const completedIds = completed
    ? completed[1]
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
    : [];
  const failures = [...result.out.matchAll(/FAIL\s+\[([^\]]+)\] ([^\n]+)/g)].map(
    (m) => `${m[1]}: ${m[2].trim()}`,
  );
  const elapsed = /elapsed=(\d+)s/.exec(result.out);
  outcomes.push({
    run: i,
    exit: result.code,
    checks: summary ? `${summary[1]}/${summary[2]}` : "unknown",
    completed: completedIds.join(","),
    elapsed: elapsed?.[1] ?? "?",
    failures,
    logFile: result.logFile,
  });
  console.log(
    `[p11] run ${i}/${runs}: exit=${result.code} checks=${outcomes.at(-1).checks} completed=[${outcomes.at(-1).completed}] ${outcomes.at(-1).elapsed}s`,
  );
  for (const f of failures) console.log(`        ${f}`);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
const clean = outcomes.filter((o) => o.exit === 0).length;
const fullPlan = outcomes.filter((o) => o.completed === "T-A,T-B,T-JOIN").length;

console.log("");
console.log(`${clean}/${runs} runs passed all seven checks (elapsed ${elapsed}s)`);
console.log(`${fullPlan}/${runs} runs completed all three tasks in order`);
if (clean !== runs) {
  console.log("runs that did not pass:");
  for (const o of outcomes.filter((x) => x.exit !== 0)) {
    console.log(`  run ${o.run}: ${o.checks} checks, completed=[${o.completed}], log ${o.logFile}`);
    for (const f of o.failures) console.log(`    - ${f}`);
  }
}

process.exit(clean === runs ? 0 : 1);
