# P25：把几处“证明不了什么”真的补上

每一轮的文档结尾都有一段“这一轮证明不了什么”。这一段不是免责声明，
是待办清单。这一轮挑出其中**能够真正验证**的几条，一条条关掉。

## 1. 计划跑起来时看不到正在跑哪个任务（P18/P19）

`/api/state` 里的 `running.taskId` 在整份计划时是字面量 `"PLAN"`。
P21 已经让面板知道真实任务号（`active.currentTask`），但**没有暴露出去**，
也没有在界面上用。

修法两处：

```ts
running: active
  ? { taskId: active.taskId, currentTask: active.currentTask, cancelling: ..., startedAt: ... }
  : null,
```

```js
const shown = running.currentTask && running.currentTask !== running.taskId
  ? running.taskId + ' › ' + running.currentTask
  : (running.currentTask || running.taskId);
```

于是跑计划时徽章显示 `运行中：PLAN › T-ADD`，跑单任务时显示
`运行中：T-1`。

**这是 P21 留下的半截活**：数据已经收集，只是没送出去。

## 2. `stateDir` 指向文件时静默接受（P23 的“不可写目录”）

P23 写的是“`PANEL_STATE` 指向不可写目录时的行为没测”。实测发现的问题
比这更糟：`stateDir` 指向一个**普通文件**时，`createPanel` 照样成功：

```
created (unexpected)
```

因为原代码只有 `fs.realpathSync(options.stateDir)`，它对文件也成功。
后果是面板起来了、界面正常、直到第一次推进阶段时才炸出一句
`EEXIST`/`ENOTDIR`。**一个看起来活着但存不下任何东西的面板**。

修法：

```ts
let resolvedStateDir: string;
try {
  const stat = fs.statSync(options.stateDir);
  if (!stat.isDirectory()) throw new Error(`stateDir is not a directory: ${options.stateDir}`);
  resolvedStateDir = fs.realpathSync(options.stateDir);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
  fs.mkdirSync(options.stateDir, { recursive: true });
  resolvedStateDir = fs.realpathSync(options.stateDir);
}
```

两条路径都对：文件 → 立刻拒绝；不存在 → 创建（P23 的
`startPanel` 本来就该这么做，现在 `createPanel` 自己也会）。

新增 2 项测试。

## 3. 两层重试的叠加行为没测（P13 第 4 条）

P13 写着：`formatRetries`（适配器内部格式重试）与 `maxAttempts`
（调度器任务重试）“两层叠加时的行为没有专门测试”。

补上之后发现**答案不是直觉的那个**：它们不相乘。

```
executeCalls = 1   （调度器只跑了一轮）
childRuns    = 3   （适配器自己烧完了 formatRetries=2 的预算）
```

原因：`result-invalid` 在 `CodexAdapterError` 里声明为**不可重试**。
适配器耗尽自己的格式重试后抛出的就是这个错误，调度器读
`retryable === false` 直接放弃。

所以最坏情况是 3 个（formatRetries=2）而不是 6 个。这是对的设计——
格式错误再跑一遍大概率还是格式错误，不该让调度器再乘一层。

测试名字写成
`a malformed reply costs the adapter's budget once, not the scheduler's too`，
把结论写进名字里，防止以后有人“优化”成相乘。

## 4. 两个实例同时启动的端口冲突没测（P23 第 3 条）

`port: 0` 让操作系统分配端口，理论上不会冲突。实测：

```ts
const [a, b] = await Promise.all([
  host.startPanel({ repoRoot: repo, stateDir: first, port: 0 }),
  host.startPanel({ repoRoot: repo, stateDir: second, port: 0 }),
]);
assert.notEqual(a.port, b.port);
```

两个都拿到不同的端口，两个都返回 200，两个状态目录互不影响。

## 5. Electron 渲染断言是竞态的（P24 遗留）

P24 的 smoke 检查在 `did-finish-load` 里读 DOM。但 `did-finish-load`
在 HTML 解析完就触发，**早于**渲染进程自己的 `load()` fetch 返回。
结果时快时慢：

```
[app] render: {..."stageRows":0,"gates":0,"stageHint":""}
[app] smoke: render incomplete
```

第一次跑过了，第二次没过——典型的竞态。修法是轮询到数据到位：

```js
let rendered = await readState();
for (let attempt = 0; attempt < 40 && rendered.stageRows !== 13; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  rendered = await readState();
}
```

上限 4 秒。超时就真的失败，不无限等。

顺带把 `stageHint` 也纳入判定——静态 HTML 里它是空的，只有
`load()` 拿到 `/api/state` 后才填。**它才是“前后端通了”的证据**。

## 结果

```
402 用例，398 通过，4 跳过，0 失败
```

新增 4 项（stateDir 2 项、重试叠加 1 项、并发端口 1 项），
修了 2 个真缺陷（静默接受文件型 stateDir、Electron 渲染竞态），
补了 1 处数据没暴露（计划中的当前任务）。

## 这一轮仍然证明不了什么

1. **P13 第 1 条：Windows 上的 SIGTERM 信号名。** 测试只断言“分类为
   崩溃”，不断言名字，因为 `child.kill("SIGTERM")` 在 Windows 上走
   `TerminateProcess`，报告的名字可能不是 `SIGTERM`。要断言就得先知道
   Node 在 Windows 上实际报什么，这需要单独实验。
   **已补，见 P26**——实测 `close` 事件报的就是调用者传的名字。
2. **P13 第 2 条：OOM killer。** 触发条件难造，且不是这个项目的职责。
3. **P21 第 2 条：子进程忽略 SIGKILL。** 卡在不可中断 IO 时中断仍会等。
   这是操作系统语义，不是代码能改的。
4. **P21 第 3 条：取消后不回滚半写文件。** 这是刻意的：回滚需要知道
   哪些文件是这次写的，而观测是快照差分，可能包含用户自己的改动。
5. **P22 第 1 条：跳过项在 macOS 上是否正确。** 没有那台机器。
6. **P22 第 3 条 / P24 第 1 条：launchd 与真实 WorkBuddy Windows 安装。**
   两者都需要本机没有的环境。
7. **P24 第 2 条：Electron 的 GPU 报错。** 两条
   `command_buffer_proxy_impl` 错误不影响加载，但没有深究——它不是
   这个项目的代码。
8. **P24 第 3 条：双击 `.cmd` 的引号处理。** 测试走 `cmd.exe /c`，
   双击走 Explorer 关联，两者引号规则不同。
