# P24：补完 P22/P23 剩下的三条

P22 结尾列了三条没做的，P23 又补了一句 Electron 窗口没验证。这一轮把
第 1、4、5 条一起关掉。

## 1. Electron 窗口真跑

### 先得有个二进制

`node_modules/electron` 只有安装器，没有 `dist/`。直接跑 `install.js`
报 `TypeError: fetch failed`——GitHub 下载不通。设镜像后成功：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

```
v45.2.1
```

### 怎么验证"窗口真的画了"

光看到 `did-finish-load` 不够——那只说明 HTTP 请求成功了，不说明页面
渲染出了东西。`PANEL_SMOKE=1` 时壳子会向渲染进程要一份自检：

```js
const rendered = await win.webContents.executeJavaScript(`
  ({
    title: document.title,
    hasStageMap: !!document.getElementById('stageMap'),
    hasNextStages: !!document.getElementById('nextStages'),
    stageRows: document.querySelectorAll('.stage-row').length,
    gates: document.querySelectorAll('.gate').length,
    stageHint: document.getElementById('stageHint').textContent,
  })
`);
```

四项断言：

| 检查 | 证明什么 |
|---|---|
| `stageRows === 13` | 阶段地图真的画了 |
| `gates === 6` | 六道门禁真的画了 |
| `title === 流水线控制台` | 加载的是对的页面 |
| `stageHint` 匹配 `/当前阶段/` | **渲染进程真的请求了 `/api/state`** |

最后一项是关键：静态 HTML 里 `stageHint` 是空的，只有 `load()` 拿到
服务端数据后才会填。所以它证明的不是"页面打开了"，是"前后端通了"。

### 实测

```
[app] panel: http://127.0.0.1:52121/
[app] window: loaded
[app] render: {"title":"流水线控制台","hasStageMap":true,"hasNextStages":true,
               "stageRows":13,"gates":6}
[app] smoke: ok
exit=0
```

### 测试

`test/electron-shell.test.ts`，2 项：

| 检查 | 说明 |
|---|---|
| 壳子加载面板且渲染正确 | 真二进制、真窗口、真 `executeJavaScript` |
| `PANEL_STATE` 不会被忽略 | 断言仓库自己的 `workflow-state/pipeline.json` 前后不变 |

没有二进制时**跳过**，理由写清楚：`npm ci` 带 postinstall 才会有。

## 4. Windows 启动器

### 问题

`bin/` 下八个脚本全是 `#!/bin/sh`。Windows 执行不了，也没有替代品。

### 做法

每个配一个 `.cmd`，行为对齐 POSIX 版本：

```bat
@echo off
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%" >nul
if exist "%ROOT%\.env" call "%~dp0_load-env.cmd" "%ROOT%\.env"
if not defined WORKBUDDY_NODE_BIN set "WORKBUDDY_NODE_BIN=node"
"%WORKBUDDY_NODE_BIN%" "%ROOT%\dist\server.js" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
```

`.env` 加载单独抽成 `_load-env.cmd`，因为八个脚本都要用。它只认
`KEY=VALUE` 行，跳过注释（含缩进的）和空行，值原样保留——带空格、
值里再含 `=` 都没问题，实测过。

### 两个刻意的差异

**`deepseek-gateway.cmd` 不读 `.env`。** POSIX 版本也不读，保持一致。

**`workbuddy-cli.cmd` 没有默认路径。** POSIX 版本硬编码
`/Applications/WorkBuddy.app/...`，Windows 上没有可猜的位置。所以它
要求显式设置 `WORKBUDDY_CLI_ELECTRON` 和 `WORKBUDDY_CLI_SCRIPT`，
缺了就报错退出——**不猜**。

### 测试（6 项）

| 检查 | 说明 |
|---|---|
| 七个启动器都加载 `.env`、保持项目根、透传参数 | 参数是 `["a","b"]` |
| 只有 WorkBuddy 家族读 `.env` | `deepseek-gateway` 的 `backend` 必须是 `undefined` |
| `agent-hub` 记住调用者目录 | `AGENT_HUB_CALLER_CWD` 是用户站立的位置 |
| 退出码透传 | 子进程 `exit(7)`，启动器必须也 `exit 7` |
| `doctor` 构建前拒绝运行 | `dist/doctor.js` 缺失时 `exit 1` 且提示 `npm run build` |
| `workbuddy-cli` 缺路径时拒绝 | 提示 `WORKBUDDY_CLI_ELECTRON` |

### 测试基础设施的坑

`.cmd` 不是可执行文件，`CreateProcess` 起不了它，`execFile` 直接
`EINVAL`。必须走 `cmd.exe`，而且参数拼法有讲究：

```ts
const command = `""${filename}"${args.length ? " " + args.map((a) => `"${a}"`).join(" ") : ""}"`;
execute(comspec, ["/d", "/s", "/c", command], {
  windowsVerbatimArguments: true,   // 少了这个 Node 会把引号转义成 \"
});
```

`/s /c ""file" args"` 外层那对引号是给 cmd 剥的，`windowsVerbatimArguments`
是给 Node 的——不加，Node 会把 `"` 变成 `\"`，cmd 就找不到文件了。

## 5. `dist/` 停止被跟踪

`.gitignore` 里写着 `dist/`，但有 102 个文件被跟踪。历史原因：早期
提交时 `dist/` 还没被忽略，之后一直没清。

```powershell
git rm -r --cached dist
```

工作区的文件不动（`npm run build` 仍然产出它们），只是不再进版本库。
这消除了"编译产物被手改后提交"和"每次构建都产生 diff"两个隐患。

## 结果

```
398 用例，394 通过，4 跳过，0 失败
```

新增 8 项（Electron 2 项、Windows 启动器 6 项）。

## 这一轮证明了什么

1. Electron 壳子在 Windows 上真能起、真能画、真能取数据
2. Windows 用户有七个可用启动器，行为和 POSIX 对齐
3. 打包白名单包含 `.cmd`，Windows 安装包不是空壳
4. `dist/` 不再污染版本库

## 这一轮证明不了什么

1. `workbuddy-cli.cmd` 没在真实 WorkBuddy Windows 安装上跑过——
   我不知道那台机器上的 Electron 路径
2. Electron 的 GPU 报了两条 `command_buffer_proxy_impl` 错误。
   不影响加载，但没深究
3. 测试用 `cmd.exe` 起 `.cmd`，和用户双击运行的路径不完全相同
   （双击走 Explorer 的关联，会有不同的引号处理）
