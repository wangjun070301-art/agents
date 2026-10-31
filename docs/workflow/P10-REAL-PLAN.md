# P10：真实子进程的多任务计划与失败恢复

## 补的是哪两块

P9 记录里最后两条"证明不了"：

> 3. 多任务计划用的是假适配器。没在真实子进程上跑 `runPlan`。
> 4. 失败恢复用的是假适配器。没在真实子进程崩溃/超时的情况下验证。

这一轮两块都补上。

## 做法

`tools/p10-real-plan.mjs`，一个真 git 仓库，四个真 `codex exec` 子进程。

### 三个任务的计划

| 任务 | 做什么 | 依赖 |
|---|---|---|
| T-A | 改 `src/a.js`，跑 `node --test src/a.test.js` | — |
| T-B | 改 `src/b.js`，跑 `node --test src/b.test.js` | — |
| T-JOIN | 跑两个测试并汇总，不改文件 | T-A、T-B |

### 两个强制的失败

| 场景 | 怎么造 | 期望 |
|---|---|---|
| 越界写入 | 子进程跑完后，由演练在 `src/` 之外写一个文件 | G2 拦住 |
| 超时 | 给子进程 10 秒，但任务需要更久 | 报 `adapter-error`，阶段不动 |

**关键设计**：越界写入不是让子进程"故意违规"。实测过，让子进程越界它往往
照做；那样测的是模型的服从性，不是门禁的检测能力。所以违规由工作区引入，
门禁通过观测看到它。测的是检测器，不是模型。

## 结果

```
node tools/p10-real-plan.mjs --sandbox bypass
exit=0, 7/7

[p10] completed=["T-A","T-B","T-JOIN"] failed=0 skipped=0 elapsed=76s
PASS  [P1] runPlan completed both independent tasks with real children
PASS  [P2] the dependent task ran only after both dependencies finished
PASS  [P3] the observer recorded each task's real edit separately
PASS  [P4] the stage did not move during runPlan
PASS  [P5] G1 accepts the real three-task plan
PASS  [P6] a file written outside the allowlist is refused by G2
PASS  [P7] a real timeout is reported as an adapter error, and the stage stays put
```

## 过程中修掉的三个真问题

### 问题 1：`validateTaskResult` 用子进程声明，不用观测

T-A 失败了，报 `deliverable not produced: src/a.js`。

但观测明明看到了 `src/a.js` 被改。矛盾来自：

```ts
const problems = validateTaskResult(envelope, result);  // 用的是 result.changed_files
```

`result.changed_files` 是**子进程自己报的**。子进程改了文件却忘了在 JSON 里
提一句，校验就认为交付物不存在。

**修复**：`taskRefusal` 在观测可用时，把观测结果并入 `changed_files` 再校验。
子进程漏报是**报告瑕疵**，不是**工作没做**。

同时保留"观测到但没报告"的记录，交给 G2 的 `changed-files-honest` 检查——
那才是判断诚实性的地方。

### 问题 2：占位符交付物被当成真路径

T-JOIN 是只读任务，`deliverables: ["(no file)"]`。校验把它当路径，报"交付物未产出"。

**修复**：`validateTaskResult` 跳过括号包裹的条目。它是占位符，不是文件。

### 问题 3：G1 的阶段用错了

演练里 pipeline 从 `DISPATCH` 开始，然后又试图 `advanceStage("DISPATCH", ...)`，
得到 `illegal transition DISPATCH -> DISPATCH`。

**修复**：pipeline 从 `PLAN` 开始，`runPlan` 不动阶段，最后推进一次到 `DISPATCH`。

## 这套演练证明了什么

1. **`runPlan` 在真实子进程上能按依赖顺序执行**，耗时 76 秒，三个任务全完成。
2. **观测在真实链路上可靠**：每个任务的改动被单独记录。
3. **阶段不会被任务执行绑架**：`runPlan` 跑完后阶段仍在 PLAN。
4. **越界写入能被 G2 拦住**，用的是观测到的真实文件列表。
5. **超时被正确分类**：`adapter-error`，不是 `gate-failed`，阶段不动。

## 这套演练**证明不了**什么

1. **越界是演练自己造的，不是子进程违规。** 子进程真的越界时，行为未测。
2. **只跑了一次。** P9 已经证明单次通过不代表稳定。
3. **超时是唯一测到的失败形态。** 崩溃（进程被杀、OOM）没测。
4. **`runPlan` 的并发没测。** 现在的实现是串行；如果将来并行，
   写冲突检测需要重新验证。
5. **G1 的写冲突检测在真实路径上只验证了"不冲突"这一面。**
   两个任务真冲突时会被拦——那是 P4 的构造数据，不是真实子进程。
