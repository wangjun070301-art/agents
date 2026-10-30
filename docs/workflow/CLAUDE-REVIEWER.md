# Claude Code 作为独立审查员

## 结论

Claude Code 已安装并**实测可用**，可以读写本仓库、执行命令，用于"审查者不得是作者"这条独立验收要求。

| 项 | 值 |
|---|---|
| 版本 | `2.1.314` |
| 安装位置 | `D:\node\claude.ps1`（npm 全局） |
| 网关 | `https://open-ai.baomiao.cn/v1`（Anthropic Messages API 兼容） |
| 入口脚本 | `tools/claude-reviewer.ps1` |
| 转发层 | `tools/model-shim.mjs` |

## 为什么需要一个转发层

网关的模型 ID 带空格和括号，例如 `DeepSeek-V4.1-Flash 1017(1.20x)`。
Claude Code 在发送前会把模型名里的非字母数字字符剥掉，变成
`DeepSeek-V4.1-Flash10171.20x`。上游不认识这个名字，返回 503。

实测对照：

| 发送的模型名 | 上游结果 |
|---|---|
| `DeepSeek-V4.1-Flash 1017(1.20x)` | 200，正常返回 `PONG` |
| `DeepSeek-V4.1-Flash10171.20x` | 503 Service Unavailable |
| `DeepSeek-V4.1-Flash 1017` | 503 |
| `DeepSeek-V4.1-Flash-1017` | 503 |

网关只认带括号的完整名，没有短别名。

`tools/model-shim.mjs` 监听 `127.0.0.1:18777`，接收 Claude Code 发来的
干净别名（`claude-sonnet-4-5` 等），在转发前替换成网关真实 ID。
其余请求原样透传，不解析、不改写响应体。

## 第二个坑：路径重复

网关 base 本身以 `/v1` 结尾，Claude Code 又发 `/v1/messages`，
简单拼接会得到 `/v1/v1/messages` → 404。shim 会剥掉重复前缀。

## 第三个坑：settings.json 的 env 优先级

`~/.claude/settings.json` 里的 `env` 块**优先于**进程环境变量。
只在 PowerShell 里设 `$env:ANTHROPIC_BASE_URL` 不生效，必须用
`--settings <file>` 覆盖。

## 实测证据

```
# 基础连通
claude -p 'Reply with exactly: PONG'  →  exit=0, 输出 "PONG"

# 能力 1：读取文件并计数
claude -p 'Read src/workflow/states.ts and count LEGAL_TRANSITIONS entries'
  →  exit=0, 输出 "14"（与文件实际条目数一致）

# 能力 2：执行命令
claude -p 'Run: node --version'
  →  exit=0, 输出 "v26.11.1"（与 node --version 实际输出一致）
```

## 用法

```powershell
# 审查当前工作区改动
.\tools\claude-reviewer.ps1 "Review the staged diff for correctness and regressions"

# 指定更强模型（映射到网关的 V4-Pro）
.\tools\claude-reviewer.ps1 "..." -Model claude-opus-4-5
```

脚本会按需启动 shim、从网关读取真实模型 ID 生成映射、用 `--settings`
覆盖网关地址，跑完后清理临时配置文件。网关令牌在运行时从
`~/.claude/settings.json` 读取，**不写入本仓库**。

## 已知限制

1. shim 是本地明文 HTTP 代理，只监听 `127.0.0.1`，不对外暴露。
2. 模型 ID 映射依赖网关命名规则；网关改名后脚本会自动重新读取，但
   `V4.1-Flash` / `V4-Pro` 这两个匹配模式需要跟着改。
3. `~/.claude/settings.json` 里的 `ANTHROPIC_AUTH_TOKEN` 目前是明文落盘。
   建议后续迁移到用户级环境变量并轮换，这一步需要你本人操作。
