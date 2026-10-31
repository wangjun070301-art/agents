# P22：把 macOS 的测试基线清成 Windows 基线

## 起点

`npm test` 长期是 18 项红。P14 的文档把它写成"基线"，后面的每一轮
都绕开它。绕开的代价是：真正的移植缺陷混在里面，没人分得清哪条是
环境噪音、哪条是代码错了。

这一轮把 18 项逐条拆开，按根因分类，然后**只修真的**。

## 分类结果

| 根因 | 项数 | 性质 |
|---|---|---|
| 缺 `zip` / `unzip` 二进制 | 3 | 真缺陷，交付物受影响 |
| POSIX 权限位 `mode & 0o777` | 5 | 测试断言写死了 POSIX |
| Unix domain socket | 3 | 平台能力缺失 |
| macOS 专属（`ps`、`launchd`、`#!/bin/sh`） | 3 | 平台能力缺失 |
| 测试未关句柄就删目录 | 2 | 真测试卫生问题 |
| 依赖上述前置条件 | 2 | 连带 |

## 修了什么

### 1. 打包脚本（真缺陷）

`scripts/package.mjs` 硬编码 `zip -q -r -X`。Windows 没有 `zip`，
但自带 `tar.exe`（bsdtar），`tar -a` 能写出合法 zip。

```js
export async function createArchive(stageDir, archivePath, rootName) {
  if (await hasZip()) {
    await execute("zip", ["-q", "-r", "-X", archivePath, rootName], { cwd: stageDir });
    return;
  }
  await execute("tar", ["-a", "-c", "-f", archivePath, "-C", stageDir, rootName]);
}
```

`listArchive` 同理：有 `unzip` 就用 `unzip -Z1`，否则 `tar -tf`。
bsdtar 在 Windows 上输出 CRLF 并列出目录项，而 `unzip -Z1` 两者都不做，
所以那一支要归一化：

```js
return stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !l.endsWith("/"));
```

**这是这一轮唯一影响真实交付物的修复。** 之前 `npm run package` 在
Windows 上直接失败，打包不出来。

### 2. 注册表信任检查（真缺陷）

`src/deepseek-client.ts` 用 POSIX 权限位判断注册文件是否可信：

```ts
if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) continue;
```

Windows 上 `mode` 恒为 `0o666`（`0o077` 位全开），`stat.uid` 恒为 `0`，
`process.getuid` 不存在所以 `?.()` 返回 `undefined`。两个条件同时为真，
**每一个主机都被拒绝**。表现是 `hosts()` 永远返回空数组。

修法是平台分支：

```ts
if (!stat.isFile()) continue;
if (process.platform !== "win32") {
  if ((stat.mode & 0o077) !== 0) continue;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) continue;
}
```

Windows 侧靠目录 ACL（注册表在用户 profile 下，继承用户保护）。

### 3. 进程链探测（真缺陷）

`assertDesktopCaller` 用 `ps -p PID -o ppid=` 逐级上溯父进程。
Windows 没有 `ps`，`execFileSync` 抛 `ENOENT`，异常直接穿透到调用方。

修法是把探测抽出来，失败返回 `undefined`，循环按"走不下去"退出：

```ts
function probeProcess(pid) {
  try { /* ps 两次调用 */ } catch { return undefined; }
}
```

结果是同一个拒绝消息，而不是一个 `spawnSync ps ENOENT` 泄漏给用户。
**没有伪造通过**——这是关键。这个守卫存在的意义就是阻止 Codex 侧
调用上报 WorkBuddy 结果；在探不了的平台上假装通过，等于把守卫拆了。

### 4. 测试卫生（2 项）

`node:test` 的 `t.after` **按注册顺序执行，不是逆序**。fixture 先注册
`rmSync`，测试体后注册 `store.close()`，于是删目录时 SQLite 句柄还开着。
Windows 不允许删有打开句柄的目录，POSIX 允许，所以这个 bug 只在
Windows 暴露。

修法：在测试体末尾显式 `close()`，不依赖钩子顺序。

### 5. 平台条件跳过（4 项）

这四项不是缺陷，是 Windows 没有对应概念：

| 测试 | 为什么跳过 |
|---|---|
| Unix socket RPC（2 项） | `server.listen(path)` 在 Windows 返回 `EACCES` |
| 注册表选择（1 项） | 依赖"公开文件"这个概念，Windows 无 mode |
| `bin/*` 启动器（1 项） | 全是 `#!/bin/sh`，Windows 无 POSIX shell |

跳过时写清理由，不写 `skip: true` 了事。被跳过的行为部分仍尽量保留：
权限断言条件化，但持久化、一次性应答等行为照常验证。

## 结果

```
383 用例，379 通过，4 跳过，0 失败
```

## 这一轮证明了什么

1. 18 项"基线"里有两项是真产品缺陷（打包、注册表），不是环境噪音
2. 一项只在 Windows 暴露的测试卫生 bug（钩子顺序）
3. 剩下的平台差异有明确边界，且跳过是显式的、有理由的

## 这一轮证明不了什么

1. 被跳过的 4 项在 macOS 上仍然正确——我没有 macOS 环境复跑
2. `bin/*` 启动器在 Windows 上没有替代品。Windows 用户只能走
   `node tools/panel.mjs` 或 `npm run app`，这些没有自动化覆盖
3. `launchd` 安装器本身仍是 macOS-only，Windows 没有对应实现

