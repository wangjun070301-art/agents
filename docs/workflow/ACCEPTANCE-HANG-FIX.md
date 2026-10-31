# 挂死修复任务：第一步与第二步验收

对象：`test/persistent-service.test.ts` 全量挂死问题（既有债务，非本仓库引入）。
验收方：本会话（总控 + 独立审查员）。修复方：另一个任务会话。

---

## 第一步验收：挂死是否真的消失

### 验收命令

```powershell
$env:PATH = 'D:\node;' + $env:PATH
Set-Location 'C:\Users\13420\Documents\ChatGPT\agents'
npx tsx --test --test-timeout=30000 test/persistent-service.test.ts
```

### 判定标准

| 项 | 通过条件 |
|---|---|
| 进程返回 | 命令在 **90 秒内**自然结束，不需要人工 Ctrl+C |
| 退出码 | 0 或非 0 都可以，但**必须返回**；`exit=124` / 超时 / 无输出不算通过 |
| 用例计数 | 输出里出现 `ℹ tests <N>`，`<N>` 与文件中 `test(` 调用数一致 |
| 挂死特征 | 不出现"卡在某个用例名之后不再前进"的现象 |

### 本次实测（当前状态）

```
ℹ tests 21
ℹ pass 19
ℹ fail 2
ℹ duration_ms 2144.5722
```

**结论：挂死已消失。** 修复前 300 秒不返回；修复后 2.1 秒返回。
这一步**已通过**。

### 全量套件实测（第 6 项关键检查）

```
npx tsx --test --test-timeout=60000 test/**/*.test.ts

ℹ tests 223
ℹ pass 205
ℹ fail 18
ℹ duration_ms 3121.2423
```

**修复前**：该命令 300 秒不返回，无法得到任何汇总数字。
**修复后**：3.1 秒返回，223 个用例全部执行完毕。

这证明挂死不是"单个文件的问题"，而是被真正解决了——全量套件现在
可以作为一个可用的门禁，而不是一个永远拿不到结果的死命令。

### 需要修复方提供的证据

1. 修复前后同一命令的耗时对照（修复前必须显示"超时/未返回"）。
2. 挂死的**根因说明**：是哪个句柄、哪个 Promise、哪个定时器没释放。
   只写"加了 timeout 就好了"不算——那只是掩盖，不是修复。
3. `git diff` 中与挂死相关的最小改动范围。

---

## 第二步验收：剩余失败是否被正确处理

### 当前剩余的 2 个失败

| 位置 | 断言 | 实测 | 期望 |
|---|---|---|---|
| `test/persistent-service.test.ts:184` | `fs.statSync(...).mode & 0o777` | `438` | `384` |
| `test/persistent-service.test.ts:371` | 同上 | `438` | `384` |

`384` 是八进制 `0o600`，`438` 是八进制 `0o666`。

### 根因判断

这是 **Windows NTFS 不实现 POSIX 权限位** 导致的平台差异，不是代码缺陷：

- `fs.chmodSync(file, 0o600)` 在 Windows 上不改变 ACL，只改只读标志位。
- `fs.statSync().mode` 在 Windows 上返回的权限位不反映 chmod 的结果。
- 同一仓库的 `package.test.ts`、`launcher.test.ts` 也有同类平台断言失败，
  属既有问题（见 `docs/workflow/BASELINE.md`）。

### 验收标准（三种处置，任选其一，但必须显式选）

**方案 A：平台条件跳过（推荐）**

```ts
const posixMode = process.platform === "win32" ? null : (fs.statSync(f).mode & 0o777);
if (posixMode !== null) assert.equal(posixMode, 0o600);
```

通过条件：Windows 上跳过、Linux/macOS 上仍严格断言；测试输出里能看到
`skip` 计数增加，且**不是删掉断言**。

**方案 B：改为跨平台可验证的等价断言**

把"文件权限是 0600"改为"文件不是全局可读"这类在 Windows 上也能验证的属性。
通过条件：断言在 Windows 上真实生效并能失败（需要造一个反例证明它不是永真）。

**方案 C：显式标记为平台限制并记录**

```ts
test("... (posix permissions)", { skip: process.platform === "win32" && "NTFS has no POSIX mode bits" }, ...)
```

通过条件：`skip` 理由字符串非空；`docs/workflow/BASELINE.md` 里登记该限制。

### 禁止的处置

| 做法 | 为什么禁止 |
|---|---|
| 删除这两个测试 | 掩盖问题，违反"不得删除测试制造通过" |
| 把 `0o600` 改成 `0o666` | 降低断言强度，等于承认权限设置无效 |
| 只加 `try/catch` 吞掉断言失败 | 失败不可见，比删除更糟 |
| 改 `--test-timeout` 让它"跑完" | 挂死是挂死，超时只是提前放弃 |

### 验收命令（第二步）

```powershell
npx tsx --test --test-timeout=30000 test/persistent-service.test.ts
```

通过条件：

```
ℹ tests 21
ℹ pass 21   （或 pass 19 + skipped 2，且跳过理由可见）
ℹ fail 0
```

---

## 交给修复方的完整验收清单

| # | 检查项 | 命令 | 通过条件 |
|---|---|---|---|
| 1 | 不再挂死 | 见第一步 | 90 秒内返回 |
| 2 | 用例数未减少 | 同上 | `tests 21` |
| 3 | 无新增失败 | 同上 | `fail` 数不高于修复前 |
| 4 | 根因说明 | 文字 | 指明具体未释放的资源 |
| 5 | 最小改动 | `git diff --stat` | 不碰无关文件 |
| 6 | 全量套件可跑 | `npm test` | 不再永久挂起 |
| 7 | 平台断言处置 | 见第二步 | 显式选择 A/B/C 之一 |

第 6 项是**关键**：单个文件不挂不等于全量不挂。必须证明 `npm test`
（跑 `test/**/*.test.ts`）能返回。

**当前状态：第 6 项已通过**（3.1 秒，223 用例）。剩余 18 个失败中，
与本仓库改动无关的既有平台问题占多数，详见下一节。

---

## 附：全量套件的 18 个失败分类

修复挂死后暴露出来的失败，按性质分三类：

| 类别 | 数量 | 文件 | 性质 |
|---|---|---|---|
| POSIX 权限位断言 | 4 | `persistent-service.test.ts` ×2、`package.test.ts` ×3 中的部分 | Windows NTFS 不实现 `0o600` |
| Unix domain socket | 4 | `deepseek-client.test.ts` ×4 | Windows 的 socket 路径语义不同 |
| macOS launchd | 1 | `launcher.test.ts` | 该启动器是 macOS LaunchAgent |
| 临时目录 EPERM | 2 | `workspace-workers.test.ts` ×2 | Windows 上清理被占用目录 |
| 其他既有失败 | 7 | `coordinator`、`deepseek-server`、`desktop-queue`、`run-journal` ×2、`task-store` | 需逐项定位，不在本轮范围 |

**重要**：这 18 个失败在 `docs/workflow/BASELINE.md` 记录的基线里**已经存在**
（当时是逐文件对照，同样是这些文件失败）。挂死修复只是让它们变得可见，
没有制造新的失败。

修复方的验收**不要求**把这 18 个全部修好——那是另一个任务。
验收只要求：**没有新增失败**（即 `fail` 数不高于修复前），
且挂死消失。

---

## 本会话能提供的东西

1. **基线对照数据**：`docs/workflow/BASELINE.md` 里有逐文件通过/失败数字，
   修复方可以直接对照，证明"修复前就是这样"。
2. **独立验证**：修复完成后，我用 `tools/claude-reviewer.ps1` 让
   独立审查进程读 diff，确认没有靠删测试或改断言制造通过。
3. **跨平台证据**：如果修复方声称是平台问题，我可以核对同类断言在其他
   文件里的表现，确认口径一致。

## 本会话不能提供的东西

1. 我**不能**在 Windows 上验证 POSIX 权限断言"本应通过"——这台机器就是
   Windows，没有 Linux/macOS 环境做对照。所以方案 A 的"Linux 上仍严格"
   这一条只能由修复方在 CI 或另一台机器上证明。
2. 我**不能**替修复方改那个文件——那是他们的任务范围，我只做验收。
