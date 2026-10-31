# P12：崩溃与超时是两条不同的路

## 为什么这一轮

P10/P11 只测到超时。超时是适配器自己的定时器触发；崩溃是操作系统报告信号。
两条路径不同，而后者在代码里根本没有被区分。

## 发现的问题

`spawn` 的 `close` 回调只取了 `code`：

```ts
child.on("close", (code) => finish({ code: code ?? -1, ... }))
```

被信号杀死的进程 `code` 是 `null`，于是被当成"退出码 -1"。**结果：
崩溃和普通非零退出无法区分。**

如果崩溃的子进程恰好留下了一个残缺的结果文件，适配器会继续解析它，
把半截 JSON 当结果——或者更糟，把一次崩溃当成任务完成。

## 修法

`SpawnOutcome` 新增两个字段：

| 字段 | 含义 |
|---|---|
| `killedBy` | 被哪个信号杀死（`SIGKILL`、`SIGTERM`） |
| `cancelled` | 是否由本适配器自己的 `cancel()` 触发 |

`executeOnce` 在解析结果前先判断：

| 情况 | 抛出的错误 |
|---|---|
| `timedOut` | `timeout` |
| `cancelled` | `spawn-failed`（消息含 "cancelled"） |
| `killedBy` 但非 cancel | `spawn-failed`（消息含 "terminated by"） |
| 自己退出且非零 | `result-missing`（原有逻辑） |

**关键区分**：`cancel()` 也用 `SIGKILL`，如果不加 `cancelled` 标记，
用户主动取消会被误报成崩溃。

## 测试（5 项，全过）

| 检查 | 怎么测 |
|---|---|
| 被信号杀死 → 报 crash | **真的启动一个长跑子进程并 SIGKILL** |
| 超时 → 报 timeout | 注入 `timedOut: true` |
| 自己非零退出 → 不是 crash | 注入 `code: 2`，无结果文件 |
| 取消 → 报 cancelled | 注入 `cancelled: true` |
| 崩溃不重试 | `formatRetries: 3`，断言只调用 1 次 |

**第一条用的是真进程**，不是模拟的 `killedBy` 字段。`cmd.exe /c ping` 睡 30 秒，
300 毫秒后 kill，验证 `close` 事件里 `signal` 真的是 `SIGKILL`。

## 结果

```
npx tsx --test test/codex-crash.test.ts
5/5 pass

全量：
tests 344, pass 326, fail 18
```

18 个失败全是既有平台问题，新增的 5 项零失败。

## 这一轮证明了什么

1. **崩溃和超时现在是可区分的**，各自有独立的错误类型和消息
2. **取消不会伪装成崩溃**
3. **崩溃不会被当成格式抖动重试**
4. **真实 SIGKILL 走通了整条路径**，不只是模拟字段

## 这一轮**证明不了**什么

1. **只测了 `SIGKILL`。** `SIGTERM`、`SIGSEGV`、OOM killer 都没测。
   代码对 `killedBy` 是通用的，但没验证过其他信号。
2. **没测"崩溃留下残缺结果文件"这个最危险的情况。** 现在的代码在
   `killedBy` 时直接抛错，不看结果文件——逻辑上是对的，但没有一个测试
   专门造一个半截 JSON 来证明它确实被跳过。
3. **没测 Windows 上 `taskkill` 的差异。** 测试用的是 `child.kill()`，
   在 Windows 上它走的是 `TerminateProcess`，信号名可能不同。
4. **崩溃后的恢复路径没测。** 现在只是报错，调度器重试一次再失败；
   那之后 BLOCKED 怎么走没验证。
