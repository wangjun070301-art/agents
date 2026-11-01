# P26：Windows 上信号到底叫什么名字

## 为什么要做这个实验

P13 留了一条：

> 真实 SIGTERM 在 Windows 上的信号名未断言。测试只断言分类为崩溃，
> 因为 Windows 的 `child.kill("SIGTERM")` 走 `TerminateProcess`，
> 报告的名字可能不是 SIGTERM。

P25 把它列进“仍然证明不了什么”，理由是“需要单独实验”。

这一轮把实验做了。它只需要临时目录，不依赖任何本机没有的环境。

## 实验

### 第一层：Node 自己怎么报

```js
const child = spawn("cmd.exe", ["/c", "ping", "-n", "30", "127.0.0.1"], { stdio: "ignore" });
setTimeout(() => child.kill("SIGTERM"), 400);
child.on("close", (code, signal) => resolve({ code, signal }));
```

三种信号各跑一次：

```
{"killSignal":"SIGTERM","code":null,"signal":"SIGTERM"}
{"killSignal":"SIGKILL","code":null,"signal":"SIGKILL"}
{"killSignal":"SIGINT","code":null,"signal":"SIGINT"}
```

**结论：Windows 上 `close` 事件报的就是调用者传进去的名字。**
`TerminateProcess` 在底下做的是别的事，但 libuv 层保留了这个字符串。

### 第二层：适配器怎么分类

只测 Node 不够——真正要断言的是 `CodexAdapterError` 的形状。

```js
try { await adapter.execute(envelope); }
catch (error) {
  console.log({
    kind: error.kind,
    retryable: error.retryable,
    reportedSignal: seen,
    messageSignal: (/terminated by (\S+)/.exec(error.message) ?? [])[1],
  });
}
```

结果：

```
{"sig":"SIGTERM","kind":"spawn-failed","retryable":true,"reportedSignal":"SIGTERM","messageHasTerminatedBy":true,"messageSignal":"SIGTERM;"}
{"sig":"SIGKILL","kind":"spawn-failed","retryable":true,"reportedSignal":"SIGKILL","messageHasTerminatedBy":true,"messageSignal":"SIGKILL;"}
```

三条都能断言了：

| 断言 | 值 |
|---|---|
| `error.kind` | `spawn-failed` |
| `error.retryable` | `true` |
| `error.message` | 含 `terminated by SIGTERM` |

`retryable: true` 是关键——信号杀是外部事件，重跑可能成功。这个分类
在 P13 就定下了，现在有实测支撑。

## 改了什么

`test/codex-crash.test.ts` 里那条测试从“只断言分类”变成“断言分类 +
可重试 + 消息里的信号名”：

```ts
await assert.rejects(
  () => adapter.execute(envelope),
  (error: unknown) =>
    error instanceof CodexAdapterError &&
    error.kind === "spawn-failed" &&
    // Measured on Windows 11 + Node 26: `child.kill("SIGTERM")` goes through
    // TerminateProcess but the `close` event still reports the name the
    // caller asked for, so "SIGTERM" is what the adapter sees there too.
    // A signal kill is an external event, hence retryable.
    error.retryable === true &&
    /terminated by SIGTERM/.test(error.message),
);
assert.equal(reported, "SIGTERM", "the close event must name the signal the caller sent");
```

顺带把隔壁那条测试的名字改准确了：
`SIGTERM is classified as a crash just like SIGKILL`
→ `SIGTERM and SIGKILL are both classified as retryable crashes`。
原名只说“崩溃”，没提可重试，而可重试才是这个分类的实际后果。

## 结果

```
402 用例，398 通过，4 跳过，0 失败
```

测试数量没变——是把一条弱断言换成强断言。

## 这一轮证明了什么

1. Windows 上 `child.kill("SIGTERM")` 之后，`close` 事件报 `SIGTERM`
2. 适配器把它归类为 `spawn-failed` 且 `retryable: true`
3. 错误消息里带得出信号名，可以据此写日志和判断

## 这一轮证明不了什么

1. **只测了 Node 26 / Windows 11。** 别的 Node 版本或 Windows 版本
   是否也保留信号名，没验证。这个断言如果将来在 CI 上红了，先查这里。
2. **`SIGINT` 只测了 Node 层，没测适配器。** 适配器的 `cancel()` 走
   `AbortController`，不走 `SIGINT`，所以那条路径本来就不经过这里。
3. **没有真实的 `taskkill` 场景。** 实验里是自己 `child.kill()`；
   外部进程（任务管理器、OOM、`taskkill /F`）打过来的情况，
   `signal` 字段可能是别的值，没测。
