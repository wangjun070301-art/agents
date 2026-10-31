# P17：面板能配项目、能跑任务、能推阶段

## 这一轮补什么

P16 的面板只能看和放行。要跑一次真实的流水线，还得改 `project.json`
再写脚本。

## 项目模型

`src/workflow/project.ts` 定义了一个项目运行所需的全部东西：

| 字段 | 含义 |
|---|---|
| `name` | 显示名 |
| `repo_path` | 代码目录，**必须存在** |
| `model` | 子进程用的模型 ID |
| `sandbox` | `read-only` / `workspace-write` / `bypass`，默认 bypass |
| `requirements` | 需求与验收项 |
| `tasks` | 任务信封列表，至少一条 |

`repo_path` 不存在时保存直接失败。这一条挡的是"配置看着存下了、
跑起来才发现目录是错的"。

## 新增路由

| 路由 | 作用 |
|---|---|
| `POST /api/project` | 校验并保存项目 |
| `POST /api/run` | 跑单个任务 |
| `POST /api/advance` | 推阶段 |

## 关键决定：门禁不能靠点击通过

`/api/advance` 先查 `gateFor(from, to)`。这条边有门禁就直接 409：

```
stage SPEC -> PLAN is gated by G0; run a task to produce its evidence
```

面板没有能力伪造证据，所以它连尝试都不做。没有门禁的边才放行。

## 跑一个任务时发生什么

1. 复制 `auth.json` / `config.toml` / 模型目录到 `stateDir/codex-home`
2. 用真实 `CodexAdapter` + 真实 `Scheduler` 跑 `runTask`
3. 任务自己通过（证据支持声明）后，才由 `advanceStage` 问门禁
4. 门禁同意，阶段才动

第 3、4 步分开，是因为"这个任务做完了"和"这个阶段可以往前走"
是两个问题。合并它们，等于让一个任务的自信决定整条流水线。

## 测试（新增 6 项）

| 检查 | 结果 |
|---|---|
| 项目能保存并读回 | 通过 |
| 目录不存在时保存被拒 | 通过 |
| 未配置项目时跑任务被拒 | 通过 |
| 有门禁的边不给证据被拒（409，提示 G0） | 通过 |
| 无门禁的边可以推 | 通过 |
| 状态里列出可达阶段及其门禁 | 通过 |

## 这一轮证明不了什么

1. 表单还是手写 JSON，不友好
2. 只能跑单个任务，不能按依赖顺序跑整份计划
3. 跑的时候看不到子进程输出

