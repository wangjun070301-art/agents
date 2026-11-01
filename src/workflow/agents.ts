import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Which coding agents exist on this machine, and who is allowed to play which
 * role.
 *
 * The pipeline has six capability slots (analyst, architect, developer,
 * reviewer, tester, integrator). A slot is protocol; an agent is configuration.
 * This module answers two questions the panel needs: which agents can actually
 * run here, and which of them a person has assigned to each slot.
 */
export type AgentId = "codex" | "claude" | "deepseek-harness" | "workbuddy";

export interface AgentInfo {
  id: AgentId;
  /** Name a person recognises. */
  label: string;
  /** Absolute path to the executable, when found. */
  binary?: string;
  /** Version string, when the binary answered. */
  version?: string;
  /** False when the binary is missing or the agent cannot run here. */
  available: boolean;
  /** Why it is unavailable, or what blocks it. Empty when it works. */
  reason: string;
}

/**
 * Role assignment: which agent handles which slot.
 *
 * `undefined` means the default (codex for everything), so a fresh install
 * needs no configuration at all.
 */
export interface RoleBindings {
  analyst?: AgentId;
  architect?: AgentId;
  developer?: AgentId;
  reviewer?: AgentId;
  tester?: AgentId;
  integrator?: AgentId;
}

export const ROLES = ["analyst", "architect", "developer", "reviewer", "tester", "integrator"] as const;
export type Role = (typeof ROLES)[number];

const LABELS: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  "deepseek-harness": "DeepSeek Harness",
  workbuddy: "WorkBuddy",
};

function findBinary(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === "" ) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Codex ships in a hash-named directory that changes on update, so the parent
 * is globbed rather than a single path hardcoded.
 */
function findCodex(): string | undefined {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const root = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of ["codex.exe", "codex"]) {
        const candidate = path.join(root, entry.name, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Not installed at the Windows default location.
  }
  return undefined;
}

/**
 * Claude Code installs a .ps1/.cmd shim next to a real executable. The shim
 * cannot be spawned directly by a child process without a shell, so the
 * underlying binary is what gets returned.
 */
function findClaude(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude"),
    "D:\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  ];
  const direct = findBinary(candidates);
  if (direct) return direct;
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
      encoding: "utf8",
      timeout: 2000,
    })
      .split(/\r?\n/)[0]
      ?.trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    // Not on PATH.
  }
  return undefined;
}

function versionOf(binary: string, args = ["--version"]): string | undefined {
  try {
    const out = execFileSync(binary, args, { encoding: "utf8", timeout: 5000 }).trim();
    return out.split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

/**
 * Whether Claude Code can actually complete a turn.
 *
 * The binary existing is not the same as the agent working. Claude Code 2.1.x
 * rejects any model name it does not recognise in its built-in list, before it
 * sends a request: pointing it at a dead base URL still returns the same local
 * 404. This machine's gateway only offers names like `Deepseek-V4-Pro (3.60x)`,
 * which are not on that list, so every turn fails locally.
 *
 * A proxy that strips the `[1m]` suffix does not help, because the rejection
 * happens before the request leaves the process. The honest answer is that this
 * agent cannot run here, and the panel says so.
 */
function claudeBlocked(binary: string | undefined): string | undefined {
  if (!binary) return "没找到 claude 命令";
  const settings = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const raw = JSON.parse(fs.readFileSync(settings, "utf8")) as { env?: Record<string, string> };
    const model = raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "";
    if (!model) return "没有配置默认模型";
    // Known Claude names are safe; anything else is rejected locally.
    if (/^claude-/.test(model)) return undefined;
    return `配置的模型 ${model} 不在 Claude Code 的内置白名单里，每个回合都会在本地被拒（404），请求根本不会发出`;
  } catch {
    return undefined;
  }
}

/**
 * DeepSeek Harness is a desktop app that exposes an RPC socket, not a CLI.
 * It is usable only when a host registration exists.
 */
function findHarness(): { available: boolean; reason: string } {
  const registry = process.env.DEEPSEEK_BRIDGE_REGISTRY_DIR ?? path.join(os.homedir(), ".dsh", "codex-bridge", "hosts");
  try {
    const hosts = fs.readdirSync(registry).filter((n) => n.endsWith(".json"));
    if (hosts.length === 0) {
      return { available: false, reason: "没有运行中的 Harness 主机（需要先在 DeepSeek Harness 里启用 Codex 桥）" };
    }
    return { available: true, reason: "" };
  } catch {
    return { available: false, reason: "未安装 DeepSeek Harness 桥" };
  }
}

export function detectAgents(): AgentInfo[] {
  const codexBinary = findCodex();
  const claudeBinary = findClaude();
  const harness = findHarness();

  return [
    {
      id: "codex",
      label: LABELS.codex,
      ...(codexBinary ? { binary: codexBinary } : {}),
      ...(codexBinary ? { version: versionOf(codexBinary) } : {}),
      available: Boolean(codexBinary),
      reason: codexBinary ? "" : "没找到 codex 命令",
    },
    {
      id: "claude",
      label: LABELS.claude,
      ...(claudeBinary ? { binary: claudeBinary } : {}),
      ...(claudeBinary ? { version: versionOf(claudeBinary) } : {}),
      // Availability means "can complete a turn", not "the binary exists".
      available: Boolean(claudeBinary) && claudeBlocked(claudeBinary) === undefined,
      reason: claudeBlocked(claudeBinary) ?? "",
    },
    {
      id: "deepseek-harness",
      label: LABELS["deepseek-harness"],
      available: harness.available,
      reason: harness.reason,
    },
    {
      id: "workbuddy",
      label: LABELS.workbuddy,
      available: false,
      reason: "Windows 上没有可猜的安装路径；需要设置 WORKBUDDY_CLI_ELECTRON",
    },
  ];
}

/**
 * Where role assignments live.
 *
 * Kept beside the pipeline state so a project carries its own team, and a
 * second project can use a different arrangement.
 */
export function bindingsFile(stateDir: string): string {
  return path.join(stateDir, "agents.json");
}

export function readBindings(stateDir: string): RoleBindings {
  try {
    const raw = JSON.parse(fs.readFileSync(bindingsFile(stateDir), "utf8")) as RoleBindings;
    const out: RoleBindings = {};
    for (const role of ROLES) {
      const value = raw[role];
      if (typeof value === "string" && (Object.keys(LABELS) as string[]).includes(value)) {
        out[role] = value as AgentId;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBindings(stateDir: string, raw: unknown): RoleBindings {
  const candidate = (raw ?? {}) as Record<string, unknown>;
  // Refuse a binding to an agent that cannot run, rather than accepting it and
  // failing at task time. The panel only offers usable agents, but the endpoint
  // is reachable directly.
  const usable = new Set(detectAgents().filter((a) => a.available).map((a) => a.id as string));
  const out: RoleBindings = {};
  for (const role of ROLES) {
    const value = candidate[role];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !(Object.keys(LABELS) as string[]).includes(value)) {
      throw new Error(`角色 ${role} 的 agent 不认识：${String(value)}`);
    }
    if (!usable.has(value)) {
      throw new Error(`角色 ${role} 绑定的 ${LABELS[value as AgentId]} 在这台机器上不能执行任务`);
    }
    out[role] = value as AgentId;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(bindingsFile(stateDir), JSON.stringify(out, null, 2), "utf8");
  return out;
}

/** Which agent runs a role. Unassigned roles fall back to codex. */
export function agentForRole(bindings: RoleBindings, role: Role): AgentId {
  return bindings[role] ?? "codex";
}
