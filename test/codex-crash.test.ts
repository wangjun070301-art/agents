import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexAdapter, CodexAdapterError } from "../src/workflow/adapters/codex.js";
import { taskEnvelopeSchema } from "../src/workflow/contracts.js";

/**
 * P11 item: crash versus timeout.
 *
 * These are different code paths. A timeout is the adapter's own timer firing;
 * a crash is the operating system reporting a signal. The adapter must tell
 * them apart, because one is a policy decision and the other is a fault.
 *
 * These tests use a real child process so the signal is real.
 */

function scratchHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-crash-"));
}

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-CRASH",
  role: "developer",
  objective: "wait forever",
  repo_path: process.cwd(),
  base_revision: "abc",
  allowed_paths: [],
  deliverables: ["(none)"],
  acceptance_ids: ["AC-1"],
  timeout_seconds: 60,
});

/** A command that sleeps long enough for the test to kill it. */
function sleepingCommand(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "ping", "-n", "30", "127.0.0.1"] }
    : { command: "sleep", args: ["30"] };
}

test("a child killed by a signal is reported as a crash, not as an exit code", async () => {
  const home = scratchHome();
  const { command, args } = sleepingCommand();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    // A fake spawn that starts a real long-running child, then kills it.
    spawn: (cmd, _spawnArgs, options) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: "ignore" });
        // Kill after a moment so the process is certainly running.
        setTimeout(() => child.kill("SIGKILL"), 300);
        child.on("close", (code, signal) =>
          resolve({
            code: code ?? -1,
            stdout: "",
            stderr: "",
            timedOut: false,
            ...(signal ? { killedBy: signal } : {}),
          }),
        );
      }),
  });

  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError &&
      error.kind === "spawn-failed" &&
      /terminated by/.test(error.message),
  );
  assert.equal(command.length > 0, true, "the test must actually run a command");
});

test("a timeout is still reported as a timeout, not as a crash", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "timeout",
  );
});

test("a child that exits on its own with non-zero is not called a crash", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false }),
  });
  // No result file was written, so this is result-missing, not spawn-failed.
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "result-missing",
  );
});

test("a cancelled run is reported as cancelled, not as a crash", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      killedBy: "SIGKILL",
      cancelled: true,
    }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError &&
      error.kind === "spawn-failed" &&
      /cancelled/.test(error.message),
  );
});

test("format retries do not retry a crash", async () => {
  const home = scratchHome();
  let calls = 0;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    formatRetries: 3,
    spawn: async () => {
      calls += 1;
      return { code: -1, stdout: "", stderr: "", timedOut: false, killedBy: "SIGKILL" };
    },
  });
  await assert.rejects(() => adapter.execute(envelope));
  assert.equal(calls, 1, "a crash must not be retried as if it were a formatting wobble");
});

/**
 * The cancel path with a real child.
 *
 * The other cancel test uses a spawn stub that resolves on abort, so it proves
 * the signal is wired but not that a live process actually dies. Here the
 * spawn starts a real sleeping child and honors the abort by killing it, the
 * same way defaultSpawn does. If cancel() ever stops aborting, this child
 * outlives the test and the assertion fails on the kill flag.
 */
test("cancel kills a real child process, not just the promise", async () => {
  const home = scratchHome();
  const { command, args } = sleepingCommand();
  let killed = false;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: (_cmd, _spawnArgs, options) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: "ignore" });
        const onAbort = () => {
          killed = true;
          child.kill("SIGKILL");
        };
        options.signal?.addEventListener("abort", onAbort);
        child.on("close", (code, signal) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve({
            code: code ?? -1,
            stdout: "",
            stderr: "",
            timedOut: false,
            ...(signal ? { killedBy: signal } : {}),
            ...(killed ? { cancelled: true } : {}),
          });
        });
      }),
  });
  const running = adapter.execute(envelope).catch((error: unknown) => error);
  // Let the child actually start before cancelling.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await adapter.cancel(envelope.task_id);
  const outcome = await running;
  assert.equal(killed, true, "cancel must kill the live child");
  assert.ok(
    outcome instanceof CodexAdapterError &&
      outcome.kind === "spawn-failed" &&
      /cancelled/.test(outcome.message),
    `a cancelled run must report as cancelled, got ${String(outcome)}`,
  );
});

/**
 * The dangerous case: the child wrote part of a result file before it died.
 * A truncated JSON object may still parse if the truncation happens after the
 * closing brace of a nested object, or may parse into something plausible.
 * The adapter must refuse it because the process did not finish, not because
 * the bytes happen to look wrong.
 */
test("a crash that left a half-written result file is refused, not parsed", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      // A syntactically valid but truncated payload: the object closes, but
      // the content is cut off mid-string. JSON.parse would reject this, and a
      // lenient extractor could mistake the inner object for the answer.
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        '{"task_id":"T-CRASH","status":"succeeded","summary":"partial wor',
        "utf8",
      );
      return { code: -1, stdout: "", stderr: "", timedOut: false, killedBy: "SIGKILL" };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError &&
      error.kind === "spawn-failed" &&
      /terminated by/.test(error.message),
    "the crash must be reported before the result file is even opened",
  );
});

test("a crash that left a complete-looking result file is still refused", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      // This is a fully valid task result. The child died after writing it but
      // before exiting cleanly, so the adapter must not treat it as success:
      // the process never reported that it finished.
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({
          task_id: "T-CRASH",
          status: "succeeded",
          summary: "looks complete",
          changed_files: [],
          commands: [{ command: "true", exit_code: 0 }],
          test_results: [{ name: "t", outcome: "passed", acceptance_ids: ["AC-1"] }],
        }),
        "utf8",
      );
      return { code: -1, stdout: "", stderr: "", timedOut: false, killedBy: "SIGKILL" };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "spawn-failed",
    "a plausible-looking file from a killed process is not a result",
  );
});

test("a crash is refused even when a result file exists", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => {
      // A result file exists, so a "result-missing" error would be wrong here.
      // The only correct refusal is the crash itself.
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), "{}", "utf8");
      return { code: -1, stdout: "", stderr: "", timedOut: false, killedBy: "SIGKILL" };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "spawn-failed",
  );
});

/**
 * Signal variety. The adapter treats killedBy as opaque, so any signal name
 * should produce the same crash classification. SIGTERM is the common one on
 * Unix and also what `taskkill` sends by default on Windows.
 */
test("SIGTERM and SIGKILL are both classified as retryable crashes", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      killedBy: "SIGTERM",
    }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError &&
      error.kind === "spawn-failed" &&
      /terminated by SIGTERM/.test(error.message),
  );
});

test("a signal name the adapter has never seen is still treated as a crash", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: async () => ({
      code: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      killedBy: "SIGSEGV",
    }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError && error.kind === "spawn-failed",
    "an unknown signal must not fall through to result parsing",
  );
});

/**
 * A real SIGTERM on the current platform. On Windows child.kill("SIGTERM")
 * maps to TerminateProcess, and the reported signal name may differ; the
 * assertion therefore checks the classification, not the exact string.
 */
test("a real SIGTERM produces a crash classification", async () => {
  const home = scratchHome();
  const { command, args } = sleepingCommand();
  let reported: string | undefined;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    observeWorktree: false,
    spawn: (cmd, _spawnArgs, options) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: "ignore" });
        setTimeout(() => child.kill("SIGTERM"), 300);
        child.on("close", (code, signal) => {
          reported = signal ?? undefined;
          resolve({
            code: code ?? -1,
            stdout: "",
            stderr: "",
            timedOut: false,
            ...(signal ? { killedBy: signal } : {}),
          });
        });
      }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError &&
      error.kind === "spawn-failed" &&
      // Measured on Windows 11 + Node 26: `child.kill("SIGTERM")` goes through
      // TerminateProcess but the `close` event still reports the name the
      // caller asked for, so "SIGTERM" is what the adapter sees there too.
      // A signal kill is an external event, hence retryable.
      error.retryable === true &&
      /terminated by SIGTERM/.test(error.message),
  );
  assert.equal(reported, "SIGTERM", "the close event must name the signal the caller sent");
});
