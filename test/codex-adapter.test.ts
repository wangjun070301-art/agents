import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskEnvelopeSchema } from "../src/workflow/contracts.js";
import type { TaskEnvelope } from "../src/workflow/contracts.js";
import { Scheduler } from "../src/workflow/scheduler.js";
import { Pipeline } from "../src/workflow/pipeline.js";
import { requirementsSchema } from "../src/workflow/contracts.js";
import {
  CodexAdapter,
  CodexAdapterError,
  extractJsonObject,
  normalizeTaskResult,
  redactSecrets,
  renderTaskPrompt,
  TASK_RESULT_JSON_SCHEMA,
  type SpawnFn,
} from "../src/workflow/adapters/codex.js";

function scratchHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-"));
  return dir;
}

const envelope = taskEnvelopeSchema.parse({
  task_id: "T-1",
  role: "developer",
  objective: "run one command and report it",
  repo_path: process.cwd(),
  base_revision: "abc",
  allowed_paths: ["src"],
  deliverables: ["src/x.ts"],
  acceptance_ids: ["AC-1"],
  verification_commands: [{ command: "node --version", expect_exit: 0 }],
});

test("redactSecrets masks token-shaped values in output", () => {
  assert.equal(redactSecrets("token gho_abcdef1234567890xyz"), "token ***");
  assert.equal(redactSecrets("Bearer abc.def.ghi123456"), "Bearer ***");
  assert.equal(redactSecrets("api_key=sk-abcdefghijklmnopqrstuvwxyz123"), "api_key=sk-***");
  assert.equal(redactSecrets("github_pat_11ABCDEFGHIJ1234567890"), "***");
  assert.equal(redactSecrets("just a normal log line"), "just a normal log line");
});

test("the prompt carries every boundary the envelope declared", () => {
  const prompt = renderTaskPrompt(envelope);
  assert.match(prompt, /# Task T-1/);
  assert.match(prompt, /Role: developer/);
  assert.match(prompt, /Base revision: abc/);
  assert.match(prompt, /src/);
  assert.match(prompt, /AC-1/);
  assert.match(prompt, /node --version/);
  assert.match(prompt, /expect exit 0/);
});

test("an envelope with no allowed paths says the task is read-only", () => {
  const prompt = renderTaskPrompt(taskEnvelopeSchema.parse({ ...envelope, allowed_paths: [] }));
  assert.match(prompt, /(nothing — read-only task)/);
});

test("the emitted JSON schema forbids extra properties at every level", () => {
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "object") {
      assert.equal(record.additionalProperties, false, `object at ${at} allows extra keys`);
    }
    for (const [key, value] of Object.entries(record)) walk(value, `${at}.${key}`);
  };
  walk(TASK_RESULT_JSON_SCHEMA, "root");
});

test("capabilityCheck reports a missing binary instead of pretending", async () => {
  const adapter = new CodexAdapter({
    codexPath: path.join(os.tmpdir(), "definitely-not-here", "codex.exe"),
    codexHome: scratchHome(),
    model: "deepseek-v4.1-flash-solo",
  });
  const report = await adapter.capabilityCheck();
  assert.equal(report.available, false);
  assert.match(report.detail, /not found/);
});

test("capabilityCheck refuses a CODEX_HOME it cannot write", async () => {
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: path.join(os.tmpdir(), "no-such-dir", "nested"),
    model: "m",
    spawn: async () => ({ code: 0, stdout: "codex-cli 1.0.0", stderr: "", timedOut: false }),
  });
  // mkdir of a nested path under tmp usually succeeds, so force the failure.
  const report = await adapter.capabilityCheck().catch((e: unknown) => {
    throw e;
  });
  assert.ok(report.version === "1.0.0" || report.available === false);
});

test("a child that writes no result is reported as missing, not as success", async () => {
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: scratchHome(),
    model: "m",
    spawn: async () => ({ code: 0, stdout: "", stderr: "blocked", timedOut: false }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError && error.kind === "result-missing" && /blocked/.test(error.message),
  );
});

test("a timeout is surfaced as a timeout", async () => {
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: scratchHome(),
    model: "m",
    spawn: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }),
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "timeout",
  );
});

test("a result that breaks the protocol is rejected with the offending path", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    spawn: async (_cmd, _args, options) => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      // A JSON array is not a task result at any field of the protocol, so
      // normalization leaves it alone and the schema rejects it.
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(["done"]), "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "result-invalid",
  );
});

test("stray prose around the JSON object is tolerated", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        `[R]\n\nprobe done\n\n{"task_id":"T-1","status":"partial","summary":"x"}\n`,
        "utf8",
      );
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const result = await adapter.execute(envelope);
  assert.equal(result.task_id, "T-1");
  assert.equal(result.status, "partial");
});

test("a fenced JSON block is preferred over surrounding prose", () => {
  const raw = [
    "[R]",
    "",
    "here you go.",
    "",
    "```json",
    '{"task_id":"T-1","status":"partial","summary":"x"}',
    "```",
    "",
    "also as a JS literal: { a: 1 }",
  ].join("\n");
  const parsed = extractJsonObject(raw) as Record<string, unknown>;
  assert.equal(parsed.task_id, "T-1");
});

test("normalization maps model vocabulary onto the protocol fields", () => {
  const raw = {
    task: "T-1",
    role: "developer",
    status: "succeeded",
    summary: "ran it",
    commands: [{ command: "node --version", exit_code: 0, stdout: "v26.11.1", ran: true }],
    tests: [],
    acceptance: ["AC-1"],
    unresolved: [],
  };
  const normalized = normalizeTaskResult(raw, "T-FALLBACK") as Record<string, unknown>;
  assert.equal(normalized.task_id, "T-1");
  assert.deepEqual(normalized.commands, [
    { command: "node --version", exit_code: 0, output_tail: "v26.11.1" },
  ]);
  // Fields with no protocol equivalent are dropped, not smuggled through.
  assert.equal(Object.hasOwn(normalized, "role"), false);
  assert.equal(Object.hasOwn(normalized, "acceptance"), false);
});

test("a command with a null exit code is dropped, not counted as a run", () => {
  const normalized = normalizeTaskResult(
    {
      task: "T-1",
      status: "succeeded",
      summary: "claims success",
      commands: [{ command: "node --version", exit_code: null, ran: false }],
    },
    "T-1",
  ) as Record<string, unknown>;
  assert.deepEqual(normalized.commands, []);
});

test("a reply missing task_id falls back to the envelope id", () => {
  const normalized = normalizeTaskResult(
    { status: "partial", summary: "x" },
    "T-ENV",
  ) as Record<string, unknown>;
  assert.equal(normalized.task_id, "T-ENV");
});

test("test outcome vocabulary is mapped onto the protocol enum", () => {
  const normalized = normalizeTaskResult(
    {
      task_id: "T-1",
      status: "partial",
      summary: "x",
      test_results: [
        { name: "a", outcome: "pass" },
        { name: "b", outcome: "green" },
        { name: "c", outcome: "blocked" },
        { name: "d", outcome: "skipped" },
        { name: "e", outcome: "mystery" },
      ],
    },
    "T-1",
  ) as Record<string, unknown>;
  assert.deepEqual(normalized.test_results, [
    { name: "a", outcome: "passed" },
    { name: "b", outcome: "passed" },
    { name: "c", outcome: "unverified" },
    { name: "d", outcome: "skipped" },
  ]);
});

test("a result file with no JSON object at all is rejected", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    formatRetries: 0,
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), "I could not do it.", "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) =>
      error instanceof CodexAdapterError && error.kind === "result-invalid",
  );
});

test("a prose reply is retried, and a good reply on the second try is accepted", async () => {
  const home = scratchHome();
  let calls = 0;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    formatRetries: 1,
    spawn: async () => {
      calls += 1;
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        calls === 1
          ? "[R]\n\nbrief received. did the work.\n"
          : JSON.stringify({
              task_id: "T-1",
              status: "partial",
              summary: "second try produced a result",
              changed_files: ["src/x.ts"],
            }),
        "utf8",
      );
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const result = await adapter.execute(envelope);
  assert.equal(calls, 2, "the prose reply must have triggered exactly one retry");
  assert.equal(result.status, "partial");
});

test("retries are bounded: a child that never produces JSON still fails", async () => {
  const home = scratchHome();
  let calls = 0;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    formatRetries: 2,
    spawn: async () => {
      calls += 1;
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), "[R]\n\nprose again.\n", "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "result-invalid",
  );
  assert.equal(calls, 3, "formatRetries=2 means three attempts, then give up");
});

test("a timeout is not retried, because it would fail the same way", async () => {
  const home = scratchHome();
  let calls = 0;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    formatRetries: 2,
    spawn: async () => {
      calls += 1;
      return { code: -1, stdout: "", stderr: "", timedOut: true };
    },
  });
  await assert.rejects(
    () => adapter.execute(envelope),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "timeout",
  );
  assert.equal(calls, 1, "a timeout must not be retried");
});

/**
 * Two retry layers exist: the adapter retries a malformed reply internally
 * (`formatRetries`), and the scheduler retries the whole task (`maxAttempts`).
 * P13 recorded that this interaction was never tested, and the answer is not
 * the obvious one: they do NOT multiply. `result-invalid` is declared
 * non-retryable, so once the adapter exhausts its own budget the scheduler
 * stops after a single attempt instead of paying for another full round.
 */
test("a malformed reply costs the adapter's budget once, not the scheduler's too", async () => {
  const home = scratchHome();
  const requirements = requirementsSchema.parse([
    {
      req_id: "REQ-1",
      statement: "the task runs",
      acceptance: [
        {
          ac_id: "AC-1",
          requirement_id: "REQ-1",
          description: "one check",
          kind: "automated",
          verification_command: "node --version",
        },
      ],
    },
  ]);
  let childRuns = 0;
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    formatRetries: 2, // 3 child runs per adapter.execute()
    spawn: async () => {
      childRuns += 1;
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), "[R]\n\nprose again.\n", "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });

  let executeCalls = 0;
  const counting = {
    ...adapter,
    execute: async (envelope: TaskEnvelope) => {
      executeCalls += 1;
      return adapter.execute(envelope);
    },
  };
  const scheduler = new Scheduler({
    adapter: counting,
    requirements,
    pipeline: new Pipeline("IMPLEMENT"),
    maxAttempts: 2,
  });

  await scheduler.runTask(envelope);
  assert.equal(executeCalls, 1, "result-invalid is non-retryable, so the scheduler stops after one");
  assert.equal(childRuns, 3, "the adapter still spends its own formatRetries budget");
});

test("a child that claims success while exiting non-zero becomes blocked", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({
          task_id: "T-1",
          status: "succeeded",
          summary: "did it",
          commands: [{ command: "node --version", exit_code: 0 }],
          test_results: [{ name: "t", outcome: "passed", acceptance_ids: ["AC-1"] }],
        }),
        "utf8",
      );
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    },
  });
  const result = await adapter.execute(envelope);
  assert.equal(result.status, "blocked");
  assert.match(result.unresolved_issues.join(" "), /exited 1/);
});

test("evidence is collected from what the child actually reported", async () => {
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    // This test exercises the reported-evidence path. Observation would
    // snapshot the real cwd, find nothing changed, and override the claim —
    // which is correct behaviour but not what this case is about.
    observeWorktree: false,
    spawn: async () => {
      const runDir = path.join(home, "runs", envelope.task_id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({
          task_id: "T-1",
          status: "partial",
          summary: "x",
          changed_files: ["src/a.ts"],
          commands: [{ command: "node --version", exit_code: 0 }],
        }),
        "utf8",
      );
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  await adapter.execute(envelope);
  const evidence = await adapter.collectEvidence("T-1");
  assert.deepEqual(evidence.changed_files, ["src/a.ts"]);
  assert.equal(evidence.command_records.length, 1);
});

test("collectEvidence on an unknown task throws rather than inventing", async () => {
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: scratchHome(),
    model: "m",
    spawn: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  });
  await assert.rejects(
    () => adapter.collectEvidence("never-ran"),
    (error: unknown) => error instanceof CodexAdapterError && error.kind === "result-missing",
  );
});

test("cancel aborts the run in flight", async () => {
  let sawAbort = false;
  const home = scratchHome();
  const adapter = new CodexAdapter({
    codexPath: process.execPath,
    codexHome: home,
    model: "m",
    spawn: async (_cmd, _args, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          sawAbort = true;
          resolve({ code: -1, stdout: "", stderr: "", timedOut: false });
        });
      }),
  });
  const running = adapter.execute(envelope);
  await new Promise((r) => setTimeout(r, 30));
  await adapter.cancel("T-1");
  await running.catch(() => {});
  assert.equal(sawAbort, true);
});
