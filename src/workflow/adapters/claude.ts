import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { TaskEnvelope, TaskResult } from "../contracts.js";
import type { CapabilityReport, EvidenceBundle, ExecuteOptions, WorkflowAdapter } from "../adapters.js";
import { extractJsonObject, normalizeTaskResult, renderTaskPrompt } from "./codex.js";

/**
 * Claude Code as a workflow adapter.
 *
 * Claude Code runs as `claude -p <prompt> --output-format json`, which prints
 * one JSON envelope when the turn ends. The task result lives in the envelope's
 * `result` field, not on disk, so it is extracted from stdout.
 *
 * The model name is a real constraint on this machine: the gateway offers names
 * like `Deepseek-V4-Pro (3.60x)`, and Claude Code appends `[1m]` to any name it
 * does not recognise, which the gateway then rejects with a 404. The adapter
 * reports that at capability check instead of failing every task.
 */
export interface ClaudeAdapterOptions {
  /** Absolute path to the claude executable. */
  claudePath: string;
  /** Working directory for the child. */
  repoPath: string;
  /** Model id passed to --model. Omitted means the agent's own default. */
  model?: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export class ClaudeAdapterError extends Error {
  constructor(
    readonly kind: "binary-missing" | "spawn-failed" | "timeout" | "result-invalid" | "unavailable",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ClaudeAdapterError";
  }
}

export class ClaudeAdapter implements WorkflowAdapter {
  readonly id = "claude";
  readonly label = "Claude Code";
  private readonly sessions = new Map<string, TaskEnvelope>();
  private readonly evidence = new Map<string, EvidenceBundle>();

  constructor(private readonly options: ClaudeAdapterOptions) {}

  async capabilityCheck(): Promise<CapabilityReport> {
    const base: CapabilityReport = {
      adapter_id: this.id,
      version: "unknown",
      available: false,
      models: [],
      working_directories: [],
      can_run_tests: false,
      can_resume: true,
      detail: "",
    };

    if (!fs.existsSync(this.options.claudePath)) {
      return { ...base, detail: `找不到 claude 可执行文件：${this.options.claudePath}` };
    }

    const blocked = this.gatewayModelProblem();
    if (blocked) return { ...base, detail: blocked };

    return {
      ...base,
      available: true,
      working_directories: [this.options.repoPath],
      can_run_tests: true,
      detail: "ready",
    };
  }

  /**
   * A gateway that rejects the model name makes every task fail with a 404.
   * Saying so once here is better than each task discovering it separately.
   */
  private gatewayModelProblem(): string | undefined {
    const settings = path.join(os.homedir(), ".claude", "settings.json");
    let model = this.options.model ?? "";
    try {
      const raw = JSON.parse(fs.readFileSync(settings, "utf8")) as { env?: Record<string, string> };
      model = model || raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL || "";
    } catch {
      return undefined;
    }
    if (!model) return undefined;
    if (model.includes("[")) {
      return `模型名 ${model} 带上下文后缀，当前网关不接受`;
    }
    if (/\s\(.*\)$/.test(model)) {
      return `模型名 ${model} 含空格和括号；Claude Code 会追加 [1m]，当前网关拒绝该名称`;
    }
    return undefined;
  }

  async execute(envelope: TaskEnvelope, options?: ExecuteOptions): Promise<TaskResult> {
    this.sessions.set(envelope.task_id, envelope);
    return this.run(envelope, options);
  }

  async resume(taskId: string, feedback: string): Promise<TaskResult> {
    const known = this.sessions.get(taskId);
    if (!known) throw new ClaudeAdapterError("result-invalid", `no recorded session for ${taskId}`);
    return this.run(
      { ...known, background: [known.background, "", "## Reviewer feedback", feedback].join("\n") },
      undefined,
    );
  }

  async cancel(_taskId: string): Promise<void> {
    // One-shot child; the panel's AbortSignal is what actually stops it.
  }

  async collectEvidence(taskId: string): Promise<EvidenceBundle> {
    const recorded = this.evidence.get(taskId);
    if (!recorded) throw new ClaudeAdapterError("result-invalid", `no evidence recorded for ${taskId}`);
    return recorded;
  }

  private run(envelope: TaskEnvelope, options?: ExecuteOptions): Promise<TaskResult> {
    const prompt = `${renderTaskPrompt(envelope)}\n\nReturn the JSON object described above and nothing else.`;
    const args = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"];
    if (this.options.model) args.push("--model", this.options.model);

    return new Promise<TaskResult>((resolve, reject) => {
      const child = spawn(this.options.claudePath, args, {
        cwd: envelope.repo_path,
        windowsHide: true,
        env: { ...process.env },
      });
      let stdout = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, Math.max(this.options.timeoutMs ?? 0, envelope.timeout_seconds * 1000));

      const onAbort = () => child.kill("SIGKILL");
      options?.signal?.addEventListener("abort", onAbort);

      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        this.options.onOutput?.(text);
      });
      child.stderr?.on("data", () => {
        // Claude Code writes progress to stderr; the panel only shows stdout.
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        reject(new ClaudeAdapterError("spawn-failed", `无法启动 claude：${error.message}`));
      });
      child.on("close", () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          reject(new ClaudeAdapterError("timeout", `claude 在 ${envelope.timeout_seconds}s 内没有结束`));
          return;
        }
        const parsed = extractJsonObject(stdout) as
          | { result?: string; is_error?: boolean; api_error_status?: number }
          | undefined;
        if (parsed === undefined) {
          reject(new ClaudeAdapterError("result-invalid", `claude 没有返回 JSON：${stdout.slice(0, 400)}`));
          return;
        }
        if (parsed.is_error) {
          reject(
            new ClaudeAdapterError(
              "unavailable",
              `claude 报错（HTTP ${parsed.api_error_status ?? "?"}）：${parsed.result ?? ""}`,
            ),
          );
          return;
        }
        const inner = extractJsonObject(String(parsed.result ?? ""));
        if (inner === undefined) {
          reject(
            new ClaudeAdapterError(
              "result-invalid",
              `claude 的 result 字段里没有任务结果：${String(parsed.result).slice(0, 400)}`,
            ),
          );
          return;
        }
        const result = normalizeTaskResult(inner, envelope.task_id) as unknown as TaskResult;
        this.evidence.set(envelope.task_id, {
          task_id: envelope.task_id,
          changed_files: [...(result.changed_files ?? [])],
          command_records: [...(result.commands ?? [])],
          artifact_paths: [...(result.artifacts ?? [])],
        });
        resolve(result);
      });
    });
  }
}
