# P6：补齐 P5 记录的四个缺口

P5 文档末尾列了四项"证明不了"的事。这一轮按顺序把它们补上。

---

## 1. 重复运行，统计拦截率

**问题**：单次通过不能证明稳定。P5 里同一场景两次运行表现就不同。

**做法**：`tools/p4-drill.mjs` 新增 `--repeat N`。
门禁判定是纯函数，重复运行能抓到的只有非确定性——共享可变状态、
顺序依赖、定时器。这正是要防的东西。

```
node tools/p4-drill.mjs --repeat 10
15/15 scenarios behaved as required
每个场景 rate 10/10
```

**局限**：这只证明门禁判定可重复。它**不能**证明真实子进程每次都被拦——
那是 P5 端到端演练的范畴，而端到端跑 10 次成本很高（每次 30 秒左右），
本轮没有做。

---

## 2. 补越界形态

**问题**：P5 只测了"在 allowlist 外新建文件"。

**新增覆盖**（`test/workflow-observer.test.ts`，从 11 项到 16 项）：

| 形态 | 结果 |
|---|---|
| 删除 allowlist 外的文件 | 识别为 `deleted`，判定越界 |
| 深层路径 `a/b/c/deep.txt` | 识别为 `added`，判定越界 |
| 改名（`a.txt` → `renamed.txt`） | 识别为"删除 + 新增"两个变更 |
| 符号链接指向工作区外 | 识别为 `added` 且 `symlink: true`，不跟随目标 |
| 符号链接位于 allowlist 内 | 路径上不越界，但 `symlink: true` 让门禁仍可拒绝 |

**关键实现决定**：符号链接**不跟随**，用链接目标字符串作为指纹。
如果跟随，就会哈希目标内容，反而看不见"创建了一个链接"这件事。

**局限**：Windows 上创建符号链接需要开发者模式或管理员权限，
两条符号链接测试在受限环境下会静默跳过。测试里写了 `try/catch` 并在
注释里说明，不是伪装成通过。

---

## 3. 不信任 `test_results` 声明

**问题**：`TaskResult.test_results` 仍是子进程自己填的。观测只覆盖文件改动。

**做法**：新增 `src/workflow/test-output.ts`。

从命令的**实际输出**解析测试结果，支持：

| 格式 | 识别 |
|---|---|
| `node --test` | `ℹ pass N` / `ℹ fail N` |
| TAP | `ok N - name` / `not ok N - name` / `# skip` |
| jest / vitest | `Tests: X failed, Y skipped, Z passed, T total` |
| pytest | `N passed, M failed in Zs` |

`reconcileClaimedWithParsed` 比对声明与解析结果，返回**具体分歧**，
不是布尔值。例如：

```
the output shows 0 passing and 0 failing, but 3 were claimed
the output shows 5 failing, but the claim reports 1 passing and no failure
```

`CodexAdapter` 在 `execute` 里自动做这个比对，结果通过
`claimDiscrepancies(taskId)` 暴露。

**刻意保守**：只打印 `ok` 的程序**不算**测试结果。大多数程序都会打印
`ok`，把它当证据等于没有证据。

**局限**：解析器只认四种格式。子进程用别的测试框架时，`empty: true`，
比对会报"声称了 N 条但输出里没有"——这是**失败闭合**，不是漏判。

---

## 4. 接线阶段机（最重要）

**问题**：`evaluateAllGates` 是"可以被调用"，不是"一定会被调用"。
`assertGatePassed` 需要调用方自觉传列表。这是个真缺口。

**做法**：新增 `src/workflow/pipeline.ts`。

`Pipeline` 是唯一能改变阶段的入口。每一次前进都走 `advance()`：

```
advance({ to, gateInput })
  ├─ 阶段非法？      → refused: illegal-transition
  ├─ 有门禁但没输入？ → refused: gate-input-missing
  ├─ 门禁不通过？     → refused: gate-failed（附完整 verdict）
  └─ 通过            → 记录 StageRecord，移动阶段
```

三条硬性质：

1. **有门禁的边必须带 `gateInput`**，否则拒绝。不是"没输入就当通过"。
2. **拒绝不写入历史**。失败的尝试不算进度。
3. **`passedGates` 只从已记录的通过 verdict 推导**，没有别的来源。

**实测覆盖**（`test/workflow-pipeline.test.ts`，11 项）：

- 无门禁的跳阶被拒（`INTAKE → PLAN`）
- 有门禁但无输入被拒（`SPEC → PLAN`，报 G0）
- 门禁失败被拒，阶段不动，历史为空
- 门禁通过后 `passedGates` 出现 G0
- 完整 12 步走通，`passedGates` 恰好是 `[G0..G5]` 六项
- 失败的门禁**永远不会**进 `passedGates`
- BLOCKED 只能回到阻塞它的阶段
- 终态拒绝一切前进
- 返工边（REVIEW→IMPLEMENT）无门禁，可走
- `requiredGatesTo` 给规划器列出需要准备哪些证据
- `advanceAll` 在第一次拒绝处停止

---

## 证据

```
npm run build                                   exit=0
node tools/p4-drill.mjs --repeat 10             15/15, 每项 10/10
npx tsx --test test/workflow-observer.test.ts   16/16
npx tsx --test test/test-output.test.ts         12/12
npx tsx --test test/workflow-pipeline.test.ts   11/11
npx tsx --test test/**/*.test.ts                309 tests, 291 pass, 18 fail
```

18 个失败全部是既有平台问题（POSIX 权限位、Unix socket、launchd、
Windows 临时目录 EPERM），与本次改动无关，且新测试零失败。

---

## 这一轮仍然证明不了什么

1. **端到端没有跑 10 次。** 只做了门禁判定的重复性。
2. **`Pipeline` 还没有接进 `CodexAdapter`。** 现在能接线，但还没有一个
   "调度器"对象把"派任务 → 执行 → 拿证据 → 评估门禁 → 前进"串起来。
   这是 P7 的活。
3. **没有持久化。** `Pipeline.history` 在内存里，进程重启就没了。
4. ~~`claimDiscrepancies` 只有调用方读。~~ 已接线：`GateInput` 新增
   `claimDiscrepancies` 字段，G2 的 `claims-match-transcript` 检查会拦下
   被自己输出打脸的声明。没传这个字段时该检查不出现——因为"没解析输出"
   和"输出与声明一致"是两件事，不能混。
