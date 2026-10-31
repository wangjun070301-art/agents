# 门禁审查记录

审查者：Claude Code 2.1.314（`tools/claude-reviewer.ps1`，别名映射到网关真实模型）
审查对象：`src/workflow/gates.ts`

## 第 1 轮

| 编号 | 严重度 | 问题 |
|---|---|---|
| 1 | Major | G3 在 `reviewFindings: []` 时通过——空数组是 truthy，无法区分"审了没问题"和"没审" |
| 2 | Major | G1 无需求集时仍通过——`acs-covered` 被 `if (input.requirements)` 包住 |
| 3 | Major | G0 接受零条 AC 的需求集——`criteria-present` 推了个 `ok("0 acceptance criterion(s)")` |
| 4 | Minor | `verdict()` 对空 checks 返回 true（`[].every()` 是 true），任何早退路径都可能静默通过 |
| 5 | **Blocker** | G1 用精确字符串比较写冲突，`["src"]` 与 `["src/parser.ts"]` 不算重叠——这是常见情况，不是边角 |
| 6 | Major | G1 依赖豁免允许环：A 依赖 B、B 依赖 A 时 `ordered` 为真，冲突被跳过，但两者都跑不起来 |
| 7 | Major | G4 接受垃圾证据（`.`、`n/a`、零宽空格），且重复 `ac_id` 行是后写覆盖先写 |
| 8 | Major | G2 接受非 succeeded 状态——`claimIsSupported` 对非 succeeded 直接返回 true |
| 9 | Major | G2 忽略 `input.changedFiles`（声明了但没有任何门禁读它） |
| 10 | **Blocker** | G5 的人工验收只是三个自由字符串，`by` 长度 ≥2、`at` 可解析、`note` 长度 ≥8 |

## 第 1 轮修复

- `verdict()` 空 checks 直接返回失败。
- G0 零 AC、G1 无需求集一律阻塞。
- G1 增加 `pathOverlap`（父/子重叠、大小写折叠、`..` 解析）、`dependencyClosure`（传递闭包）、`findDependencyCycle`。
- G2 要求 `status === "succeeded"`，并用 `input.changedFiles` 双向对账。
- G3 增加 severity 校验。
- G4 拒绝垃圾证据、重复行、未定义 AC。
- G5 要求 `artifact`、`accepted_ac_ids`、时间序。

## 第 2 轮

| 编号 | 严重度 | 问题 | 处置 |
|---|---|---|---|
| 11 | Major | `findDependencyCycle` 是递归的，但注释写"迭代"——上万任务的链会栈溢出 | 已修：改为显式栈的迭代 DFS |
| 12 | Minor | `dependencyClosure` 每个任务重走一次 + G1 的 O(V²) 配对 | 记录：当前规模无影响，不修 |
| 13 | Major | `pathOverlap` 保留 `..`，`src/../src/a.ts` 与 `src/a.ts` 不重叠 | 已修：`normalizeForCompare` 支持 `..` 解析 |
| 14 | Minor | 无时间戳时 G5 的时间序检查静默跳过 | 已修：无时间戳本身算失败 |
| 15 | Minor | 纯日期 `at` 解析为午夜，与当天下午的验证比较会误判"早于" | 已修：`parseStrictTimestamp` 只接受完整 ISO 时间 |
| 16 | Major | G2 把合法的 `blocked` 结果和"不诚实"混为一谈 | 已修：`blocked` 单独返回"报告合法但未完成" |
| 17 | Major | G2 的文件对账用裸 `.includes`，绝对路径会被误判 | 已修：用与协议相同的归一化 |
| 18 | **Blocker** | G5 把 `envelope.base_revision` 当交付物——那是开工前的状态，不是人看的构建 | 已修：新增 `deliveredArtifact`，必填 |
| 19 | Major | G5 无 envelope 时 artifact 无绑定，任何非空值都过 | 已修：`deliveredArtifact` 必填 |

## 第 3 轮：未采纳的建议

**G3 的 `[]` 仍然通过。** 审查员认为空数组无法证明审查跑过。
我的判断：`undefined` = 没审，`[]` = 审了没发现问题，这是两种不同的事实，
调用方必须显式选择。要求"审查干净"也带证据会让这个状态无法表达。
这个取舍写在这里，而不是悄悄留着。

**G1 的 O(V²) 配对。** 当前项目规模是十几个任务，二次复杂度没有实际影响。
真到需要优化时再改，不提前抽象。

## 证据

```
npm run build                              exit=0
npx tsx --test test/workflow-gates.test.ts
  tests 47  pass 47  fail 0
```

## 局限

1. 审查者与我同一网关、同一模型家族，独立性来自不同进程 + 只读工具 + 非作者。
2. 审查者工具集只有 `Read`/`Grep`/`Glob`，无法执行测试，结论基于源码阅读。
3. 门禁仍未与阶段机接线（`assertGatePassed` 需要调用方传已通过列表），属 P4。
