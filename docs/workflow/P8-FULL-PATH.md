# P8：六道门禁的真实全链路

## 目标

P7 只验证了 G2。其余五道只在单元测试里通过，没在真实子进程上跑过。
这一轮把十二个阶段、六道门禁全部走一遍，能真跑的真跑。

## 真跑的部分

| 门禁 | 怎么验的 |
|---|---|
| G0 | 需求集 + 任务信封，真实数据 |
| G1 | 同一份计划，检查 AC 覆盖与写冲突 |
| G2 | **真 `codex exec` 子进程**改 `src/calc.js`，观测确认 |
| G3 | **第二个真子进程**读 diff 做审查，产出结构化结果 |
| G4 | 每条 AC 跑**自己的命令**，解析真实 TAP 输出 |
| G5 | 需要真人签收，**演练不伪造** |

## 不能真跑的部分，以及为什么

G5 需要"具名的人看过某个构建"。演练里没有人。三种选择：

1. 编一个假名字 → 违反"禁止伪造"
2. 跳过 G5 → 门禁形同虚设
3. **让 G5 拦住，并把这个拦住当作演练通过** ← 选的这个

所以默认运行的结果是：

```
[p8] ACCEPT -> DELIVER: refused (gate-failed)
PASS  [G5] the delivery gate blocks without a named human acceptance
      blocked: human-acceptance: no recorded human acceptance
```

要真交付，得本人跑：

```powershell
node tools/p8-full-path.mjs --sandbox bypass `
  --accept-by "你的名字" `
  --accept-note "我看了 src/calc.js 的 diff 和 node --test 的输出"
```

这时 G5 会用**真实签收**通过，并继续到 ARCHIVE。

## 过程中发现并修掉的真 bug

### Bug 1：`advanceStage` 丢字段（P7 引入）

第一次跑到 G3 就失败了：

```
G3 blocked REVIEW -> VERIFY: review-ran: no review findings supplied
```

但我明明传了 `{ reviewFindings: [] }`。查下来 `buildGateInput` 只映射了
6 个字段，**漏了 `reviewFindings`、`verifications`、`recorded`**。

后果：G3/G4/G5 在真实链路里永远无法通过，因为它们需要的输入根本到不了门禁。

修复后加了三条测试专门锁住这个 bug——每个字段一条，防止再漏。

### Bug 2：绕过适配器手写 `codex exec`

第一版 G3 直接 `execFileSync(codexPath, [...])`。两次运行，两种结果：

- 第一次：输出 `{"findings":[]}` ✓
- 第二次：输出 `[R]\n\nbrief received...` ✗ 纯散文，没有 JSON

原因：手写调用**绕过了适配器的 schema 处理和重试逻辑**。

修复：审查也走 `CodexAdapter.execute`，用 `TaskResult.test_results`
承载 findings。这样审查和开发走同一条路径，同一套容错。

**这个 bug 顺带证明了一件事**：单次通过不代表稳定。同一个 prompt，
同一个模型，两次结果不同。这就是为什么 P6 要加 `--repeat`。

## 结果

```
node tools/p8-full-path.mjs --sandbox bypass
exit=0, 10/10

[p8] final stage ACCEPT
[p8] gates recorded: ["G0","G1","G2","G3","G4"]
```

十项检查：

| 编号 | 检查 | 结果 |
|---|---|---|
| G0 | 需求有决定方式，过 G0 | 通过 |
| G1 | 计划覆盖全部 AC，过 G1 | 通过 |
| G2-run | 真子进程产出可采集的证据 | 观测到 `src/calc.js` |
| G2 | 实现门禁接受真实运行 | 通过 |
| G3-review | 真审查者产出结构化结果 | 1 行，clean=true |
| G3 | 审查门禁接受真实审查 | 通过 |
| G4-run | 每条 AC 跑了各自的命令 | 两条都 passed |
| G4 | 验证门禁接受逐条证据 | 通过 |
| G5 | 无人工签收时拦住 | **按设计拦住** |
| STAGES | 每条有门禁的边都被真实走过 | G0–G4 记录在案 |

## 这套演练证明了什么

1. 六道门禁的判定逻辑在**真实数据**上都能工作，不只是构造数据。
2. 阶段机 + 调度器 + 适配器 + 观测 + 解析器，五件东西真的能串起来。
3. G5 在没人签收时**真的会拦**，不是摆设。
4. 两个真子进程（开发 + 审查）在同一条链路里协作。

## 这套演练**证明不了**什么

1. **G5 的通过路径没跑过。** 只证明了它会拦，没证明正确签收后能过。
   （需要真人跑一次 `--accept-by`。）
2. **只跑了一次。** 上面 Bug 2 就展示了同一 prompt 两次结果不同。
3. **`runPlan` 的多任务路径没在真实链路里跑。** 只跑了单任务。
4. **失败恢复没测。** 子进程崩溃、超时、BLOCKED 之后的恢复。
5. **审查质量未经评估。** 只验证了"能产出结构化结果"，
   没验证"审查结论是否正确"。审查者说 clean，我接受了——因为改动确实是
   一行注释。换成真实改动时，这个信任需要重新检验。
