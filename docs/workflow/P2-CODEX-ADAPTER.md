# P2：Codex 适配器

## 交付内容

| 文件 | 作用 |
|---|---|
| `src/workflow/adapters/codex.ts` | `CodexAdapter`，实现 `WorkflowAdapter` 五个方法 |
| `test/codex-adapter.test.ts` | 19 项单元测试（注入 `spawn`，不真跑） |
| `tools/p2-smoke.mjs` | 真实端到端探针 |

## 实现要点

**子进程隔离。** 每个任务在 `CODEX_HOME/runs/<task_id>/` 下有独立的
schema 与结果文件。`CODEX_HOME` 是可写副本，绝不碰用户的真实 `~/.codex`。

**结构化返回。** 用 `--output-schema` + `-o` 让子进程把结果写进文件，而不是
解析 stdout 里的散文。

**三层容错。** 实测发现网关模型并不严格遵守 `--output-schema`：

1. `extractJsonObject` 先试整体解析，再试 ```json 代码块，最后试最外层花括号。
2. `normalizeTaskResult` 把模型的近义词映射到协议字段（`task`→`task_id`、
   `stdout`→`output_tail`、`complete`→`succeeded`、`green`→`passed`）。
3. 归一化后仍必须过 zod schema。**无对应含义的字段直接丢弃**，不夹带。

**命令没有整数退出码就不算执行过。** 归一化时 `exit_code: null` 的记录被丢弃，
所以"我跑了但被拦住"不会伪装成"我跑成功了"。

**子进程非零退出时，成功声明降级为 `blocked`。** 孩子说成功但进程退出 1，
结果是 `blocked` 并附带原因，不是 `succeeded`。

## 沙箱约束（重要）

实测结论：

| 子进程沙箱 | 能否执行命令 |
|---|---|
| `read-only` | 否，`exec_command` 在进程创建前被拒 |
| `workspace-write` | 否，同上 |
| `bypass` | 是 |

原因：子进程继承父进程的沙箱策略，无法再创建自己的沙箱。因此
`CodexAdapter` 的 `sandbox` 是显式配置项，默认 `workspace-write`，
`bypass` 必须手动开启，且 `capabilityCheck` 会在 `detail` 里明说
"sandbox is disabled for child runs; this is an explicit opt-in"。

在 `workspace-write` 下，适配器**不会假装成功**：子进程如实报告
"命令未执行"，`validateTaskResult` 报出"验证命令未运行"，
探针 `exit=1`。

## 真实端到端证据

```
node tools/p2-smoke.mjs --sandbox bypass
exit=0

[smoke] status=succeeded
[smoke] summary=Created src/p2-probe.txt containing exactly the line 'probe ok'
        (verified bytes: 70 72 6F 62 65 20 6F 6B 0A) and ran node --version,
        which exited 0 and printed v26.11.1.
[smoke] commands=[{"command":"node --version","exit_code":0,"output_tail":"v26.11.1"}]
[smoke] tests=[{"name":"node --version exit code","outcome":"passed",...},
               {"name":"src/p2-probe.txt content check","outcome":"passed",...}]
[smoke] reconciliation problems=0
[smoke] PASS
```

探针同时验证三件事：读（子进程读仓库）、写（创建并校验文件字节）、执行
（跑命令拿真实退出码）。三者都通过才 `PASS`。

## 单元测试

```
npx tsx --test test/codex-adapter.test.ts
tests 19  pass 19  fail 0
```

覆盖：prompt 渲染、schema 自洽、二进制缺失、`CODEX_HOME` 不可写、
结果文件缺失、超时、协议违规、散文容错、代码块优先、字段归一化、
null 退出码丢弃、枚举映射、非零退出降级、证据收集、未知任务、
取消中止。

## 已知限制

1. `--output-schema` 在该网关模型上不强制生效，靠三层容错兜底。
2. 真实执行需要 `sandbox: bypass`。这在嵌套沙箱里无法避免；若要恢复
   最小权限，需要子进程跑在独立的、非沙箱化的父进程里。
3. `resume` 目前把反馈拼进 `background` 重跑，不是真正的会话续跑。
   真正的 `codex exec resume` 需要保存 session id，属于 P3 的工作。
4. 适配器只覆盖 Codex。Claude Code 与 DeepSeek 的适配器尚未实现。
