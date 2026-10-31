# P3：质量门禁的实际判定逻辑

## 交付内容

| 文件 | 作用 |
|---|---|
| `src/workflow/gates.ts` | G0–G5 的判定函数、`GateVerdict`、`evaluateGate` / `evaluateAllGates` |
| `test/workflow-gates.test.ts` | 30 项测试 |

## 设计原则

**空输入一律失败。** 每道门禁在缺数据时返回 `passed: false` 并给出原因，
不返回 true。有一条测试专门验证：`evaluateAllGates({})` 必须六道全挂。

**门禁复用协议，不重新实现。** G2 直接调用 `validateTaskResult` 和
`claimIsSupported`，所以"能被 `claimIsSupported` 拒绝的结果，不可能从 G2 溜过去"。

**门禁只看它有权判断的东西。** 每道门禁的输入是显式的 `GateInput` 字段，
缺字段就是失败，不会因为"没提供所以跳过"。

## 六道门禁

| 门禁 | 卡在 | 检查项 |
|---|---|---|
| G0 | SPEC→PLAN | 需求集存在；每条 AC 都有决定方式（自动有命令、人工有具名负责人）；信封引用的 AC 必须存在 |
| G1 | PLAN→DISPATCH | 任务存在；依赖不悬空；并行任务不共享写路径；每条 AC 至少被一个任务认领 |
| G2 | IMPLEMENT→REVIEW | 结果与信封对账；成功声明有证据支撑；无未决问题 |
| G3 | REVIEW→VERIFY | 审查跑过；无未解决的 Blocker/Major（Minor/Suggestion 可以带过） |
| G4 | VERIFY→INTEGRATE | 每条 AC 都有结果行；全部 passed；passed 必须引用证据 |
| G5 | ACCEPT→DELIVER | 继承 G4 的全部检查；人工验收必须具名、时间可解析、说明看了什么 |

## 几个具体判断

**G1 的写冲突检测是精确字符串比较。** 它只能发现 `["src/shared"]` 这种
完全相同的声明。`["src"]` 和 `["src/shared"]` 的重叠它看不见。
这是已知局限，不是 bug——真实的重叠检测需要路径归一化和包含关系判断，
属于 P4 范围。

**G5 的人工验收不可独立验证。** `recorded.G5` 是调用方填的，门禁无法证明
那个人真的看了。能做的只是要求这条记录足够具体以便事后审计：
`by` 至少两个字、`at` 必须能被 `Date.parse` 解析、`note` 至少 8 字。
填 `by: "x", at: "now", note: "ok"` 会被拒。

**G5 继承 G4 的方式是复制 check 并加前缀。** 这样 G4 的失败会在 G5 的
`blocking` 列表里以 `g4:` 开头出现，交付方能看到到底哪一条没过。

## 证据

```
npm run build                          exit=0
npx tsx --test test/workflow-gates.test.ts
  tests 30  pass 30  fail 0

npx tsx --test test/**/*.test.ts
  tests 253  pass 235  fail 18   （失败数仍是基线 18，无新增）
```

## 已知限制

1. **G1 的写冲突检测不做路径归一化**，见上。
2. **G5 的人工验收是"可审计的声明"，不是"可验证的事实"**。这是人工环节的
   本质限制，任何门禁都绕不过去。
3. **门禁没有和阶段机接线。** `assertGatePassed` 需要调用方显式传入
   已通过的门禁列表，`evaluateGate` 产出的是 `GateVerdict`，两者还没串起来。
   接线属于 P4 的调度器工作。
4. **没有门禁证据的持久化。** 每次评估都在内存里，重启就没了。
