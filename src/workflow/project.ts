import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requirementsSchema, taskEnvelopeSchema } from "./contracts.js";

/**
 * A project the panel can operate. Everything a run needs lives here, so the
 * UI never has to guess: repo, model, sandbox, what to build, and how it will
 * be judged.
 */
export const projectSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    repo_path: z.string().trim().min(1),
    model: z.string().trim().min(1),
    /** Bypass is the only sandbox that can execute on this machine. */
    sandbox: z.enum(["read-only", "workspace-write", "bypass"]).default("bypass"),
    requirements: requirementsSchema,
    tasks: z.array(taskEnvelopeSchema).min(1),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const projectFile = (stateDir: string): string => path.join(stateDir, "project.json");

/**
 * Turn a Zod error into one sentence a person can act on.
 *
 * Zod's own message is a JSON dump of every issue, which reached the panel
 * verbatim when someone saved an empty form. Field paths are mapped to the
 * labels the form actually shows.
 */
const FIELD_LABELS: Record<string, string> = {
  name: "项目名称",
  repo_path: "代码目录",
  model: "模型",
  sandbox: "沙箱",
  requirements: "需求",
  tasks: "任务",
};

export function describeProjectError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const parts = error.issues.map((issue) => {
      const key = String(issue.path[0] ?? "");
      const label = FIELD_LABELS[key] ?? key;
      if (issue.code === "too_small") {
        if (issue.type === "array") return `${label}至少要有 1 条`;
        return `${label}不能为空`;
      }
      if (issue.code === "too_big") return `${label}太长了`;
      if (issue.code === "invalid_enum_value") return `${label}的取值不对`;
      if (issue.code === "invalid_type") return `${label}格式不对`;
      if (issue.code === "unrecognized_keys") return `${label}里有不认识的字段`;
      return `${label}：${issue.message}`;
    });
    return parts.join("；");
  }
  return error instanceof Error ? error.message : String(error);
}

export function readProject(stateDir: string): Project | undefined {
  const file = projectFile(stateDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    return projectSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export function writeProject(stateDir: string, raw: unknown): Project {
  const project = projectSchema.parse(raw);
  if (!fs.existsSync(project.repo_path)) {
    throw new Error(`repo_path does not exist: ${project.repo_path}`);
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(projectFile(stateDir), JSON.stringify(project, null, 2), "utf8");
  return project;
}

/** Where the adapter keeps its own writable home, separate from the user's. */
export const codexHomeFor = (stateDir: string): string => path.join(stateDir, "codex-home");

/** Default codex binary location on this machine, overridable by env. */
export const defaultCodexPath = (): string =>
  process.env.CODEX_BIN ??
  "C:\\Users\\13420\\AppData\\Local\\OpenAI\\Codex\\bin\\22cfb1d302613eae\\codex.exe";
