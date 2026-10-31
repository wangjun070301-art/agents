# P19：实时输出与中断

## 这一轮补什么

P18 的计划一跑就是几分钟，界面只有"运行中"三个字。
看不到子进程在干什么，也没法停。

## 输出是怎么流过来的

三跳，每一跳都只加一个回调，不改变原有语义：

| 层 | 改动 |
|---|---|
| `defaultSpawn` | `child.stdout.on("data")` 里同时累积和回调 |
| `CodexAdapter` | `onOutput` 透传进 `spawn` 选项 |
| `server.ts` | 追加进环形缓冲，上限 2000 条 |

**累积没有换成回调**：结果解析仍然读完整 stdout。流式输出是给人看的，
不是新的结果来源。

## 环形缓冲

```ts
active.lines.push(redactSecrets(chunk));
if (active.lines.length > 2000) active.lines.splice(0, active.lines.length - 2000);
```

一个跑几小时的任务能产出几十万行。不设上限，面板进程自己会被撑死。

## 中断

`POST /api/cancel` 做两件事：

1. 置 `active.cancelling = true`
2. 如果适配器已经创建，调 `adapter.cancel(taskId)`

适配器侧 `cancel` 走 `AbortController.abort()`，`defaultSpawn` 的 abort
监听器杀掉子进程，并把结果标记为 `cancelled`。

**这个标记是必要的**：`cancel()` 用的也是 SIGKILL。没有它，
用户主动取消会被上报成崩溃——进而被当成可重试故障重跑一次。
P12 就是为这件事加的字段。

## 测试（新增 2 项）

| 检查 | 结果 |
|---|---|
| 没有任务在跑时中断被拒（409） | 通过 |
| 状态快照里 `outputLines` 永远是数组，哪怕为空 | 通过 |

第二条防的是前端 `(outputLines||[]).join('')` 之外的路径拿到 `undefined`。

## 这一轮证明不了什么

1. 中断只对单个任务验证过；整份计划的取消当时是断的（P21 修）
2. 输出是轮询拉的（3 秒一次），不是推送

