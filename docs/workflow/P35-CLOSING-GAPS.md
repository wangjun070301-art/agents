# P35：把 P34 没证明的四条补上

P34 结尾列了五条"证明不了什么"，这一轮补了其中四条。

## 一、失败路径

`scripts/failure-path-drill.mjs`，三个任务：

```
T-WRITE  (developer / codex)   → 写 src/greet.js
T-REVIEW (reviewer / claude)   → 故意失败（网关指向死端口）
T-PUBLISH(integrator / codex)  → 依赖 T-REVIEW
```

结果：

```
completed: ["T-WRITE"]
failed: ["T-REVIEW:adapter-error:claude 报错（HTTP ?）：Not logged in · Please run /login"]
skipped: [{"taskId":"T-PUBLISH","because":"dependency T-REVIEW failed"}]
calls: ["T-WRITE:codex","T-REVIEW:claude"]
```

四项都成立：

1. 失败任务被如实报告，原因是真的（Claude 连不上）
2. **上游 agent 的产物没被动**——`src/greet.js` 还在
3. 下游任务被跳过，跳过的理由点名了失败的那个任务
4. 失败的任务**没有被派出去**（`T-PUBLISH` 不在 calls 里）

还有一点：非可重试失败**不会阻塞流水线**。

## 二、并发

`scripts/concurrency-drill.mjs`，两个 Claude 任务并行，各自一个仓库：

```
T-A: succeeded — Read input.txt (contents: 'alpha'), wrote OUTPUT.txt
T-B: succeeded — Read input.txt (content: 'beta'), wrote OUTPUT.txt
elapsed: 21s
```

- 两个任务各自起了一个代理，**端口没有冲突**（代理用 `listen(0)`）
- 输出**没有交叉污染**：A 的文件里没有 beta，B 的文件里没有 alpha

## 三、换模型

`scripts/model-sweep-drill.mjs`，三个不同厂商的模型，同一个任务：

| 模型 | 结果 | 耗时 |
|---|---|---|
| `glm-5.3` | succeeded，写了文件 | 22s |
| `deepseek-v4.1-flash` | succeeded，写了文件 | 18s |
| `kimi-k3.1-pro` | succeeded，写了文件 | 27s |

**3/3 通过。** 转接层不只对 `glm-5.3` 有效。

## 四、更长计划

`scripts/long-plan-drill.mjs`，五个任务、三个角色、扇出加汇合：

```
T-IMPL-A (developer / codex)  ─┐
T-IMPL-B (developer / codex)  ─┼─► T-TEST (tester/claude) ─► T-REVIEW (reviewer/claude) ─► T-SIGN (integrator/codex)
```

结果：

```
completed: ["T-IMPL-A","T-IMPL-B","T-TEST","T-REVIEW","T-SIGN"]
calls: ["T-IMPL-A:codex","T-IMPL-B:codex","T-TEST:claude","T-REVIEW:claude","T-SIGN:codex"]
```

五个全过，顺序正确（扇出 → 汇合 → 串行链）。

## 第一次跑失败了，这次失败有价值

长计划第一次跑，`T-IMPL-B` 失败：

```
reason: attempts-exhausted
detail: deliverable not produced: src/mul.js; verification command was not run
```

查 `result.json` 发现 Codex 输出的是原始对话文本，不是 JSON——它在写文件之前就吐了工具调用。

**这不是路由 bug，是 Codex 的偶发输出问题。** 重跑一次就全过了。

重要的是：**门禁正确拦住了它。** 一个没写文件、没跑命令的 `partial` 结果没有蒙混过去，下游三个任务被跳过而不是在假成果上继续。这正是门禁存在的意义。

## 结果

```
421 用例，417 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. 失败路径的四个行为都成立：如实报告、上游不受影响、下游跳过、不派发
2. 两个 Claude 实例能并行，各自代理互不干扰
3. 转接层对三个不同厂商的模型都有效
4. 五个任务、三个角色、扇出加汇合的完整计划能跑通
5. 门禁会拦住"没干活却声称完成"的结果

## 这一轮证明不了什么

1. **Codex 的偶发失败没有根治。** 第一次跑 `T-IMPL-B` 输出格式坏了，重跑就好。
   原因没查透——可能是模型在长 prompt 下偶尔提前截断。
2. **并发只测了两个。** 三个以上同时跑没测。
3. **换模型只测了三个。** 网关有 31 个，其余没测。
4. **长计划只跑了一次成功。** 稳定性没有重复验证。
