# 挂死修复：验收结论

验收对象：`9752b1b fix: degrade fsync on Windows so the pump no longer fails before wake`
验收人：本会话总控 + 独立 Claude Code 审查进程
验收日期：2026-10-31

## 总判定

**第一步通过，第二步有条件通过，新增 1 项必须修复的风险。**

| 项 | 结果 |
|---|---|
| 挂死消失 | **通过** |
| 根因说明 | **通过** |
| 最小改动 | **通过** |
| 无新增失败 | **通过** |
| 未删测试 | **通过** |
| 平台断言处置 | **未通过**（未处理，仍原样断言） |
| 新引入的可靠性缺口 | **发现 1 项**（见第四节） |

自动化验收脚本：`tools/accept-hang-fix.mjs`，当前 `8/9`。

## 一、第一步：挂死是否真的消失

```
npx tsx --test --test-timeout=60000 test/persistent-service.test.ts
  →  returned=true  elapsed=2674ms  tests=21  pass=19  fail=2

npx tsx --test --test-timeout=60000 test/**/*.test.ts
  →  returned=true  elapsed=3519ms  tests=223  pass=205  fail=18
```

| 检查 | 修复前 | 修复后 | 判定 |
|---|---|---|---|
| 单文件返回 | >300s 不返回 | 2.7s | 通过 |
| 全量返回 | >300s 不返回 | 3.5s | 通过 |
| 用例数 | 21 | 21 | 通过 |
| 全量失败数 | 18（基线） | 18 | 通过，无新增 |

## 二、第二步：剩余失败的处理

**未通过。** `test/persistent-service.test.ts` 第 184、371、372 行仍然是：

```ts
assert.equal(fs.statSync(...).mode & 0o777, 0o600);
```

没有任何平台判断或跳过标记。在 Windows 上 `chmod` 不改变 ACL，
`statSync().mode` 返回 `0o666`，所以这两条断言必然失败。

修复方的提交说明里**正确识别**了这一点（"The 18 failures are pre-existing
platform assertions (chmod is a no-op on Windows...)"），但**没有处置**，
只是把它们留在失败状态。

这不算违规——它没有删测试、没有改断言强度。但按
`ACCEPTANCE-HANG-FIX.md` 第二步的要求，必须**显式选择**处置方式。
当前状态是"识别了但没选"。

### 建议处置（方案 A）

```ts
// NTFS does not implement POSIX mode bits; chmod is a no-op there.
if (process.platform !== "win32") {
  assert.equal(fs.statSync(path.join(journal.dir, "wake.json")).mode & 0o777, 0o600);
}
```

三处（184、371、372）同样处理。这样 Windows 上跳过、Linux/macOS 上保持严格。

## 三、根因与最小改动

**通过。**

根因：`fs.openSync(file, "r")` + `fs.fsyncSync(fd)` 在 Windows 抛 EPERM；
目录 fsync 在 Windows 也不可用。`writeWakeIntent` 在每次原生提交前执行，
抛出被 `pump()` 的 catch 吞掉并转成 `"unavailable"`，于是 wake 从未发生，
而等待 submit hook 的测试永久挂起。

**这个诊断经本会话独立复现，数据如下：**

```
open r:               OK
open r+:              OK
fsync on r:           EPERM  ← 原代码就是这一步炸的
fsync on r+:          OK     ← 修复后走的路
open dir r:           OK
fsync on dir:         EPERM  ← 目录 fsync 确实不可用
rename temp->target:  OK     （在 repo / TEMP / home 三个位置均 OK）
```

改动范围：仅 `src/persistent-service.ts` 一个文件，+13/−4。
`test/` 完全未触碰（`git diff --numstat 9752b1b~1 9752b1b -- test/` 为空）。

## 四、新引入的风险（必须处理）

独立审查进程 + 本会话实测共同确认，`syncDurably` 引入一个可靠性缺口。

### 风险 R1：Windows 上目录 fsync 被跳过，rename 的持久性没有保证

`writePrivateJson` 的实现是 **写临时文件 + rename**：

```ts
fs.writeFileSync(temp, ...);
fs.renameSync(temp, file);   // run-journal.ts:55
```

POSIX 上，rename 之后必须 fsync 父目录，才能保证"重命名这件事"落盘。
Windows 上这一步被跳过，而 `FlushFileBuffers`（即文件 fsync）**不会**
刷新父目录的索引项。

后果：断电或强制重启后，`wake.json` 可能不存在，下一次 pump 会**重复提交**
一次原生唤醒。而这个文件存在的全部意义就是防止重复提交。

代码注释写了 "the durability barrier degrades there"，但**没有说明降级的具体后果**。
测试也无法发现它（只断言文件内容，不测断电）。

**建议**：至少在代码注释里写明"Windows 上 rename 的目录项不保证持久，
断电后可能重复唤醒"，并在 `docs/workflow/` 里登记这个平台限制。
更好的做法是 Windows 上改用 `MOVEFILE_WRITE_THROUGH` 语义（Node 无直接 API，
需要 `fs.renameSync` 后对目标文件 `fsync` 并接受残余风险）。

### 风险 R2：`r+` 扩大了 Windows 上的失败面

实测确认：文件带只读属性时，

```
r:  OK
r+: EPERM
```

原代码用 `"r"`，只读文件也能打开；新代码用 `"r+"`，只读文件直接抛 EPERM。
也就是说，这个为 Windows 修 bug 的改动，**在 Windows 上引入了一类新的抛出路径**，
而 `pump()` 仍然把它吞成 `"unavailable"`，症状和原来的挂死完全一样。

**建议**：`syncDurably` 里对 `r+` 的失败做一次降级尝试（退回 `"r"` 并跳过 fsync），
或者捕获 EPERM 后记录为"降级持久性"而不是让整个 pump 失败。

### 风险 R3：平台判断写死为 `win32`，非 Windows 的网络文件系统仍会硬失败

`process.platform === "win32"` 是编译期常量判断，不是按实际错误判断。
在 Linux 上挂载的 NFS/FUSE 目录同样不支持目录 fsync，会抛错，
而代码不会走降级分支。

**建议**：改为"尝试 → 捕获 EPERM/EINVAL → 降级"，而不是按平台名分支。

### 风险 R4：`pump()` 把所有内部失败折叠成 `"unavailable"`

这是**既有问题**，不是本次引入，但本次让它更明显：ENOSPC、EACCES、
rename 冲突、只读介质，全部变成同一个 `"unavailable"`，
下一次持久性失败又会表现为"测试挂死"，难以定位。

**建议**：不在本次修复范围内，但应登记为技术债。

## 五、给修复方的回复

可以合并的部分：挂死修复本身是对的，根因诊断准确，改动范围干净。

需要继续处理的部分（按优先级）：

1. **R1**：在代码注释和文档里写明 Windows 上 rename 持久性缺口及其后果。
2. **R2**：`r+` 失败时降级，不要让只读文件把整个 pump 打回 `"unavailable"`。
3. **第二步**：三处 `mode & 0o777` 断言加平台判断（方案 A）。
4. **R3**：平台判断改为按错误类型而非平台名（可与 R2 合并）。
5. **R4**：登记为技术债，不在本轮修。

## 六、验收脚本用法

```powershell
node tools/accept-hang-fix.mjs
node tools/accept-hang-fix.mjs --json   # 机器可读
```

九项检查：挂死消失、用例数、无新增失败、根因说明、最小改动、
全量套件、全量失败数、平台断言处置、未删测试。

脚本退出码 = 全部通过 ? 0 : 1。

## 七、本次验收的局限

1. 我**无法**验证 Windows 上 `ERROR_ACCESS_DENIED` 到 `EPERM` 的映射是否
   在所有文件系统上都成立——只在本机 NTFS 上实测。
2. 我**无法**验证"跳过目录 fsync 会导致断电后丢失 rename"——这需要
   断电实验或文件系统级模拟，本机做不到。该结论来自 POSIX 语义推理
   加上对 `renameSync` 实现方式的确认，属**高置信度推理**而非实测。
3. 我**无法**在 Linux/macOS 上验证 POSIX 路径"逐字节不变"——
   审查进程给出的判断是源码阅读结论，未经运行验证。
4. 审查进程使用同一网关、同一模型家族（DeepSeek），独立性来自
   不同进程 + 只读工具集 + 非作者，不来自模型多样性。
