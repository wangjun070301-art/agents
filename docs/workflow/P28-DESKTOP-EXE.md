# P28：桌面版 exe

## 要什么

用户直接要“桌面版 exe”，不是“装好 Electron 再 `npm run app`”。

## 做法：不用打包工具

`electron-builder` / `electron-packager` 都要额外装依赖、下载 NSIS 之类。
Electron 本身支持一种更简单的形式：把项目放进 `resources/app/`，
改名的 `electron.exe` 就变成那个 app。

```
AgentOrchestrator\
  AgentOrchestrator.exe          ← 改名的 electron.exe
  chrome_100_percent.pak
  ...
  resources\
    app\                          ← 整个项目在这里
      package.json                ← main 指向 app/main.cjs
      app\main.cjs
      app\panel-host.cjs
      dist\ src\ bin\ tools\ docs\ skills\
      node_modules\               ← 只有生产依赖
```

Electron 启动时会读 `resources/app/package.json` 的 `main` 字段。

## 三个真问题

### 1. `package.json` 没有 `main` 字段

第一次跑：进程起来了，窗口不出来，stdout 空的。原因是
`package.json` 只有 `"type": "module"`，没有 `main`，Electron 退回加载
`default_app.asar`，那是个欢迎页，而且它在等一个不存在的入口。

修法：加 `"main": "app/main.cjs"`。

### 2. `__dirname` 在打包后不一样

```js
const repoRoot = path.resolve(__dirname, "..");
```

源码树里 `main.cjs` 在 `app/`，上一级是根。打包后整个项目在
`resources/app/`，`main.cjs` 仍在 `app/` 下——但 `..` 指到的是
`resources/`，那里没有 `dist/`。

**没有用打包标志位，而是探测：**

```js
const repoRoot = fs.existsSync(path.join(__dirname, "dist", "workflow", "server.js"))
  ? __dirname
  : path.resolve(__dirname, "..");
```

如果当前目录就有 `dist/workflow/server.js`，说明已经是根；否则上一级。
两种布局都成立，不依赖任何环境变量。

### 3. 生产依赖必须打进包

第一次没带 `node_modules`，报：

```
ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
```

桌面包不能要求用户 `npm ci`。所以：

```powershell
cd resources\app
npm install zod@^3.25.76 @modelcontextprotocol/sdk@^1.21.0 --omit=dev
```

只装两个生产依赖（95 个包，含传递依赖）。

## 验证

不是看文件在不在，是**从 zip 解压出来跑**：

```powershell
tar -xf AgentOrchestrator-v0.8.0-win64.zip -C $tmp
$tmp\AgentOrchestrator\AgentOrchestrator.exe
```

```
exit=0
[app] panel: http://127.0.0.1:57215/
[app] window: loaded
[app] render: {"title":"流水线控制台","hasStageMap":true,"hasNextStages":true,
               "stageRows":13,"gates":6,"stageHint":"当前阶段（代码：INTAKE）"}
[app] smoke: ok
```

`stageHint` 有内容 = 解压出来的这份真的请求到了它自己的 `/api/state`。

## 产物

```
AgentOrchestrator-v0.8.0-win64.zip   156.3 MB
sha256 03c69d7b5600e0413b7704f107881e4b5a013101afc31f5793006c2c47304ab8
```

未压缩 356.8 MB / 73 个 Electron 文件 + 276 个 app 文件。

大头是 `AgentOrchestrator.exe` 本身：249.8 MB。这是 Electron 的固定成本，
不是这个项目臃肿。

## 这一轮证明了什么

1. 双击 exe 就能开，不需要 Node、不需要 npm、不需要 Electron
2. 打包后的目录结构和源码树不同，`__dirname` 探测两种都对
3. zip 解压出来跑得通，不是只有原始目录能跑

## 这一轮证明不了什么

1. **没做代码签名。** Windows 首次运行会弹 SmartScreen
   “未知发布者”。要消掉得买证书。
2. **没做安装程序。** 这是绿色版，解压即用，没有开始菜单快捷方式、
   没有卸载项、没有自动更新。
3. **没有图标。** 用的是 Electron 默认图标。
4. **没在干净 Windows 上测过。** 这台机器有 VC++ 运行时和 WebView2；
   没有它们的机器可能缺 DLL。
5. **只打了 win-x64。** 没有 arm64、没有 macOS、没有 Linux。
6. **`app.asar` 没用。** 直接把 `resources/app/` 暴露成目录，
   用户能直接改源码。对自用方便，对分发不够严。
