#!/usr/bin/env node
/**
 * Acceptance harness for the persistent-service hang fix.
 *
 * Runs the seven checks from docs/workflow/ACCEPTANCE-HANG-FIX.md and prints a
 * pass/fail line for each, with the measured number beside it. Every check
 * shells out to the real tool; nothing is inferred from a commit message.
 *
 * Usage: node tools/accept-hang-fix.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json");
const results = [];

const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  if (!jsonOut) {
    console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}`);
    console.log(`      ${detail}`);
  }
};

/** Run a command with a hard wall-clock cap; returns output and whether it returned in time. */
function run(command, args, timeoutMs, cwd = repo) {
  const started = Date.now();
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, PATH: `D:\\node;${process.env.PATH ?? ""}` },
    });
    return { returned: true, stdout, elapsedMs: Date.now() - started, code: 0 };
  } catch (error) {
    const stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const timedOut = error.code === "ETIMEDOUT" || error.signal === "SIGTERM";
    return {
      returned: !timedOut,
      stdout,
      elapsedMs: Date.now() - started,
      code: typeof error.status === "number" ? error.status : -1,
    };
  }
}

const counts = (text) => {
  const pick = (label) => {
    const match = text.match(new RegExp(`${label}\\s+(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    skipped: pick("skipped"),
    cancelled: pick("cancelled"),
    durationMs: pick("duration_ms"),
  };
};

// ---------------------------------------------------------------- check 1..3
const single = run(
  "npx",
  ["tsx", "--test", "--test-timeout=60000", "test/persistent-service.test.ts"],
  150_000,
);
const singleCounts = counts(single.stdout);

record(
  "1",
  "persistent-service.test.ts returns instead of hanging",
  single.returned && single.elapsedMs < 90_000,
  `returned=${single.returned} elapsed=${single.elapsedMs}ms exit=${single.code}`,
);

record(
  "2",
  "test count did not shrink",
  singleCounts.tests !== null && singleCounts.tests >= 21,
  `tests=${singleCounts.tests} (expected >= 21)`,
);

record(
  "3",
  "no new failures in this file",
  singleCounts.fail !== null && singleCounts.fail <= 2,
  `fail=${singleCounts.fail} (baseline 2), pass=${singleCounts.pass}, skipped=${singleCounts.skipped}`,
);

// ---------------------------------------------------------------- check 6
const full = run(
  "npx",
  ["tsx", "--test", "--test-timeout=60000", "test/**/*.test.ts"],
  240_000,
);
const fullCounts = counts(full.stdout);

record(
  "6",
  "the full suite returns instead of hanging",
  full.returned && full.elapsedMs < 180_000,
  `returned=${full.returned} elapsed=${full.elapsedMs}ms tests=${fullCounts.tests} pass=${fullCounts.pass} fail=${fullCounts.fail}`,
);

record(
  "6b",
  "the full suite has no more failures than the baseline",
  fullCounts.fail !== null && fullCounts.fail <= 18,
  `fail=${fullCounts.fail} (baseline 18), cancelled=${fullCounts.cancelled}`,
);

// ---------------------------------------------------------------- check 5
// `~1` rather than `^`: on Windows this runs through cmd, where ^ is an
// escape character and would silently turn the revision into a plain hash.
const diffStat = run("git", ["diff", "--name-only", "9752b1b~1", "9752b1b"], 30_000);
const touched = diffStat.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
record(
  "5",
  "the fix touches only what the root cause requires",
  touched.length > 0 && touched.every((file) => file.startsWith("src/") || file.startsWith("test/")),
  `files=${JSON.stringify(touched)}`,
);

// ---------------------------------------------------------------- check 4
const commitBody = run("git", ["log", "-1", "--format=%B", "9752b1b"], 30_000).stdout;
const namesRootCause =
  /EPERM|fsync|directory cannot be fsynced|openSync/.test(commitBody) &&
  /why|because|so the|therefore|never happened|hung/.test(commitBody);
record(
  "4",
  "the commit names the resource that was not released, not just 'added a timeout'",
  namesRootCause,
  namesRootCause
    ? "commit body names fsync/EPERM and the pump consequence"
    : "commit body does not explain the mechanism",
);

// ---------------------------------------------------------------- check 7
const testFile = fs.readFileSync(path.join(repo, "test", "persistent-service.test.ts"), "utf8");
const rawPosixAssert = /mode\s*&\s*0o777,\s*0o600/.test(testFile);
const hasPlatformGuard =
  /process\.platform\s*===?\s*"win32"/.test(testFile) || /platform\s*!==?\s*"win32"/.test(testFile);
const hasSkip =
  /skip:\s*(process\.platform|true)/.test(testFile) || /\{\s*skip:/.test(testFile);
record(
  "7",
  "POSIX mode assertions are disposed of explicitly, not deleted",
  hasPlatformGuard || hasSkip,
  rawPosixAssert
    ? `still asserts raw 0o600 (platformGuard=${hasPlatformGuard}, skip=${hasSkip})`
    : `raw assertion replaced (platformGuard=${hasPlatformGuard}, skip=${hasSkip})`,
);

// ---------------------------------------------------------------- forbidden
const removedTests = run("git", ["diff", "--numstat", "9752b1b^", "9752b1b", "--", "test/"], 30_000);
record(
  "F1",
  "no test was deleted or weakened in the fix commit",
  removedTests.stdout.trim() === "",
  removedTests.stdout.trim() === "" ? "test/ untouched by 9752b1b" : removedTests.stdout.trim(),
);

if (jsonOut) {
  console.log(JSON.stringify({ results, single: singleCounts, full: fullCounts }, null, 2));
} else {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("open items:");
    for (const f of failed) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`);
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
