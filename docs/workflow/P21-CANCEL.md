# P21：中断真的中断

## 发现的问题

P19 加了中断按钮，但只对"跑单个任务"有效。两个真缺口：

**缺口一：整份计划的中断是空操作。**

`/api/run-plan` 建 `active` 时 `adapter` 留 `null`，`executePlan` 里
也没把它接回来。于是：

```ts
if (active.adapter) active.adapter.cancel(active.taskId);  // null，什么都不做
```

点中断，界面显示"正在取消"，子进程照跑，后面的任务照派。

**缺口二：在子进程启动前取消，任务照样启动。**

P19 的注释写着"flag alone makes the next run stop before spawning"。
实际上 `executeTask` 从不读 `cancelling`。这个 flag 只被写，从没被读。

## 修法

调度器新增两个可选钩子，不改变任何既有语义：

| 钩子 | 谁调 | 干什么 |
|---|---|---|
| `onTaskStart(taskId)` | `runTask` 开头 | 告诉面板"现在活的是这个任务" |
| `isCancelled()` | 每次尝试前、每个计划步前 | 面板的取消 flag |

面板侧：

- `active.currentTask` 记录真正在跑的任务；中断时取消它，不是取消 `"PLAN"`
- `executePlan` 接上 `onCreated` / `onTaskStart` / `isCancelled` / `onOutput`
- 取消发生在子进程之前时，`runTask` 直接返回 `reason: "cancelled"`，不 spawn
- 计划循环看到取消，把剩余任务全部标为 `cancelled by the panel`

## 为什么取消不算重试

`cancelled` 是新增的失败原因，不是 `adapter-error`。取消是决定，不是故障：

- 不消耗重试预算（否则点一次中断会白跑两轮）
- 不触发 `blockOnExhaustion`（否则用户点一下中断就把整条流水线冻结）

## 测试（新增 5 项）

| 检查 | 结果 |
|---|---|
| 首次尝试前取消，不 spawn 任何子进程 | 通过 |
| 取消后不再重试（`attempts === 1`） | 通过 |
| 取消不阻塞流水线 | 通过 |
| `onTaskStart` 在任务运行前拿到任务号 | 通过 |
| 计划跑到一半被取消，只剩在飞的那一个 | 通过 |

## 结果

```
workflow-recovery        18/18
workflow-runplan-real     6/6
workflow-server          16/16
workflow-scheduler       15/15
workflow-gates           49/49
workflow-pipeline        11/11
workflow-contracts       39/39
workflow-observer        16/16
test-output              12/12
codex-adapter            23/23
codex-crash              11/11
合计                    216/216
```

## 这一轮证明了什么

1. 中断对整份计划有效，不是只管第一个任务
2. 在子进程存在之前点中断，不会启动它
3. 取消不会被误判成故障，不会重试、不会冻结流水线
4. 面板的取消按钮指向的是活着的那个子进程

## 这一轮证明不了什么

1. 没有在真实子进程上验证——本轮用的是桩适配器
2. 子进程忽略 SIGKILL（例如卡在不可中断的 IO）时，中断仍会等它
3. 取消后已写了一半的文件不会回滚

