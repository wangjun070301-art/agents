# 独立审查记录

审查者：Claude Code 2.1.314，经 `tools/claude-reviewer.ps1`，模型映射到网关的
`DeepSeek-V4.1-Flash 1017(1.20x)`。

审查对象：`eb907d1` 引入的 `src/workflow/*.ts`。

审查者身份：**非作者**。作者是本会话的 Codex 进程，审查者是独立进程，
工具集限定为 `Read` / `Grep` / `Glob`（只读）。

## 第 1 轮

| 编号 | 严重度 | 问题 |
|---|---|---|
| B1 | Blocker | `claimIsSupported` 接受无任何验收证据的 `succeeded`：不查退出码、不查测试数量、`skipped` 视为通过、不查 `unresolved_issues` |
| M1 | Major | 没有任何函数把 `TaskResult` 与 `TaskEnvelope` 对账；`expect_exit`、`allowed_paths`、`deliverables`、`acceptance_ids` 全是无人读取的装饰 |
| M2 | Major | `blockedFrom` 由调用方提供且不校验，可以"解除归档"已完成任务，也可以跳到从未阻塞过的阶段 |
| M3 | Major | `INTEGRATE -> IMPLEMENT` 与文档声明的策略矛盾 |
| M4 | Major | 注释宣称"跳过门禁是协议错误"，但 `assertTransition` 从不查门禁 |
| M5 | Major | REQ/AC 归属与唯一性未校验；信封可引用不存在的 AC |
| m1 | Minor | 能力报告可冒充他者 id；`checkAll` 串行，一个挂起拖住全部 |
| m2 | Minor | 适配器 id 无校验，空串和空白串都能注册 |
| m3 | Minor | 手动 AC 没有具名的人类检查；也可同时携带自动命令 |
| m4 | Minor | `allowed_paths` 空数组语义未定义，且从未被检查 |
| m5 | Minor | `LEGAL_TRANSITIONS.BLOCKED = []` 与 `canTransition` 的实际行为矛盾 |
| m6 | Minor | ID 正则无长度上限，允许前导零 |
| s1 | Suggestion | 非成功状态可以不带任何理由 |
| s2 | Suggestion | 门禁表未与合法边交叉校验 |
| s3 | Suggestion | `timeout_seconds` 无人使用；`collectEvidence` 无消费者 |
| s4 | Suggestion | 导出的枚举数组可变 |
| s5 | Suggestion | `ProtocolError.detail` 序列化后丢失 |

## 第 1 轮修复

全部 B/M 级已修，均有测试覆盖：

- `claimIsSupported` 要求：无未决问题、至少一条测试、全部 `passed`、每个 AC 都有具名的通过测试。
- 新增 `validateTaskResult(envelope, result)`：对账 task_id、`allowed_paths`、`deliverables`、每条验证命令的 `expect_exit`、AC 覆盖。
- `canTransition` 拒绝伪造的 `blockedFrom`：不能解除归档、不能自环、不能跳到无 BLOCKED 边的阶段。
- 新增 `REQUIRED_GATES` 与 `assertGateTableConsistent()`：删除门禁会抛错而不是静默放行。
- 新增 `assertGatePassed(from, to, passed)`。
- 新增 `requirementsSchema`（REQ/AC 唯一性与归属一致性）与 `validateEnvelopeAgainstRequirements`。
- 适配器 id 有格式校验；`checkAll` 并行、带超时、强制覆盖 `adapter_id`。

## 第 2 轮（修复引入的新问题）

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| N1 | Major | `claimIsSupported` 硬编码退出码 0，与 `expect_exit` 自相矛盾；负向断言（`grep -q` 期望 1）永远无法成功 | 已修：按信封的 `expect_exit` 判定 |
| N2 | Major | `.find()` 只取第一条命令记录，后一次失败被前一次成功掩盖 | 已修：遍历全部同名记录 |
| N3 | Major | 门禁表校验只能查"门禁指向非法边"，查不出"门禁被删" | 已修：新增 `REQUIRED_GATES` |
| N4 | Major | 删掉 `INTEGRATE->IMPLEMENT` 后，集成发现缺陷只能 ACCEPT 或 BLOCKED，成为死路 | 已修：改为 `INTEGRATE->VERIFY`，保留两跳返工路径 |
| N5 | Minor | 超时定时器未清理，一次性 CLI 会被拖住 30 秒 | 已修：两条 settle 路径都 `clearTimeout` |
| N6 | Minor | `checkAll` 的 `signal` 形同虚设 | 部分修：预中止返回不可用报告；中途中止仍等满超时 |
| N7 | Minor | `RegExp.test` 强转非字符串，`undefined` 能注册成功 | 已修：先判 `typeof` |
| N8 | Minor | `LEGAL_TRANSITIONS[from]` 无保护，非法阶段抛 `TypeError` 而非 `ProtocolError` | 已修：查不到就抛 `ProtocolError` |
| N9 | Minor | `allowed_paths: ["/"]` 归一化为空串后被当作"允许一切" | 已修：归一化为空视为非法条目，拒绝 |
| N10 | Minor | 绝对路径无法通过相对路径的包含检查 | 已修：先相对 `repo_path` 再比较 |
| N11 | Minor | 自动化 AC 可以额外携带 `manual_check` | 已修：禁止该组合 |
| N13 | Minor | `validateTaskResult` 不查证据前置条件，与 `claimIsSupported` 强度不一致 | 已修：证据检查下沉到 `validateTaskResult` |

## 第 3 轮

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| P3-1 | Major | `relTo` 大小写敏感剥离前缀，而 `samePath` 大小写不敏感比较，Windows 上盘符大小写不同会产生假阴性 | 已修：`relTo` 接受 `caseInsensitive` |
| P3-2 | Minor | 预中止时任务全部 reject，`Promise.allSettled` 丢弃它们，返回的报告数少于注册数 | 已修：中止返回不可用报告，并兜底补齐每个注册 id |
| P3-3 | Minor | 定时器 `unref` 后，若挂起 promise 不持有任何句柄，事件循环可能先排空，超时永不触发 | 已修：移除 `unref` |

## 第 4 轮（最终状态）

仍标记为 `STILL OPEN` 的只有 **N6 的中途中止部分**：`checkAll` 在信号中途触发时
不会提前返回，而是等每个适配器各自超时。这是有意保留的行为，因为提前返回会丢掉
仍在进行中的能力信息。若要改为快速失败，需要在 `CapabilityReport` 增加
`cancelled` 状态，属于 P3 门禁阶段的工作，不在本轮范围。

## 证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | `exit=0` |
| 契约测试 | `npx tsx --test --test-timeout=60000 test/workflow-contracts.test.ts` | `exit=0`，tests 38，pass 38，fail 0 |
| 审查执行 | `pwsh -File tools/claude-reviewer.ps1 ...` | `exit=0` |

## 局限

1. 审查者与实现者使用同一网关、同一底层模型家族（DeepSeek），只是不同进程、不同角色。
   独立性来自"不同会话 + 只读工具集 + 非作者"，不来自模型多样性。这是本机现有条件
   能达到的最强形式，但弱于跨厂商审查。
2. 审查只覆盖 `src/workflow/*.ts` 与对应测试。仓库其余部分未纳入本轮审查。
3. 审查者的工具集只有 `Read` / `Grep` / `Glob`，无法执行测试，因此所有结论均基于
   源码阅读；测试结果由作者侧提供，未由审查者独立复现。
4. 审查者首次运行时未能读取到上一轮自己的结论（会话不持久），第 2 轮是靠 `git diff`
   重建缺陷列表来对齐的，因此编号映射并非严格 1:1。
