# P30：把面板改成四步向导，全中文

## 问题

上一版面板是三栏堆叠的 Cyber-HUD：左中右同时摆阶段图、配置表单、
任务列表、实时输出、历史、运行记录。英文标题密（Agent Matrix、
Direct Control、Live Terminal、Run History），字段名是术语
（allowed_paths、deliverables、acceptance_ids）。

对一个刚装上软件的人，这等于**同时面对六个面板和一套行话**。

## 改法

一条从上到下的四步：

```
① 选一个项目     名称 / 沙箱 / 代码目录 / 模型
② 说清要做什么   需求 + 验收项
③ 拆成几个任务   编号 / 角色 / 目标 / 文件 / 验收 / 依赖
④ 跑起来         任务列表 / 开始执行 / 实时输出 / 中断
```

阶段图、门禁、历史、运行记录收进三个折叠区，默认收起。

## 字段名对照

| 原来 | 现在 | 下面那行提示 |
|---|---|---|
| allowed_paths | 允许修改哪些文件 | 逗号分隔。写相对路径，越界的改动会被拦下。 |
| deliverables | 产出哪些文件 | 不改文件的任务填 (none)。 |
| acceptance_ids | 对应哪些验收项 | 必须是第 2 步里存在的编号。 |
| dependencies | 依赖哪些任务 | 没有依赖就留空。 |
| verification_command | 跑哪条命令 | 必须真的输出测试结果。只打印 ok 的脚本会被门禁拒绝。 |
| kind（自由输入） | 检查方式（下拉） | 自动检查 / 人工确认 |

`kind` 从自由输入改成下拉，因为原来要用户自己敲 `automated` 或
`manual`——一个拼错就静默变成第三种值。

## 报错翻译

后端返回英文，前端翻成人话：

| 原文 | 显示 |
|---|---|
| `repo_path does not exist` | 代码目录不存在，检查路径是否填对。 |
| `no project configured` | 还没有保存项目，先完成第 1 步。 |
| `a run is already in progress` | 已有任务在跑，等它结束或点中断。 |
| `gated by G0` | 这一步有质量门禁，需要先跑任务产出证据。 |
| `adapter-error` | 子进程出错 |

## 结构改动：面板拆成三个源文件

原来面板是一个 29 KB 的模板字面量，埋在 `server.ts` 第 540 行。
改一个括号要在 5 万字符里找。现在拆开：

```
src/workflow/
  panel.css.txt    样式
  panel.body.txt   结构
  panel.js.txt     逻辑
  server.ts        只保留 PANEL_HTML 这一个组装结果
```

`scripts/build-panel.mjs` 把三份拼起来，再替换 `server.ts` 里的字面量。

```powershell
node scripts/build-panel.mjs
```

这样改样式不用碰逻辑，改逻辑不用在 HTML 里翻。`String.raw` 不允许反引号，
脚本会先检查这一点再写入。

## 顺手修的两个语法错

拆分过程暴露了原代码里两个漏掉的右括号——它们一直藏着，因为整个
模板字符串从来没被单独语法检查过：

```js
// 历史条目
item.append(line, el('div','mono',new Date(...)+(rec.note?' · '+rec.note:''));   // 少一个 )
// 门禁徽章
gates.append(el('span','gate'+(on?' on':''),g+(on?' ✓':''));                      // 少一个 )
```

第二个是我新写的。第一个是原来就有的——**原来那行从来没执行到**，
因为历史为空时不会渲染条目。现在历史为空也安全。

## 测试

`test/workflow-server.test.ts` 里那条“内联脚本语法合法”的测试本来
就存在，它抓到了门禁那行。这就是它的价值。

`test/panel-entry.test.ts` 里断言旧英文标题的那条，改成断言四个步骤标题。

## 验证

```
[app] panel: http://127.0.0.1:58753/
[app] window: loaded
[app] render: {"title":"流水线控制台","hasStageMap":true,"hasNextStages":true,
               "stageRows":13,"gates":6,"stageHint":"当前阶段：接单（INTAKE）"}
[app] smoke: ok
```

`stageHint` 已经是中文，说明渲染进程拿到了新数据。

```
402 用例，398 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. 面板是四步向导，字段全中文，每个输入下面有填写说明
2. 阶段/门禁/历史/记录默认折叠，不干扰主流程
3. 后端英文报错在前端翻成人话
4. 面板可拆成三个文件维护，有构建脚本

## 这一轮证明不了什么

1. **没有真实用户走一遍。** 我只验证了渲染和语法，没验证「一个新
   用户能不能照着做完」。
2. **没有截图对比。** 没法证明它比旧版好看或更好用，只能说结构更简单。
3. **折叠区在小屏幕上可能挤。** 有 820px 的断点，但没在真手机上测。
4. **报错翻译只覆盖已知的几种。** 新的后端报错会原样显示英文。
