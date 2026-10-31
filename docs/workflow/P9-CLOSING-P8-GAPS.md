# P9：补齐 P8 记录的五项空白

P8 文档末尾列了五件"证明不了"的事。这一轮全部跑掉。

---

## 1. G5 的通过路径

P8 只证明了 G5 会拦，没证明正确签收后能过。

**做法**：`tools/p8-full-path.mjs` 加 `--accept-by` / `--accept-note`，
用真实签收跑完整链路。

```
node tools/p8-full-path.mjs --sandbox bypass \
  --accept-by "WangJiayi" \
  --accept-note "read the src/calc.js diff and confirmed it only adds one comment; ..."

[p8] ACCEPT -> DELIVER: passed
PASS  [G5] the delivery gate accepts a named human acceptance
[p8] ARCHIVE -> ARCHIVE: passed
[p8] final stage ARCHIVE
10/10 checks passed
```

**结论**：G5 的拦与过两条路径都验证了。

---

## 2. `runPlan` 的多任务真实路径

P7 的 `runPlan` 测试用同一个适配器给每个任务返回同一份结果，
掩盖了"真实计划里每个任务的交付物和 AC 都不同"这件事。

**做法**：`test/workflow-runplan-real.test.ts`，三任务计划
（ADD、MUL、JOIN，JOIN 依赖前两个），适配器按信封生成结果。

| 检查 | 结果 |
|---|---|
| 执行顺序 | `["T-ADD", "T-MUL", "T-JOIN"]`，JOIN 最后 |
| 全部完成 | 3/3 |
| 任务运行不动阶段 | 阶段仍是 PLAN |
| 依赖失败时跳过 JOIN | 跳过原因含 `T-MUL` |
| 独立任务不受影响 | T-ADD 仍完成 |
| G1 能看到整个计划 | 通过 |

---

## 3. 失败恢复

**做法**：`test/workflow-recovery.test.ts`，6 项。

| 场景 | 结果 |
|---|---|
| 子进程崩溃 | 报 `adapter-error`，阶段不动 |
| 子进程超时 | 报 `adapter-error`，与崩溃区分（消息不同） |
| BLOCKED 不指定回退阶段 | 拒绝 |
| BLOCKED 指定错误的回退阶段 | 拒绝 |
| BLOCKED 指定正确的回退阶段 | 恢复，且返工边仍可用 |
| 失败记录落盘 | `failure.json` 可重新读取 |

---

## 4. 重复稳定性（最有价值的一项）

**第一次跑：3 次里 1 次失败。**

```
p9-run-1.log: 10/10 stage=ARCHIVE
p9-run-2.log: 4/10  stage=IMPLEMENT   ← 失败
p9-run-3.log: 10/10 stage=ARCHIVE
```

失败原因：

```
[p8] child run failure: adapter-error — result file has no JSON object: [R]
```

**子进程输出了 `[R]` 前缀的散文，没有 JSON。**

这和 P8 文档里 Bug 2 是同一个问题，但这次发生在**适配器层**：
结果无法解析时直接抛异常，没有重试。

### 修复

`CodexAdapter` 新增 `formatRetries`（默认 2）。规则：

| 错误类型 | 是否重试 |
|---|---|
| `result-invalid`（散文/无 JSON） | **是**——这是格式抖动，不是任务失败 |
| `timeout` | 否——重试会同样超时 |
| `spawn-failed` | 否 |
| `result-missing` | 否 |

**修复后第二次跑：3/3 全部到 ARCHIVE。**

```
p9-run-1.log: 10/10 stage=ARCHIVE
p9-run-2.log: 10/10 stage=ARCHIVE
p9-run-3.log: 10/10 stage=ARCHIVE
```

新增 3 项测试锁住这个行为：重试后成功、重试有上限、超时不重试。

**这是整个项目里第一次用重复运行抓到真实的不稳定性。**
单次通过确实不代表稳定。

---

## 5. 审查质量

P8 只验证了"审查者能产出结构化结果"，没验证"结论对不对"。

**做法**：`tools/p9-review-quality.mjs`，同一 prompt、同一模型，两份 diff：

| 案例 | 改动 | 期望 |
|---|---|---|
| A | 只加一行注释 | 报 clean |
| B | 把 `a + b` 改成 `a - b`（测试会失败） | 报 defect |

```
[p9] A (comment-only): status=succeeded findings=0 clean=true
[p9] B (breaks the test): status=succeeded findings=1 clean=false
3/3 checks passed
```

**结论**：审查者能分辨"没问题"和"有问题"，不是橡皮图章。

**局限**：只测了两个极端的案例。中间地带（比如"能跑但性能差"、
"逻辑正确但命名糟糕"）没有覆盖。

---

## 过程中修的一个可观测性问题

P8 第一次跑 G5 失败时，演练只打印 `refused: undefined`，看不到原因。

**原因**：`Scheduler.runTask` 返回失败时，演练没打印 `failure.detail`。

**修复**：`p8-full-path.mjs` 现在打印 `failure.reason` 和 `failure.detail`。

这条改动不大，但它决定了"能不能诊断"和"只能看到一个失败"。

---

## 证据汇总

| 检查 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | exit=0 |
| 适配器（含重试） | `test/codex-adapter.test.ts` | 22/22 |
| 多任务计划 | `test/workflow-runplan-real.test.ts` | 3/3 |
| 失败恢复 | `test/workflow-recovery.test.ts` | 6/6 |
| G5 通过路径 | `tools/p8-full-path.mjs --accept-by ...` | 10/10，到 ARCHIVE |
| 重复稳定性 | `tools/p9-repeat.mjs --runs 3` | 3/3 到 ARCHIVE |
| 审查质量 | `tools/p9-review-quality.mjs` | 3/3 |
| 门禁演练 | `tools/p4-drill.mjs --repeat 10` | 15/15，每项 10/10 |

---

## 这一轮仍然证明不了什么

1. **重复只跑了 3 次。** 修复后的 3/3 是小样本，不能排除更低频率的抖动。
2. **审查质量只测两个极端。** 中间地带未覆盖。
3. **多任务计划用的是假适配器。** 没在真实子进程上跑 `runPlan`。
4. **失败恢复用的是假适配器。** 没在真实子进程崩溃/超时的情况下验证。
5. **G5 的签收是我填的字符串。** 门禁能审计它是否具体，但无法证明"那个人真的看了"。
