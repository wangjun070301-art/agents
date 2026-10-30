import type { TaskEnvelope, TaskResult } from "./contracts.js";

/** What an adapter reports about itself before it is trusted with work. */
export interface CapabilityReport {
  adapter_id: string;
  version: string;
  available: boolean;
  models: string[];
  working_directories: string[];
  can_run_tests: boolean;
  can_resume: boolean;
  detail: string;
}

/** Evidence an adapter can hand over after a run, independent of its claims. */
export interface EvidenceBundle {
  task_id: string;
  changed_files: string[];
  command_records: TaskResult["commands"];
  artifact_paths: string[];
  raw_log_path?: string;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}

/**
 * Section 3.1. Every agent enters through one of these. An adapter that cannot
 * answer a method throws AdapterUnavailable rather than returning a guess.
 */
export interface WorkflowAdapter {
  readonly id: string;
  readonly label: string;
  capabilityCheck(): Promise<CapabilityReport>;
  execute(envelope: TaskEnvelope, options?: ExecuteOptions): Promise<TaskResult>;
  resume(taskId: string, feedback: string): Promise<TaskResult>;
  cancel(taskId: string): Promise<void>;
  collectEvidence(taskId: string): Promise<EvidenceBundle>;
}

export class AdapterUnavailable extends Error {
  constructor(
    readonly adapterId: string,
    message: string,
  ) {
    super(message);
    this.name = "AdapterUnavailable";
  }
}

/** Registration is by id and rejects duplicates, so bindings cannot silently shadow. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, WorkflowAdapter>();

  register(adapter: WorkflowAdapter): this {
    if (typeof adapter.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(adapter.id)) {
      throw new Error(`Adapter id must match ^[a-z0-9][a-z0-9._-]{0,63}$: ${JSON.stringify(adapter.id)}`);
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter id already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  require(id: string): WorkflowAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new AdapterUnavailable(id, `Adapter ${id} is not registered`);
    return adapter;
  }

  list(): Array<{ id: string; label: string }> {
    return [...this.adapters.values()].map(({ id, label }) => ({ id, label }));
  }

  /** Every registered adapter is asked, in parallel, with its own deadline. */
  async checkAll(timeoutMs = 30_000, signal?: AbortSignal): Promise<CapabilityReport[]> {
    const deadline = (id: string, promise: Promise<CapabilityReport>): Promise<CapabilityReport> =>
      new Promise<CapabilityReport>((resolve) => {
        // unref so a one-shot caller is not held alive by the timer, and clear
        // it as soon as the adapter answers so timers do not accumulate.
        const timer = setTimeout(
          () =>
            resolve({
              adapter_id: id,
              version: "unknown",
              available: false,
              models: [],
              working_directories: [],
              can_run_tests: false,
              can_resume: false,
              detail: `capabilityCheck did not answer within ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
        // Deliberately referenced: a never-resolving adapter must still be able
        // to time out even when nothing else keeps the process alive.
        promise.then(
          (report) => {
            clearTimeout(timer);
            resolve(report);
          },
          // Settle the race so a rejection cannot leave the deadline hanging.
          (error) => {
            clearTimeout(timer);
            resolve({
              adapter_id: id,
              version: "unknown",
              available: false,
              models: [],
              working_directories: [],
              can_run_tests: false,
              can_resume: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          },
        );
      });

    const reports: CapabilityReport[] = [];
    const tasks = [...this.adapters.values()].map(async (adapter) => {
      if (signal?.aborted) {
        return {
          adapter_id: adapter.id,
          version: "unknown",
          available: false,
          models: [],
          working_directories: [],
          can_run_tests: false,
          can_resume: false,
          detail: "aborted before capability check",
        } satisfies CapabilityReport;
      }
      try {
        const report = await deadline(adapter.id, adapter.capabilityCheck());
        // Never let an adapter attribute its report to a different id.
        return { ...report, adapter_id: adapter.id };
      } catch (error) {
        return {
          adapter_id: adapter.id,
          version: "unknown",
          available: false,
          models: [],
          working_directories: [],
          can_run_tests: false,
          can_resume: false,
          detail: error instanceof Error ? error.message : String(error),
        } satisfies CapabilityReport;
      }
    });

    // Every task settles to a report, so a rejected adapter can never vanish
    // from the list and be mistaken for one that was never registered.
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "fulfilled") reports.push(result.value);
    }
    for (const id of this.adapters.keys()) {
      if (!reports.some((r) => r.adapter_id === id)) {
        reports.push({
          adapter_id: id,
          version: "unknown",
          available: false,
          models: [],
          working_directories: [],
          can_run_tests: false,
          can_resume: false,
          detail: "capability check produced no report",
        });
      }
    }
    return reports;
  }
}
