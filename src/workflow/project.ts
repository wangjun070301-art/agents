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
