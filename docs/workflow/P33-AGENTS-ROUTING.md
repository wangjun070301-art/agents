# P33：四个 agent 可用化，Claude 经 Agent2API 转接

## 结论

Claude Code 在这台机器上**真的能跑任务了**，走 Agent2API 转接。

```
capability: true ready
status: succeeded
summary: Read a.txt ... Its contents consist of the single line: hello
```

## 本机实况

| agent | 状态 | 怎么走 |
|---|---|---|
| Codex | 可用 | 直连（`codex-cli 0.166.0-alpha.5.1`） |
| Claude Code | 可用 | 经 Agent2API `127.0.0.1:3065` 转接 |
| DeepSeek Harness | 探测到进程（`:9230`），但没有桥注册 | 未接 |
| WorkBuddy | 未安装 | 未接 |

## Claude 为什么需要转接

三层不兼容，每层都得破：

**第一层：模型名。** Claude Code 只发它内置白名单里的名字
（`claude-sonnet-4-5` 等）。Agent2API 只认自己的名字（`glm-5.3`）。

**第二层：`[1m]` 后缀。** 请求带 `context-1m-2025-08-07` beta 时，Claude
给模型名加 `[1m]`，Agent2API 拒绝这个后缀。

**第三层：响应回写。** Claude 校验响应里的 `model` 字段，不匹配就报
404。Agent2API 返回的是 `glm-5.3`。

## 转接层做了什么

`src/workflow/claude-proxy.ts`，本地监听随机端口：

1. **路径归一化** —— Claude 把 base URL 和 `/v1` 拼两次，得到
   `/v1/v1/messages`。代理把重复的 `/v1` 折叠掉。
2. **模型映射** —— 请求里的 `claude-sonnet-4-5` 改成 `glm-5.3`。
3. **剥 beta** —— 从 `anthropic-beta` 头里删掉 `context-1m-2025-08-07`，
   其余保留。
4. **响应回写** —— SSE 流里 `message_start` 的 `model` 字段改回
   `claude-sonnet-4-5`。
5. **本地应答 hello** —— Claude 启动时先 `HEAD /v1/api/hello`，代理
   直接 200，不发上游。

每一步都有测试，共 7 项。

## 配置隔离

`~/.claude/settings.json` 里有旧的模型名（`Kimi-K2.7 (2.60x)`），而且
`--settings` 是**追加**不是替换，旧值会赢。所以每次跑任务时写一个临时
`CLAUDE_CONFIG_DIR`，里面只放指向代理的配置。

## key 从哪来

Agent2API 自己的 key 是加密存的（`enc1:...`）。但 cc-switch 把它存在
明文里（给 `codearts`、`trae` 两个 provider 用），直接从
`~/.cc-switch/cc-switch.db` 读，不用手填。

**没有把 key 写进任何提交的文件。**

## 面板

第 0 步「谁来干活」现在是两列：

```
角色        用哪个 agent            用哪个模型
分析        [默认（Codex）  ▼]     [默认模型 ▼]
审查        [Claude Code    ▼]     [claude-sonnet-4-5 ▼]
```

- 不可用的 agent 在下拉里是禁用的
- 换 agent 会清掉模型选择（模型只属于某个 agent）
- 后端会拒绝给 agent 不支持的模型

## 测试

```
419 用例，415 通过，4 跳过，0 失败
```

新增/更新：

| 文件 | 内容 |
|---|---|
| `claude-proxy.test.ts` | 7 项：后缀剥离、路径折叠、模型映射、响应回写、beta 剥离 |
| `agents.test.ts` | 6 项：探测、回退、分派存取、非法 id、空值 |

## 这一轮证明了什么

1. Claude Code 经 Agent2API 能完成一个真实任务并返回协议合法结果
2. 转接层的每一层不兼容都有对应处理和测试
3. 角色可以分派给不同 agent，每个角色还能选自己的模型
4. 探测结果不再说谎：可用就是能跑，不可用就说原因

## 这一轮证明不了什么

1. **只验证了 `glm-5.3` 一个模型。** 换成 `kimi-k3.1-pro` 等没跑过，
   不同模型对工具调用的支持程度可能不同。
2. **没跑完整多任务计划。** 路由逻辑有单测，但没跑过「实现用 Codex、
   审查用 Claude」的端到端流水线。
3. **DeepSeek Harness 和 WorkBuddy 仍不可用。** Harness 有进程但没有
   桥注册，WorkBuddy 在 Windows 上没有可猜的安装路径。
4. **代理是每次任务临时起停。** 并发跑多个 Claude 任务会各起一个代理，
   没有验证端口冲突。
5. **Claude 的工具调用没有验证。** 这次的任务只需要读文件，没有测
   写文件或执行命令。
