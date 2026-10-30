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

  async checkAll(): Promise<CapabilityReport[]> {
    const reports: CapabilityReport[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        reports.push(await adapter.capabilityCheck());
      } catch (error) {
        reports.push({
          adapter_id: adapter.id,
          version: "unknown",
          available: false,
          models: [],
          working_directories: [],
          can_run_tests: false,
          can_resume: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reports;
  }
}
