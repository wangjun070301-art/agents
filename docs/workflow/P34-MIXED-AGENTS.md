# P34：混合 agent 的真实计划

## 补的是哪一条

P33 结尾写明："没跑完整多任务计划。路由逻辑有单测，但没跑过
'实现用 Codex、审查用 Claude' 的端到端流水线。"

这一轮跑了，并且**真跑通了**。

## 演练

`scripts/mixed-agents-drill.mjs`，一个真 git 仓库，两个任务，两个 agent：

| 任务 | 角色 | 绑定的 agent | 做什么 |
|---|---|---|---|
| T-WRITE | developer | Codex | 写 `src/greet.js` 并跑验收命令 |
| T-REVIEW | reviewer | Claude Code | 读文件，写 `REVIEW.md` |

T-REVIEW 依赖 T-WRITE，所以顺序由调度器决定，不是我写死的。

## 结果

```
bindings: {"developer":"codex","reviewer":"claude"}
developer -> codex | reviewer -> claude
task T-WRITE -> codex
task T-REVIEW -> claude

completed: ["T-WRITE","T-REVIEW"]
failed: []
skipped: []
calls: ["T-WRITE:codex","T-REVIEW:claude"]
```

两个任务的产出：

```js
// src/greet.js（Codex 写的）
function greet(name) {
  return 'hello ' + name;
}
module.exports = { greet };
```

```markdown
<!-- REVIEW.md（Claude 写的） -->
Exported function: greet — returns a string (yes).
```

耗时：Codex 18.3 秒，Claude 30.8 秒。两个都一次通过，没有重试。

## 这一轮同时证明了什么

1. **角色分派真的生效**：同一个计划里，两个任务去了两个不同的二进制
2. **每个任务用自己那个 agent 的证据**：`observedChanges` 分别来自
   各自的适配器，不是共用一个
3. **Claude 能写文件**：P33 只验证了读，这次它写出了 `REVIEW.md`

## 补的自动化测试

`test/role-routing.test.ts`，2 项，用桩适配器锁住路由决策本身：

| 检查 | 说明 |
|---|---|
| 每个角色到达自己的 agent | 断言调用序列是 `T-WRITE:developer`、`T-REVIEW:reviewer` |
| 没有绑定 agent 的角色直接失败 | 不会偷偷借用别的 agent |

第二条是重要的：如果路由在找不到绑定时回退到 Codex，一个本该由审查
agent 做的任务会被开发 agent 悄悄做掉，而结果是"成功"。

## 结果

```
421 用例，417 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. 混合 agent 的完整计划能跑通，不是理论
2. Claude 在这条流水线里能读也能写
3. 路由失败是显式的，不会静默降级

## 这一轮证明不了什么

1. **只用了一个模型**（Claude 走 `glm-5.3`）。换模型没测。
2. **只跑了两个任务。** 更长的计划、更多角色组合没测。
3. **两个 agent 都是同一类任务**（写文件）。Codex 做测试、Claude 做实现
   这类组合没测。
4. **失败路径没演练。** 如果 Claude 那一步失败，Codex 的产物怎么处理，
   没有专门验证。
5. **并发没测。** 两个 agent 同时跑会各自起一个代理和子进程，没验证资源
   冲突。
