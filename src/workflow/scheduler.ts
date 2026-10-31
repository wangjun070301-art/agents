import fs from "node:fs";
import path from "node:path";
import type { TaskEnvelope, TaskResult, Requirements, Stage } from "./contracts.js";
import { claimIsSupported, validateTaskResult } from "./contracts.js";
import type { WorkflowAdapter, EvidenceBundle } from "./adapters.js";
import { Pipeline, type ProjectState, type StageRecord } from "./pipeline.js";
import type { GateInput } from "./gates.js";

/** What a single task run produced, whether or not it passed a gate. */
export interface TaskAttempt {
  attempt: number;
  envelope: TaskEnvelope;
  result?: TaskResult;
  evidence?: EvidenceBundle;
  observedChanges?: string[];
  claimDiscrepancies?: Array<{ command: string; problems: string[] }>;
  /** Why this attempt was not accepted, when it was not. */
  refusal?: string;
  startedAt: string;
  finishedAt: string;
}

/** A task that could not be completed, with the reason it stopped. */
export interface TaskFailure {
  taskId: string;
  attempts: TaskAttempt[];
  reason: "gate-refused" | "adapter-error" | "attempts-exhausted" | "no-progress";
  detail: string;
}

export interface SchedulerOptions {
  /** Adapter to execute tasks with. */
  adapter: WorkflowAdapter;
  /** Requirement set the project is judged against. */
  requirements: Requirements;
  /** The pipeline whose stage this scheduler advances. */
  pipeline: Pipeline;
  /** How many times a task may be re-dispatched after a refusal. */
  maxAttempts?: number;
  /**
   * Where to persist run state. A directory, not a file, so history and per-task
   * records can be inspected separately.
   */
  stateDir?: string;
  /** Clock injection, so a test can assert timestamps. */
  now?: () => Date;
}

/**
 * One scheduler run: execute tasks, collect what actually happened, feed the
 * gates, and advance the pipeline only when the gate agrees.
 *
 * The scheduler never trusts a task's own claim: it asks the adapter for
 * evidence, asks it for observed changes and transcript discrepancies, and
 * passes all of that to the gate. A gate refusal is reported, not swallowed.
 */
export class Scheduler {
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * Execute one task and collect what it actually produced.
   *
   * This does not touch the pipeline. A stage advance is a decision about the
   * whole stage, not about one task: three tasks may be dispatched under
   * DISPATCH and the stage moves once, when all three are done and the gate
   * can see the combined evidence. `advanceStage` is that separate action.
   */
  async runTask(envelope: TaskEnvelope): Promise<{ ok: boolean; attempts: TaskAttempt[]; failure?: TaskFailure }> {
    const attempts: TaskAttempt[] = [];
    let feedback: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const startedAt = this.timestamp();
      const taskEnvelope: TaskEnvelope = feedback
        ? { ...envelope, background: [envelope.background, "", "## Previous refusal", feedback].join("\n") }
        : envelope;

      let result: TaskResult;
      try {
        result = feedback
          ? await this.options.adapter.resume(envelope.task_id, feedback)
          : await this.options.adapter.execute(taskEnvelope);
      } catch (error) {
        const finishedAt = this.timestamp();
        const failure: TaskFailure = {
          taskId: envelope.task_id,
          attempts,
          reason: "adapter-error",
          detail: error instanceof Error ? error.message : String(error),
        };
        this.persistFailure(failure);
        return { ok: false, attempts, failure };
      }

      // Evidence is collected from the adapter, not derived from the result.
      let evidence: EvidenceBundle | undefined;
      try {
        evidence = await this.options.adapter.collectEvidence(envelope.task_id);
      } catch {
        evidence = undefined;
      }

      const observed = readObserved(this.options.adapter, envelope.task_id);
      const discrepancies = readDiscrepancies(this.options.adapter, envelope.task_id);
      const finishedAt = this.timestamp();

      const record: TaskAttempt = {
        attempt,
        envelope: taskEnvelope,
        result,
        evidence,
        observedChanges: observed,
        claimDiscrepancies: discrepancies,
        startedAt,
        finishedAt,
      };
      attempts.push(record);
      this.persistAttempt(record);

      // A task is "done" when its own claim is supported by the evidence the
      // adapter collected. The stage gate is a separate, stronger question.
      const refusal = taskRefusal(envelope, result, observed, discrepancies);
      if (refusal === undefined) return { ok: true, attempts };
      record.refusal = refusal;
      feedback = refusal;
    }

    const failure: TaskFailure = {
      taskId: envelope.task_id,
      attempts,
      reason: attempts.length === 0 ? "no-progress" : "attempts-exhausted",
      detail: attempts.at(-1)?.refusal ?? "no attempt was made",
    };
    this.persistFailure(failure);
    return { ok: false, attempts, failure };
  }

  /**
   * Advance the pipeline by evaluating the gate on an edge.
   *
   * This is the only place the scheduler moves a stage, and it only moves when
   * the gate agrees. Everything the gate needs comes from `state`, which the
   * caller assembles from what was actually observed.
   */
  advanceStage(
    to: Stage,
    state: ProjectState,
    note?: string,
  ): ReturnType<Pipeline["advance"]> {
    return this.options.pipeline.advance({
      to,
      gateInput: buildGateInput(state),
      ...(note ? { note } : {}),
    });
  }

  /**
   * Run a plan in dependency order. A task whose dependency failed is not run,
   * because its evidence would be built on work that was never accepted.
   */
  async runPlan(
    tasks: TaskEnvelope[],
  ): Promise<{
    completed: string[];
    failed: TaskFailure[];
    skipped: Array<{ taskId: string; because: string }>;
  }> {
    const completed = new Set<string>();
    const failed: TaskFailure[] = [];
    const skipped: Array<{ taskId: string; because: string }> = [];
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const pending = new Set(tasks.map((t) => t.task_id));

    while (pending.size > 0) {
      const ready = [...pending]
        .map((id) => byId.get(id)!)
        .filter((task) => task.dependencies.every((d) => !byId.has(d) || completed.has(d) || failed.some((f) => f.taskId === d)));

      if (ready.length === 0) {
        // Everything left is waiting on something that will never finish.
        for (const id of pending) {
          const task = byId.get(id)!;
          const blocker = task.dependencies.find((d) => !completed.has(d) && !failed.some((f) => f.taskId === d));
          skipped.push({ taskId: id, because: blocker ? `waiting on ${blocker}` : "dependency cycle" });
        }
        break;
      }

      for (const task of ready) {
        const blocked = task.dependencies.find((d) => failed.some((f) => f.taskId === d));
        if (blocked) {
          skipped.push({ taskId: task.task_id, because: `dependency ${blocked} failed` });
          pending.delete(task.task_id);
          continue;
        }
        const outcome = await this.runTask(task);
        pending.delete(task.task_id);
        if (outcome.ok) completed.add(task.task_id);
        else if (outcome.failure) failed.push(outcome.failure);
      }
    }

    return { completed: [...completed], failed, skipped };
  }

  /** Every stage change recorded so far, including refusals' absence. */
  get history(): StageRecord[] {
    return this.options.pipeline.history;
  }

  private persistAttempt(record: TaskAttempt): void {
    if (!this.options.stateDir) return;
    const dir = path.join(this.options.stateDir, "tasks", record.envelope.task_id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `attempt-${record.attempt}.json`);
    fs.writeFileSync(file, JSON.stringify(serializeAttempt(record), null, 2), "utf8");
  }

  private persistFailure(failure: TaskFailure): void {
    if (!this.options.stateDir) return;
    const dir = path.join(this.options.stateDir, "tasks", failure.taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "failure.json"),
      JSON.stringify(failure, null, 2),
      "utf8",
    );
  }
}

/** Gate input assembled from what was actually observed. */
function buildGateInput(state: ProjectState): GateInput {
  // `tasks` is read by G1 only, and its type is the widened GateInput plus the
  // optional plan list, so the object is typed accordingly.
  const input: GateInput & { tasks?: TaskEnvelope[] } = {
    requirements: state.requirements,
    tasks: state.tasks,
    envelope: state.envelope,
    result: state.result,
    deliveredArtifact: state.deliveredArtifact,
    changedFiles: state.changedFiles,
    // These three are the gate inputs that only exist after their stage has
    // run. Dropping them silently made G3 and G4 reject work that was done.
    reviewFindings: state.reviewFindings,
    verifications: state.verifications,
    recorded: state.recorded,
    claimDiscrepancies: state.claimDiscrepancies,
  };
  return input;
}

/**
 * Decide whether one task's own evidence supports its claim.
 *
 * This is the per-task question, not the stage question: it asks whether the
 * adapter's collected evidence backs what the result says, using the same
 * reconciliation the protocol defines. The stage gate runs later on the
 * combined state.
 */
function taskRefusal(
  envelope: TaskEnvelope,
  result: TaskResult,
  observed: string[] | undefined,
  discrepancies: Array<{ command: string; problems: string[] }> | undefined,
): string | undefined {
  const problems = validateTaskResult(envelope, result);
  if (problems.length) return problems.join("; ");
  if (!claimIsSupported(result, envelope)) {
    return `the ${result.status} claim is not supported by the returned evidence`;
  }
  if (discrepancies?.length) {
    return discrepancies
      .map((d) => `${d.command}: ${d.problems.join("; ")}`)
      .join(" | ");
  }
  // Observed changes are the independent record. When the adapter can see the
  // worktree, a reported list that disagrees with it is a refusal.
  if (observed) {
    const fold = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const seen = new Set(observed.map(fold));
    const claimed = new Set(result.changed_files.map(fold));
    const missing = result.changed_files.filter((f) => !seen.has(fold(f)));
    const extra = observed.filter((f) => !claimed.has(fold(f)));
    if (missing.length) return `reported but not observed: ${missing.join(", ")}`;
    if (extra.length) return `observed but not reported: ${extra.join(", ")}`;
  }
  return undefined;
}

/** An adapter may or may not expose observation; ask only when it does. */
function readObserved(adapter: WorkflowAdapter, taskId: string): string[] | undefined {
  const maybe = adapter as WorkflowAdapter & { observedChanges?: (id: string) => Array<{ path: string }> | undefined };
  if (typeof maybe.observedChanges !== "function") return undefined;
  const changes = maybe.observedChanges(taskId);
  return changes?.map((c) => c.path);
}

function readDiscrepancies(
  adapter: WorkflowAdapter,
  taskId: string,
): Array<{ command: string; problems: string[] }> | undefined {
  const maybe = adapter as WorkflowAdapter & {
    claimDiscrepancies?: (id: string) => Array<{ command: string; problems: string[] }>;
  };
  if (typeof maybe.claimDiscrepancies !== "function") return undefined;
  const list = maybe.claimDiscrepancies(taskId);
  return list.length ? list : undefined;
}

/** A JSON-safe projection of an attempt, for the on-disk record. */
function serializeAttempt(record: TaskAttempt): unknown {
  return {
    attempt: record.attempt,
    taskId: record.envelope.task_id,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.result?.status,
    observedChanges: record.observedChanges,
    claimDiscrepancies: record.claimDiscrepancies,
    transition: {
      refusal: record.refusal,
    },
  };
}
