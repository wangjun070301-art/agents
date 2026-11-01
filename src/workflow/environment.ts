import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * What this machine already has, so the panel does not ask for it.
 *
 * Every field here is something a user would otherwise have to type: the
 * codex binary, the model id, the sandbox mode, whether they are signed in.
 * Reading them costs one filesystem pass and removes four inputs from the
 * first screen.
 */
export interface Environment {
  /** Absolute path to the codex binary, when one was found. */
  codexPath?: string;
  /** Where the probe looked, so a failure can say what was tried. */
  codexSearched: string[];
  /** True when auth.json exists in the codex home. */
  signedIn: boolean;
  /** Model ids the local catalog offers. Empty when no catalog exists. */
  models: string[];
  /** The model this machine is currently configured for, when known. */
  defaultModel?: string;
  /** Sandbox modes this build accepts. Bypass is required here. */
  sandboxes: string[];
  /** Default sandbox for a new project. */
  defaultSandbox: string;
  /** Working directory offered as the starting repo path. */
  suggestedRepo?: string;
  /** One-line summary a person can read at a glance. */
  summary: string;
}

const SANDBOXES = ["bypass", "workspace-write", "read-only"];

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/**
 * Candidate locations for the codex binary.
 *
 * The Windows app keeps a hash-named folder per install, so a single hardcoded
 * path goes stale on the next update. Globbing the parent covers that.
 */
function codexCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN);

  const roots = [
    path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin"),
    path.join(os.homedir(), ".codex", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const name of ["codex.exe", "codex"]) {
            candidates.push(path.join(root, entry.name, name));
          }
        }
      }
    } catch {
      // Directory absent; the next candidate may still exist.
    }
  }
  candidates.push("codex");
  return candidates;
}

function findCodex(): { path?: string; searched: string[] } {
  const searched: string[] = [];
  for (const candidate of codexCandidates()) {
    searched.push(candidate);
    if (candidate === "codex") {
      // Last resort: ask PATH. `where`/`which` both write the resolved path.
      try {
        const cmd = process.platform === "win32" ? "where" : "which";
        const found = execFileSync(cmd, ["codex"], { encoding: "utf8", timeout: 2000 })
          .split(/\r?\n/)[0]
          ?.trim();
        if (found && fs.existsSync(found)) return { path: found, searched };
      } catch {
        // Not on PATH.
      }
      continue;
    }
    if (fs.existsSync(candidate)) return { path: candidate, searched };
  }
  return { searched };
}

function readModels(home: string): { models: string[]; configured?: string } {
  const models: string[] = [];
  let configured: string | undefined;

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "cc-switch-model-catalog.json"), "utf8")) as {
      models?: Array<{ slug?: string; visibility?: string }>;
    };
    for (const model of raw.models ?? []) {
      // `visibility: "list"` is what the app itself shows; hidden ones stay out.
      if (typeof model.slug === "string" && model.visibility !== "hide") models.push(model.slug);
    }
  } catch {
    // No catalog: the model list stays empty and the panel falls back to free text.
  }

  try {
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    const match = toml.match(/^model\s*=\s*"([^"]+)"$/m);
    if (match?.[1]) configured = match[1];
  } catch {
    // No config: leave the default unset.
  }

  // A configured model the catalog does not list cannot be selected from a
  // dropdown, so prefer a listed one and keep the config value only as a hint.
  if (configured && !models.includes(configured)) configured = undefined;
  return { models, ...(configured ? { configured } : {}) };
}

export function detectEnvironment(): Environment {
  const home = codexHome();
  const codex = findCodex();
  const catalog = readModels(home);
  const signedIn = fs.existsSync(path.join(home, "auth.json"));

  const defaultModel = catalog.configured ?? catalog.models[0];

  let suggestedRepo: string | undefined;
  try {
    const cwd = process.cwd();
    if (fs.statSync(cwd).isDirectory()) suggestedRepo = cwd;
  } catch {
    suggestedRepo = undefined;
  }

  const parts: string[] = [];
  parts.push(codex.path ? "已找到 Codex" : "没找到 Codex 命令");
  parts.push(signedIn ? "已登录" : "未登录");
  parts.push(catalog.models.length ? `${catalog.models.length} 个可用模型` : "没读到模型列表");

  return {
    ...(codex.path ? { codexPath: codex.path } : {}),
    codexSearched: codex.searched,
    signedIn,
    models: catalog.models,
    ...(defaultModel ? { defaultModel } : {}),
    sandboxes: SANDBOXES,
    defaultSandbox: "bypass",
    ...(suggestedRepo ? { suggestedRepo } : {}),
    summary: parts.join(" · "),
  };
}
