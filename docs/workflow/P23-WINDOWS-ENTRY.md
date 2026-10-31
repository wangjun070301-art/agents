# P23：Windows 的两个真入口有覆盖了

## 补的是哪一条

P22 结尾写明："`bin/*` 启动器在 Windows 上没有替代品，Windows 用户只能走
`node tools/panel.mjs` 或 `npm run app`，这些没有自动化覆盖。"

这一轮补的就是这句话点名的两条路。

## 写测试时撞到的两个真 bug

### 1. 面板返回的是配置端口，不是绑定端口

```ts
server.listen(port, host, () => resolve(port));   // ← 返回请求值
```

`app/main.cjs` 用 `port: 0` 让系统分配端口，避免两个实例抢 18493。
于是 `start()` 返回 `0`，窗口加载 `http://127.0.0.1:0/`。

实测确认：

```
reported=0 actual=50930
```

**桌面壳从来没打开过页面。** 这个 bug 从 `ee3e463`（Cyber-HUD 重设计）
起就在，因为 `main.cjs` 没有测试、`start()` 也没有测试去问"返回的端口
能用吗"。

修法是返回实际地址：

```ts
server.listen(port, host, () => {
  const address = server.address();
  resolve(typeof address === "object" && address ? address.port : port);
});
```

`tools/panel.mjs` 也踩了同一个坑：它打印参数端口。改成打印返回值。

### 2. `import()` 需要 URL，不是路径

`app/main.cjs` 原来这样加载 ESM 服务端：

```js
import(path.join(repoRoot, "dist", "workflow", "server.js"))
```

在 POSIX 上 `path.join` 给的是 `/Users/.../server.js`，Node 容忍这种
无协议字符串。在 Windows 上给的是 `C:\...\server.js`，Node 把它读成
协议 `c:`：

```
ERR_UNSUPPORTED_ESM_URL_SCHEME
```

**桌面壳在 Windows 上也起不来。** 修法：

```js
const { pathToFileURL } = require("node:url");
const moduleUrl = pathToFileURL(path.join(repoRoot, "dist", "workflow", "server.js")).href;
const { createPanel } = await import(moduleUrl);
```

## 结构改动

`main.cjs` 需要 Electron 才能跑，测试环境没有（`node_modules/electron/dist`
不存在，只有安装器）。把可测的部分抽出来：

```
app/
  main.cjs         窗口 + 生命周期，只剩这些
  panel-host.cjs   resolveStateDir / startPanel，纯逻辑
```

`main.cjs` 因此缩到 40 行，只负责：等 Electron ready → 起面板 → 开窗口 →
关窗口时停服务。

## 测试（新增 7 项）

| 检查 | 怎么测 |
|---|---|
| `PANEL_STATE` 覆盖默认状态目录 | 纯函数，三种输入 |
| 空 `PANEL_STATE` 不算目录 | 纯函数 |
| `startPanel` 返回真实端口 | 起真服务，`port > 0`，且 `fetch(url)` 返回 200 |
| 返回的 URL 真的能访问 | 同上，断言 HTML |
| 状态目录会被创建 | 传一个不存在的嵌套路径，起完服务后断言存在 |
| `tools/panel.mjs` 端到端可用 | 真子进程，解析它打印的 URL，抓页面和 `/api/state` |
| `--state` 真的生效 | 推一个无门禁的边，断言 `pipeline.json` 落在指定目录 |

另外两项是静态检查（`main.cjs` 语法合法、加载的是 `started.url` 而不是
字面量端口），因为 Electron 跑不起来。这两项能防住回归，但防不住
"Electron 本身坏了"。

## 结果

```
test/panel-entry.test.ts   7/7
全量                        390 用例，386 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. Windows 上 `node tools/panel.mjs` 能起服务、能访问、`--state` 生效
2. `startPanel` 返回的端口是真的，URL 能打开
3. 两个只在 Windows 暴露的启动 bug 被修掉（端口、ESM 路径）

## 这一轮证明不了什么

1. **Electron 窗口本身没有验证。** 没有二进制，`npm run app` 没跑过。
   静态检查只能保证 `main.cjs` 语法正确、调用的是正确的 URL。
2. `PANEL_STATE` 指向不可写目录时的行为没测
3. 两个实例同时启动时端口冲突的处理没测——`port: 0` 理论上不会冲突，
   但没验证

