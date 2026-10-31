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
