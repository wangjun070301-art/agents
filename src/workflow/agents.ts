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

/**
 * How an agent reaches a model.
 *
 * `direct` means the agent talks to its own configured provider. `gateway`
 * means it goes through a local relay that maps its model names onto whatever
 * the gateway serves. Claude Code needs the gateway path on this machine
 * because its built-in model list and the local gateway's names do not overlap.
 */
export type AgentRoute =
  | { kind: "direct" }
  | { kind: "gateway"; baseUrl: string; apiKey?: string; modelMap: Array<{ from: string; to: string }> };

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
  /** How this agent reaches a model, when it can. */
  route?: AgentRoute;
  /** Models this agent can be asked to use, when known. */
  models?: string[];
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
  /**
   * Model chosen for each role. Stored beside the agent because a model name
   * only means something for the agent that accepts it.
   */
  analyst_model?: string;
  architect_model?: string;
  developer_model?: string;
  reviewer_model?: string;
  tester_model?: string;
  integrator_model?: string;
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
 * Claude Code's route, and why it needs one.
 *
 * Claude Code 2.1.x sends only names from its built-in list, and it appends
 * `[1m]` when the request carries the 1m-context beta. Agent2API serves its own
 * model names and rejects both the suffix and the beta. A local relay bridges
 * the two: Claude speaks `claude-sonnet-4-5`, the relay maps it to a real
 * gateway model, strips the beta, and maps the response name back.
 *
 * Without a gateway the agent still runs, against whatever its own settings
 * point at.
 */
const CLAUDE_NAMES = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"];

function claudeRoute(): AgentRoute | undefined {
  const gateway = findLocalGateway();
  if (!gateway) return undefined;
  return {
    kind: "gateway",
    baseUrl: gateway.baseUrl,
    ...(gateway.apiKey ? { apiKey: gateway.apiKey } : {}),
    modelMap: CLAUDE_NAMES.map((from) => ({ from, to: gateway.model })),
  };
}

/**
 * A local Anthropic-shaped gateway, if one is running.
 *
 * Agent2API answers `/v1/messages`; cc-switch's proxy does not unless a Claude
 * provider is configured, so only a gateway that passes a real probe is used.
 */
function findLocalGateway(): { baseUrl: string; apiKey?: string; model: string } | undefined {
  // Agent2API first: it answers `/v1/messages` with the key cc-switch already
  // stores. cc-switch's own proxy only speaks Anthropic when a Claude provider
  // is configured, and reports 未配置供应商 otherwise.
  const apiKey = agent2apiKey();
  if (apiKey) {
    return { baseUrl: "http://127.0.0.1:3065/v1", apiKey, model: "glm-5.3" };
  }
  return undefined;
}

/**
 * The key cc-switch already stores for Agent2API.
 *
 * Agent2API keeps its own key encrypted, but cc-switch stores the same key in
 * plain text for the providers it points at Agent2API. Reading it here means
 * the panel never asks for a secret it can already find.
 */
let cachedKey: string | undefined;
function agent2apiKey(): string | undefined {
  if (cachedKey !== undefined) return cachedKey || undefined;
  cachedKey = "";
  try {
    // Dynamic import, because this module is ESM and node:sqlite is optional
    // on older runtimes.
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return undefined;
    const db = new sqlite.DatabaseSync(path.join(os.homedir(), ".cc-switch", "cc-switch.db"), {
      readOnly: true,
    });
    try {
      for (const row of db.prepare("SELECT settings_config FROM providers").all()) {
        const match = String((row as { settings_config?: string }).settings_config ?? "").match(
          /sk-a2a-[0-9a-f]{8,}/,
        );
        if (match) {
          cachedKey = match[0];
          return cachedKey;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  return undefined;
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
      available: Boolean(claudeBinary),
      reason: claudeBinary ? "" : "没找到 claude 命令",
      ...(claudeBinary ? { route: claudeRoute() ?? { kind: "direct" as const } } : {}),
      models: CLAUDE_NAMES,
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
      const model = (raw as Record<string, unknown>)[`${role}_model`];
      if (typeof model === "string" && model.trim()) {
        (out as Record<string, unknown>)[`${role}_model`] = model;
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

  // A model is stored only when the role has an agent and that agent offers
  // the model. A name left over from a previous agent choice would be a lie.
  for (const role of ROLES) {
    const model = candidate[`${role}_model`];
    if (typeof model !== "string" || !model.trim()) continue;
    const agent = out[role];
    if (!agent) continue;
    const offered = detectAgents().find((a) => a.id === agent)?.models ?? [];
    if (!offered.includes(model)) {
      throw new Error(`角色 ${role} 的 ${LABELS[agent]} 不支持模型 ${model}`);
    }
    (out as Record<string, unknown>)[`${role}_model`] = model;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(bindingsFile(stateDir), JSON.stringify(out, null, 2), "utf8");
  return out;
}

/** Which agent runs a role. Unassigned roles fall back to codex. */
export function agentForRole(bindings: RoleBindings, role: Role): AgentId {
  return bindings[role] ?? "codex";
}
