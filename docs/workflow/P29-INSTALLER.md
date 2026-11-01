# P29：Windows 安装包

## 约束

用户要“安装包”，不是绿色版 zip。

本机没有 NSIS、Inno Setup、WiX。GitHub 和 npmmirror 都拿不到 NSIS
（`fetch failed` / 404）。能用的只有三样：

| 工具 | 状态 |
|---|---|
| IExpress | 系统自带，能解压后执行脚本 |
| 7-Zip | 已装，`7z.sfx` 只能解压，不执行 `RunProgram` |
| `7zSD.sfx` | 未装（那个版本才支持配置块） |

选了 IExpress，载荷用 7z 打包，安装包内自带 `7z.exe` 解压。

## 结构

```
AgentOrchestrator-Setup.exe        110.8 MB
  ├─ app.7z                       109.7 MB   扁平化的应用目录
  ├─ 7z.exe / 7z.dll                          解压器
  ├─ install.cmd                              安装脚本
  ├─ uninstall.cmd                            卸载脚本
  └─ 7-ZIP-LICENSE.txt                        许可证
```

运行时：IExpress 把这几个文件解到临时目录，执行 `install.cmd`。

## install.cmd 做什么

1. 检查是否有实例在跑，有就 `taskkill`
2. 解 `app.7z` 到 `%LOCALAPPDATA%\AgentOrchestrator`
3. 建 `workflow-state\`
4. 用 `WScript.Shell` COM 对象写桌面和开始菜单快捷方式
5. 复制 `uninstall.cmd`、`7z.exe`、`7z.dll` 到安装目录
6. 写 `HKCU\...\Uninstall\AgentOrchestrator` 注册表（控制面板能看到）
7. 问要不要现在启动

## 三个 bug，全在实测中发现

### 1. 7z 归档带了一层根目录

第一次打包用 `7z a app.7z AgentOrchestrator`，归档里多了一层：

```
AgentOrchestrator\
  AgentOrchestrator.exe
```

解压后 exe 在 `%LOCALAPPDATA%\AgentOrchestrator\AgentOrchestrator\`，
快捷方式指向的位置是空的。

修法两层：重新打包时在源目录里用 `.` 作参数，让归档扁平；安装脚本
再加一个展平兜底（`xcopy /E /I` 而不是 `move`，因为 `move` 遇到
已存在的目录会失败）。

**这里第一次用了 `move`，结果 `resources` 和 `locales` 没过去**——
TARGET 里已经有 `workflow-state` 和安装器自己的文件，`move` 撞上同名
目录就放弃。换成 `xcopy /E /I /Y` 才合并成功。

### 2. 卸载脚本删掉了自己

原版直接 `del uninstall.cmd`，然后继续执行后面的清理——但脚本已经没了，
cmd 报 “The batch file cannot be found.”，剩下的步骤全部跳过。

修法：从安装目录启动时先复制一份到 `%TEMP%` 再运行那份：

```bat
if /I "%~f0" neq "%TEMP%\agent-orchestrator-uninstall.cmd" (
  copy /y "%~f0" "%TEMP%\agent-orchestrator-uninstall.cmd" >nul
  cmd /c ""%TEMP%\agent-orchestrator-uninstall.cmd" /from:%TARGET%"
  exit /b 0
)
```

第一次写的时候把这个判断挂在 `if exist AgentOrchestrator.exe` 上，
结果一个布局不对的安装（exe 在子目录）跳过了重启动，又删了自己。
判断只该看脚本路径。

### 3. `start /wait` 会留下第二个控制台

改成 `cmd /c` 同步执行，输出留在同一个窗口。

## 验证

不是看文件在不在，是**清空后重装再启动**：

```powershell
# 卸载旧的
uninstall.cmd
# 安装新的
AgentOrchestrator-Setup-v0.8.0.exe
# 启动
AgentOrchestrator.exe
```

```
exe=True  resources=True  appmain=True  locales=True  lnk=True

exit=0
[app] panel: http://127.0.0.1:58340/
[app] window: loaded
[app] render: {"title":"流水线控制台","hasStageMap":true,"hasNextStages":true,
               "stageRows":13,"gates":6,"stageHint":"当前阶段（代码：INTAKE）"}
[app] smoke: ok
```

卸载验证：目录删除、桌面快捷方式删除、注册表项删除、`workflow-state`
按选择保留。

## 构建耗时

IExpress 用 `makecab` 压缩，110 MB 载荷大约要 **8 分钟**。
`7z a -mx=5` 打载荷只要 27 秒。所以载荷压缩交给 7z，IExpress 只负责
封装——这也是为什么安装包里塞了 `7z.exe`。

## 产物

```
AgentOrchestrator-Setup-v0.8.0.exe   110.8 MB
sha256 aa324a71382b1abb8efd4b8e76cc2454d1aa108e465a6c7d4acd3766eb1dfcf0
```

比绿色版 zip（156 MB）小 45 MB，因为 7z 的压缩率比 zip 好。

## 这一轮证明了什么

1. 双击安装包 → 装到 `%LOCALAPPDATA%` → 桌面和开始菜单有快捷方式
2. 控制面板「添加/删除程序」能看到，能调起卸载
3. 卸载干净：文件、快捷方式、注册表；用户数据按选择保留
4. 装完能启动，渲染 13 阶段 6 门禁，数据从自己的 `/api/state` 来

## 这一轮证明不了什么

1. **没有代码签名。** 双击会弹 SmartScreen「未知发布者」，
   安装包和 exe 都未签名。
2. **不是 MSI。** 系统管理员没法用组策略分发，也没有静默安装参数
   （IExpress 本身不支持 `/S`）。
3. **没在干净 Windows 上测。** 这台机器有 VC++ 运行时和 WebView2。
4. **没测非管理员账户。** 安装只写 HKCU 和 LOCALAPPDATA，理论上不需要
   提权，但没在受限账户上验证。
5. **没有图标。** 快捷方式和 exe 都是 Electron 默认图标。
6. **卸载不删 `%TEMP%\agent-orchestrator-uninstall.cmd`**，留着无害。
7. **构建脚本依赖本机 7-Zip 路径。** `packaging/build-setup.ps1` 里
   `7z.exe` 是从 `C:\Program Files\7-Zip` 复制的，换机器要改。
