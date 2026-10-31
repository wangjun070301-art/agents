# P13：崩溃可以重试，超时不行

## 发现的问题

调度器的 maxAttempts 只对门禁拒绝生效。适配器抛错时直接失败：

```ts
} catch (error) {
  const failure = { reason: "adapter-error", detail: ... };
  return { ok: false, attempts, failure };   // 立即返回，不重试
}
```

后果：一次 SIGKILL（外部杀进程、OOM）就让任务彻底失败，
哪怕下一次重跑很可能成功。

## 修法：让适配器声明可重试

CodexAdapterError 新增 retryable 字段：

| 错误 | retryable | 理由 |
|---|---|---|
| timeout | false | 预算耗尽了，再跑还会超时 |
| spawn-failed（cancel） | false | 是决定，不是故障 |
| spawn-failed（被信号杀） | true | 外部事件，重跑可能成功 |
| result-invalid | false | 由 formatRetries 单独处理 |
| 其他 | false | 不知道就别猜 |

调度器的 catch 里读这个字段：可重试且还有预算就继续，否则立即失败。

## 关键设计：不猜

isRetryable 只看错误对象上的 retryable === true。
没有这个字段的错误一律不重试——盲目重试等于把一次失败变成两次。

## 测试（新增 7 项）

| 检查 | 结果 |
|---|---|
| 可重试错误重试一次后成功 | 通过 |
| 不可重试错误立即失败 | 通过，只调用 1 次 |
| 可重试错误仍受 maxAttempts 限制 | 通过，2 次后放弃 |
| 无标记的错误不重试 | 通过 |
| SIGTERM 与 SIGKILL 同样分类 | 通过 |
| 未知信号名（SIGSEGV）仍算崩溃 | 通过 |
| 真实 SIGTERM | 通过 |

## 结果

```
test/workflow-recovery.test.ts   10/10
test/codex-crash.test.ts         11/11
全量                              354 用例，336 通过，18 失败（基线）
```

## 这一轮证明了什么

1. 崩溃现在会重试，一次 SIGKILL 不再直接判死刑
2. 超时和取消不会重试，不浪费预算
3. 信号名是通用的，SIGKILL / SIGTERM / SIGSEGV 同一路径
4. 未知错误不盲重试

## 这一轮证明不了什么

1. 真实 SIGTERM 在 Windows 上的信号名未断言。测试只断言分类为崩溃，
   因为 Windows 的 child.kill("SIGTERM") 走 TerminateProcess，
   报告的名字可能不是 SIGTERM。
2. OOM killer 没测。它通常发 SIGKILL，但触发条件难造。
3. 崩溃后 BLOCKED 的完整流转没测。现在崩溃→重试→再失败→返回失败，
   调度器不会自动进入 BLOCKED；那需要调用方决定。
4. formatRetries 与 maxAttempts 的交互没测。一个是适配器内部的
   格式重试，一个是调度器的任务重试，两层叠加时的行为没有专门测试。
