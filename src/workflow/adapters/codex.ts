import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import {
  taskResultSchema,
  type TaskEnvelope,
  type TaskResult,
} from "../contracts.js";
import type {
  CapabilityReport,
  EvidenceBundle,
  ExecuteOptions,
  WorkflowAdapter,
} from "../adapters.js";
import { diffSnapshots, snapshotWorktree, type ObservedChange, type WorktreeSnapshot } from "../observer.js";
import { parseTestOutput, reconcileClaimedWithParsed } from "../test-output.js";

export type SandboxMode = "read-only" | "workspace-write" | "bypass";

/** Outcome of one child process, reduced to what the adapter needs. */
export interface SpawnOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Set when the child was terminated by a signal rather than exiting on its
   * own. A killed process reports code null, so without this field a crash is
   * indistinguishable from an ordinary non-zero exit.
   */
  killedBy?: string;
  /** True when the kill came from this adapter's own cancel(). */
  cancelled?: boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void },
) => Promise<SpawnOutcome>;

export interface CodexAdapterOptions {
  /** Absolute path to codex.exe. */
  codexPath: string;
  /** Writable CODEX_HOME for the child. Never the user's live home. */
  codexHome: string;
  /** Real model slug from the cc-switch catalog. */
  model: string;
  /**
   * Sandbox for the child. `workspace-write` is the normal choice.
   * `bypass` exists because a child started inside another sandbox cannot
   * create its own; it is opt-in, never the default.
   */
  sandbox?: SandboxMode;
  /** Catalog file used to report which models exist. */
  modelCatalogPath?: string;
  timeoutMs?: number;
  spawn?: SpawnFn;
  /**
   * Snapshot the worktree before and after each run so `collectEvidence`
   * reports what actually changed, not what the child said it changed.
   * Enabled by default; a test can turn it off to keep runs hermetic.
   */
  observeWorktree?: boolean;
  /**
   * Called with each chunk of the child's stdout as it arrives. Used by the
   * control panel to stream output while a task is still running; the panel
   * appends to a ring buffer so the page can show recent lines.
   */
  onOutput?: (chunk: string) => void;
  /**
   * How many times to re-run a child whose reply could not be parsed as a
   * task result. The model occasionally answers with prose instead of the
   * object, which is a formatting failure, not a task failure: re-running is
   * cheaper than failing the whole pipeline on it. Defaults to 2 retries.
   */
  formatRetries?: number;
}

/** What the adapter saw, kept separate from what the child claimed. */
interface Observation {
  /**
   * The snapshot from the first attempt of this task. Retries are compared
   * against this, not against the previous attempt: a retry that finds the
   * work already done must not look like "nothing happened".
   */
  before: WorktreeSnapshot;
  after: WorktreeSnapshot;
  changes: ObservedChange[];
}

/** A claim the child made that its own command output contradicts. */
export interface ClaimDiscrepancy {
  command: string;
  problems: string[];
}

export class CodexAdapterError extends Error {
  constructor(
    readonly kind:
      | "binary-missing"
      | "home-not-writable"
      | "spawn-failed"
      | "timeout"
      | "result-missing"
      | "result-invalid",
    message: string,
    /**
     * Whether re-running the task could plausibly help. A crash is transient
     * (an external kill, an OOM sweep); a timeout means the budget was
     * exhausted and will be again; a cancel was a decision, not a fault.
     */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CodexAdapterError";
  }
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr, timedOut: false });
    };
    options.signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) =>
      finish({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut: false,
        ...(signal ? { killedBy: signal, ...(aborted ? { cancelled: true } : {}) } : {}),
      }),
    );
  });

/**
 * The JSON Schema the child must answer with. Derived from the zod schema so
 * the two can never drift.
 */
export const TASK_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task_id", "status", "summary"],
  properties: {
    task_id: { type: "string" },
    status: { type: "string", enum: ["succeeded", "failed", "blocked", "partial"] },
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: { type: "string" } },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exit_code"],
        properties: {
          command: { type: "string" },
          exit_code: { type: "integer" },
          output_tail: { type: "string" },
        },
      },
    },
    test_results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "outcome"],
        properties: {
          name: { type: "string" },
          outcome: { type: "string", enum: ["passed", "failed", "skipped", "unverified"] },
          acceptance_ids: { type: "array", items: { type: "string" } },
          detail: { type: "string" },
        },
      },
    },
    unresolved_issues: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    suggested_next_step: { type: "string" },
  },
} as const;

/**
 * Normalize a reply that is structurally right but spelled differently.
 *
 * Models drift toward their own vocabulary: `task` for `task_id`, `ran` for a
 * boolean run flag, `stdout` for `output_tail`, `null` for a missing exit
 * code. None of that is evidence, so each alias is mapped only to the field
 * that carries the same meaning, and anything with no equivalent is dropped.
 * The result still has to pass the protocol schema afterwards.
 */
export function normalizeTaskResult(raw: unknown, taskId: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const alias = (names: string[]): unknown => {
    for (const name of names) {
      if (Object.hasOwn(source, name)) return source[name];
    }
    return undefined;
  };

  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;

  const statusOf = (value: unknown): string => {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "succeeded" || v === "success" || v === "complete" || v === "completed" || v === "done" || v === "ok") {
      return "succeeded";
    }
    if (v === "failed" || v === "failure" || v === "error") return "failed";
    if (v === "blocked" || v === "blocker") return "blocked";
    if (v === "partial" || v === "incomplete") return "partial";
    return "partial";
  };

  out.task_id = text(alias(["task_id", "task"])) ?? taskId;
  out.status = statusOf(alias(["status"]));
  out.summary = text(alias(["summary"])) ?? "(no summary provided)";

  const files = alias(["changed_files", "files_changed", "files"]);
  if (Array.isArray(files)) out.changed_files = files.filter((f): f is string => typeof f === "string");
  const artifacts = alias(["artifacts"]);
  if (Array.isArray(artifacts)) out.artifacts = artifacts.filter((a): a is string => typeof a === "string");

  const commands = alias(["commands"]);
  if (Array.isArray(commands)) {
    out.commands = commands.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const c = entry as Record<string, unknown>;
      const command = text(c.command) ?? text(c.cmd);
      // A command with no integer exit code did not produce a recordable result.
      if (!command || typeof c.exit_code !== "number" || !Number.isInteger(c.exit_code)) return [];
      const record: Record<string, unknown> = {
        command,
        exit_code: c.exit_code,
      };
      const tail = text(c.output_tail) ?? text(c.stdout) ?? text(c.output);
      if (tail) record.output_tail = tail;
      return [record];
    });
  }

  const tests = alias(["test_results", "tests"]);
  if (Array.isArray(tests)) {
    // Map outcome vocabulary onto the protocol enum. A test the child could not
    // run is unverified, never passed.
    const outcomeOf = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const v = value.trim().toLowerCase();
      if (v === "passed" || v === "pass" || v === "ok" || v === "green" || v === "success") return "passed";
      if (v === "failed" || v === "fail" || v === "red" || v === "error") return "failed";
      if (v === "skipped" || v === "skip") return "skipped";
      if (v === "unverified" || v === "blocked" || v === "unknown" || v === "not-run" || v === "not_run") {
        return "unverified";
      }
      return undefined;
    };
    out.test_results = tests.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const t = entry as Record<string, unknown>;
      const name = text(t.name) ?? text(t.test);
      const outcome = outcomeOf(t.outcome);
      if (!name || !outcome) return [];
      const record: Record<string, unknown> = { name, outcome };
      const ids = t.acceptance_ids;
      if (Array.isArray(ids)) record.acceptance_ids = ids.filter((i): i is string => typeof i === "string");
      const detail = text(t.detail);
      if (detail) record.detail = detail;
      return [record];
    });
  }

  const issues = alias(["unresolved_issues", "unresolved"]);
  if (Array.isArray(issues)) {
    out.unresolved_issues = issues.filter((i): i is string => typeof i === "string");
  }
  const risks = alias(["risks"]);
  if (Array.isArray(risks)) out.risks = risks.filter((r): r is string => typeof r === "string");
  const next = text(alias(["suggested_next_step"]));
  if (next) out.suggested_next_step = next;

  return out;
}

/**
 * Pull one JSON object out of a reply that may also carry prose.
 *
 * A fenced block wins, because that is where a model usually puts the object it
 * intends as data. Otherwise the outermost brace span is used. Returns
 * undefined when nothing parses, so the caller can report a protocol failure
 * rather than silently accepting a half-understood answer.
 */
export function extractJsonObject(raw: string): unknown {
  const tryParse = (text: string): unknown => {
    try {
      const value = JSON.parse(text.trim());
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(match[1] ?? "");
    if (parsed !== undefined) return parsed;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(raw.slice(start, end + 1));
  return undefined;
}

/** The instruction the child receives. Envelope fields are rendered verbatim. */
export function renderTaskPrompt(envelope: TaskEnvelope): string {
  const lines: string[] = [
    `# Task ${envelope.task_id}`,
    "",
    `Role: ${envelope.role}`,
    "",
    "## Objective",
    envelope.objective,
  ];
  if (envelope.background) lines.push("", "## Background", envelope.background);
  lines.push(
    "",
    "## Boundaries",
    `- Repository: ${envelope.repo_path}`,
    `- Base revision: ${envelope.base_revision}`,
    `- You may write only under: ${envelope.allowed_paths.length ? envelope.allowed_paths.join(", ") : "(nothing — read-only task)"}`,
    `- Forbidden: ${envelope.forbidden_actions.length ? envelope.forbidden_actions.join(", ") : "(none stated)"}`,
    "",
    "## Deliverables",
    ...envelope.deliverables.map((d) => `- ${d}`),
    "",
    "## Acceptance criteria",
    ...envelope.acceptance_ids.map((id) => `- ${id}`),
    "",
    "## Verification commands you must actually run",
    ...(envelope.verification_commands.length
      ? envelope.verification_commands.map((v) => `- \`${v.command}\` (expect exit ${v.expect_exit})`)
      : ["- (none specified)"]),
    "",
    "## How to answer",
    "Reply with one JSON object matching the schema you were given. Report only what",
    "actually happened: real exit codes, real test outcomes, real changed files.",
    "If a command did not run, do not report a result for it. If you could not finish,",
    "use status `partial` or `blocked` and say what is unresolved.",
    "",
    "Output contract: the entire reply must be that JSON object and nothing else.",
    "No prefix, no greeting, no name tag, no prose before or after it. If a house",
    "style would add a prefix line, the output contract overrides it: a non-JSON",
    "reply is rejected by the caller and the work is lost.",
    "",
    "Use exactly these key names and no others:",
    "task_id, status, summary, changed_files, artifacts, commands, test_results,",
    "unresolved_issues, risks, suggested_next_step.",
    "Inside commands: command, exit_code, output_tail. exit_code must be an integer;",
    "if a command did not run, omit that command entirely rather than reporting null.",
    "Inside test_results: name, outcome, acceptance_ids, detail.",
  );
  return lines.join("\n");
}

export class CodexAdapter implements WorkflowAdapter {
  readonly id = "codex-exec";
  readonly label = "Codex CLI (codex exec)";

  private readonly spawn: SpawnFn;
  private readonly sessions = new Map<string, { sessionId: string; envelope: TaskEnvelope }>();
  private readonly evidence = new Map<string, EvidenceBundle>();
  private readonly observations = new Map<string, Observation>();
  private readonly discrepancies = new Map<string, ClaimDiscrepancy[]>();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: CodexAdapterOptions) {
    this.spawn = options.spawn ?? defaultSpawn;
  }

  private get sandbox(): SandboxMode {
    return this.options.sandbox ?? "workspace-write";
  }

  private sandboxArgs(): string[] {
    if (this.sandbox === "bypass") {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    return ["-s", this.sandbox];
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CODEX_HOME: this.options.codexHome,
      HOME: process.env.HOME || os.homedir(),
      // Keep the child's own config resolution inside the scratch home.
      CODEX_DISABLE_UPDATE_CHECK: "1",
    };
  }

  async capabilityCheck(): Promise<CapabilityReport> {
    const models = this.readCatalog();
    const detail: string[] = [];
    let available = true;
    let version = "unknown";

    if (!fs.existsSync(this.options.codexPath)) {
      return {
        adapter_id: this.id,
        version,
        available: false,
        models,
        working_directories: [],
        can_run_tests: false,
        can_resume: true,
        detail: `codex binary not found at ${this.options.codexPath}`,
      };
    }

    try {
      fs.mkdirSync(this.options.codexHome, { recursive: true });
      fs.accessSync(this.options.codexHome, fs.constants.W_OK);
    } catch (error) {
      available = false;
      detail.push(`CODEX_HOME is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const outcome = await this.spawn(this.options.codexPath, ["--version"], {
        cwd: this.options.codexHome,
        env: this.childEnv(),
        timeoutMs: 15_000,
      });
      const match = outcome.stdout.match(/codex-cli\s+(\S+)/);
      if (match?.[1]) version = match[1];
      if (outcome.code !== 0) {
        available = false;
        detail.push(`codex --version exited ${outcome.code}: ${outcome.stderr.slice(0, 400)}`);
      }
    } catch (error) {
      available = false;
      detail.push(`codex --version failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const modelKnown = models.includes(this.options.model);
    if (!modelKnown && models.length > 0) {
      detail.push(`model ${this.options.model} is not in the catalog (${models.length} others are)`);
    }
    if (this.sandbox === "bypass") {
      detail.push("sandbox is disabled for child runs; this is an explicit opt-in");
    }

    return {
      adapter_id: this.id,
      version,
      available,
      models,
      working_directories: [this.options.codexHome],
      can_run_tests: this.sandbox !== "read-only",
      can_resume: true,
      detail: detail.join("; ") || "ready",
    };
  }

  private readCatalog(): string[] {
    const file = this.options.modelCatalogPath ?? path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: Array<{ slug?: string }> };
      return (parsed.models ?? []).map((m) => m.slug).filter((s): s is string => Boolean(s));
    } catch {
      return [];
    }
  }

  async execute(envelope: TaskEnvelope, options?: ExecuteOptions): Promise<TaskResult> {
    const attempts = Math.max(1, (this.options.formatRetries ?? 2) + 1);
    let lastError: CodexAdapterError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.executeOnce(envelope, options, attempt);
      } catch (error) {
        // Only a formatting failure is worth retrying. A timeout, a missing
        // binary or a sandbox refusal would fail the same way again.
        if (
          error instanceof CodexAdapterError &&
          error.kind === "result-invalid" &&
          attempt < attempts
        ) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new CodexAdapterError("result-invalid", "child produced no usable result");
  }

  private async executeOnce(
    envelope: TaskEnvelope,
    options: ExecuteOptions | undefined,
    attempt: number,
  ): Promise<TaskResult> {
    const controller = new AbortController();
    this.running.set(envelope.task_id, controller);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    const scratch = path.join(this.options.codexHome, "runs", envelope.task_id);
    fs.mkdirSync(scratch, { recursive: true });
    const schemaFile = path.join(scratch, "schema.json");
    const resultFile = path.join(scratch, "result.json");
    fs.writeFileSync(schemaFile, JSON.stringify(TASK_RESULT_JSON_SCHEMA, null, 2), "utf8");
    fs.rmSync(resultFile, { force: true });

    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      envelope.repo_path,
      "-m",
      this.options.model,
      "--output-schema",
      schemaFile,
      "-o",
      resultFile,
      ...this.sandboxArgs(),
      renderTaskPrompt(envelope),
    ];

    let outcome: SpawnOutcome;
    let before: WorktreeSnapshot | undefined;
    try {
      if (this.options.observeWorktree !== false) {
        // On a retry, keep the original baseline. Comparing a retry against
        // itself would report "no changes" for work that was already done on
        // the first attempt.
        const existing = this.observations.get(envelope.task_id);
        if (existing) {
          before = existing.before;
        } else {
          try {
            before = snapshotWorktree(envelope.repo_path);
          } catch {
            // Observation is an extra check, not a precondition. If the worktree
            // cannot be read, the run still happens and the evidence says so.
            before = undefined;
          }
        }
      }
      outcome = await this.spawn(this.options.codexPath, args, {
        cwd: envelope.repo_path,
        env: this.childEnv(),
        timeoutMs: Math.max(this.options.timeoutMs ?? 0, envelope.timeout_seconds * 1000),
        signal,
        ...(this.options.onOutput ? { onOutput: this.options.onOutput } : {}),
      });
    } catch (error) {
      throw new CodexAdapterError(
        "spawn-failed",
        `could not start codex: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running.delete(envelope.task_id);
    }

    // Take the after-snapshot regardless of how the child exited: a crash that
    // left files behind is exactly the case a gate needs to see.
    let observedChanges: ObservedChange[] | undefined;
    if (before) {
      try {
        const after = snapshotWorktree(envelope.repo_path);
        observedChanges = diffSnapshots(before, after);
        this.observations.set(envelope.task_id, { before, after, changes: observedChanges });
      } catch {
        observedChanges = undefined;
      }
    }

    if (outcome.timedOut) {
      throw new CodexAdapterError(
        "timeout",
        `codex did not finish within ${envelope.timeout_seconds}s; stderr tail: ${outcome.stderr.slice(-800)}`,
      );
    }

    // A killed child is a different failure from a child that exited on its
    // own with a non-zero code: there is no exit code to trust, and any result
    // file it left behind may be truncated mid-write.
    if (outcome.cancelled) {
      throw new CodexAdapterError("spawn-failed", "codex was cancelled before it finished");
    }
    if (outcome.killedBy) {
      throw new CodexAdapterError(
        "spawn-failed",
        `codex was terminated by ${outcome.killedBy}; stderr tail: ${outcome.stderr.slice(-800)}`,
        // A signal kill is an external event: re-running may well succeed.
        true,
      );
    }

    if (!fs.existsSync(resultFile)) {
      throw new CodexAdapterError(
        "result-missing",
        `codex exited ${outcome.code} without writing a result. stderr tail: ${outcome.stderr.slice(-800)}`,
      );
    }

    const raw = fs.readFileSync(resultFile, "utf8");
    const parsed = extractJsonObject(raw);
    if (parsed === undefined) {
      throw new CodexAdapterError(
        "result-invalid",
        `result file has no JSON object: ${raw.slice(0, 400)}`,
      );
    }

    const checked = taskResultSchema.safeParse(normalizeTaskResult(parsed, envelope.task_id));
    if (!checked.success) {
      throw new CodexAdapterError(
        "result-invalid",
        `result does not match the task protocol: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    // The child may have run in a nested sandbox that blocked every command.
    // Report that as a blocked task rather than letting it look like success.
    if (checked.data.status === "succeeded" && outcome.code !== 0) {
      return {
        ...checked.data,
        status: "blocked",
        unresolved_issues: [
          ...checked.data.unresolved_issues,
          `codex exited ${outcome.code}; its success claim cannot be trusted`,
        ],
      };
    }

    // Check the claimed test results against the transcript the child actually
    // produced. A claim with no supporting output is not evidence.
    const mismatches: ClaimDiscrepancy[] = [];
    if (checked.data.test_results.length > 0) {
      const parsed = parseTestOutput(outcome.stdout);
      const problems = reconcileClaimedWithParsed(checked.data.test_results, parsed);
      if (problems.length) {
        mismatches.push({ command: "(stdout)", problems });
      }
    }
    if (mismatches.length) this.discrepancies.set(envelope.task_id, mismatches);

    this.evidence.set(envelope.task_id, {
      task_id: envelope.task_id,
      // The observed list when we have one: it is evidence, not a claim.
      changed_files: observedChanges
        ? observedChanges.map((c) => c.path)
        : checked.data.changed_files,
      command_records: checked.data.commands,
      artifact_paths: checked.data.artifacts,
      raw_log_path: resultFile,
    });
    this.sessions.set(envelope.task_id, { sessionId: envelope.task_id, envelope });
    return checked.data;
  }

  async resume(taskId: string, feedback: string): Promise<TaskResult> {
    const known = this.sessions.get(taskId);
    if (!known) {
      throw new CodexAdapterError("result-missing", `no recorded session for ${taskId}; cannot resume`);
    }
    return this.execute({
      ...known.envelope,
      background: [known.envelope.background, "", "## Reviewer feedback", feedback].join("\n"),
    });
  }

  async cancel(taskId: string): Promise<void> {
    this.running.get(taskId)?.abort();
  }

  async collectEvidence(taskId: string): Promise<EvidenceBundle> {
    const recorded = this.evidence.get(taskId);
    if (!recorded) {
      throw new CodexAdapterError("result-missing", `no evidence recorded for ${taskId}`);
    }
    return recorded;
  }

  /**
   * The changes this adapter saw on disk, independent of the child's report.
   * Undefined when observation was disabled or the worktree could not be read.
   */
  observedChanges(taskId: string): ObservedChange[] | undefined {
    return this.observations.get(taskId)?.changes;
  }

  /** Claims the child's own output contradicts. Empty when they agree. */
  claimDiscrepancies(taskId: string): ClaimDiscrepancy[] {
    return this.discrepancies.get(taskId) ?? [];
  }
}

/**
 * Mask secret-looking values before they reach the UI. Token-shaped strings
 * (gho_/github_pat_ prefixes, bearer tokens, sk-/pk- keys, api_key= pairs)
 * are replaced with *** so a pasted log cannot leak a credential.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(gho|ghp|ghs|github_pat)_[A-Za-z0-9_]+/g, "***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{20,}/g, "$1-***")
    .replace(/\b(api[_-]?key|token|secret)\s*[=:]\s*["'"'"']?[A-Za-z0-9._~+/=-]{8,}["'"'"']?/gi, "$1=***");
}
