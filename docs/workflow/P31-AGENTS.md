# P31：选 agent，分配角色

## 要什么

不是「选模型」，是「选谁干活」：Codex、Claude Code、DeepSeek Harness、
WorkBuddy 这些 agent 各自能干什么，以及谁能当主管、谁负责检查。

## 本机实际有什么

探测结果：

| agent | 状态 |
|---|---|
| Codex | 找到，`codex-cli 0.166.0-alpha.5.1` |
| Claude Code | 找到，`2.1.314` |
| DeepSeek Harness | 没找到桥（`~/.dsh/codex-bridge/hosts` 为空） |
| WorkBuddy | Windows 上没有可猜的安装路径 |

## 角色是协议，agent 是配置

流水线本来就有六个能力槽：

```
analyst 分析 / architect 架构 / developer 实现
reviewer 审查 / tester 测试 / integrator 集成
```

`agents.ts` 把「槽」和「谁填槽」分开：

- 没分配 → 默认 Codex，所以新装的人不用配任何东西
- 分配了 → 存到 `workflow-state/agents.json`，跟着项目走
- 不认识的 id → 直接拒绝，不写进文件

## 计划执行要按角色换 agent

原来 `executePlan` 只造一个 `CodexAdapter`，整份计划都用它。
现在改成 `roleRoutingAdapter`：

```ts
async execute(envelope) {
  const adapter = buildAdapterFor(project, envelope, stateDir, codexPath, onOutput);
  used.set(envelope.task_id, adapter);
  return adapter.execute(envelope);
}
```

每个任务按自己的 `role` 选 agent，同时记住用的是哪个——`resume` 和
`cancel` 要找回同一个适配器，不能拿 A 的反馈去续 B 的会话。

## Claude Code 适配器

`claude -p <prompt> --output-format json` 打印一个 JSON 信封，任务结果在
`result` 字段里，不在磁盘上。所以适配器从 stdout 提取，而不是读结果文件。

## 一个真实的环境阻塞

**Claude Code 在这台机器上跑不了，原因不是代码。**

网关 `open-ai.baomiao.cn` 提供的模型名是 `Deepseek-V4-Pro (3.60x)`。
Claude Code 不认识这个名字，会追加 `[1m]` 后缀变成
`Deepseek-V4-Pro (3.60x)[1m]`，网关回 503「无可用渠道」。

实测对照：

```
Deepseek-V4-Pro (3.60x)        -> OK
Deepseek-V4-Pro (3.60x)[1m]    -> 503 无可用渠道
```

所以 `capabilityCheck` 直接报：

> 模型名 Kimi-K2.7 (2.60x) 含空格和括号；Claude Code 会追加 [1m]，
> 当前网关拒绝该名称

**没有假装可用。** 绑定 Claude 的任务会在执行前就失败，并说明原因，
而不是跑一半再报 404。

## 面板

第 0 步「谁来干活」：

- 列出四个 agent，可用的绿点，不可用的灰点并写明原因
- 六个角色各一个下拉框，默认「默认（Codex）」
- 保存写到 `agents.json`

## 测试

`test/agents.test.ts` 6 项：

| 检查 | 说明 |
|---|---|
| 四个 agent 都列出 | 不可用的必须有 reason |
| 未分配角色回退到 Codex | 新装即可用 |
| 分派能存能读 | 再写一次会覆盖而不是合并 |
| 未知 agent id 被拒 | 不写进文件 |
| 缺文件读成空 | 不报错 |
| 空字符串清除角色 | 而不是绑定成空 id |

```
408 用例，404 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. 能探测本机装了哪些 agent，并如实报告不可用的原因
2. 六个角色可以分别指派给不同 agent，存得住、读得回
3. 整份计划按每个任务的角色选 agent，不是整份计划绑死一个
4. Claude 适配器存在，且在当前网关下会明确拒绝而不是静默失败

## 这一轮证明不了什么

1. **Claude 从来没成功跑过一个任务。** 网关的模型名不兼容，适配器的
   执行路径没在真实成功案例上验证过。
2. **DeepSeek Harness 和 WorkBuddy 没有适配器。** 只有探测和拒绝。
3. **没有测混合 agent 的真实计划。** 路由逻辑有单元测试，但没跑过
   「实现用 Codex、审查用 Claude」的完整流水线。
4. **角色只是标签，没有强制语义。** reviewer 不会因为绑定了 Claude
   就自动去读 diff，它还是按任务信封里的 objective 干活。
