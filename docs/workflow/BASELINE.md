# 基线报告（environment_report）

记录日期：2026-10-31
仓库：`junwang0301/-agents-`
被测提交：`upstream/main` = `fbaaa2e`（上游 codex-workbuddy-gateway v0.7.0）

## 结论

上游实现**在这台机器上自带失败项，且 `persistent-service.test.ts` 会挂死**。
本仓库新增的 `test/workflow-contracts.test.ts`（10 项）全部通过。
除新增文件外，其余各组的通过/失败数字与未改动的上游原版**逐项一致**。

因此：本次改动**没有引入任何新失败**，也没有修好任何既有失败。

## 逐文件对照（同一命令、同一 Node、同一工作目录形态）

| 测试文件 | 上游原版 | 本仓库 | 判定 |
|---|---|---|---|
| acp-live.test.ts | 17 pass | 17 pass | 一致 |
| brief-result.test.ts | 6 pass | 6 pass | 一致 |
| coordinator.test.ts | 8 pass / 1 fail | 8 pass / 1 fail | 既有失败 |
| deepseek-client.test.ts | 0 pass / 4 fail | 0 pass / 4 fail | 既有失败 |
| deepseek-coordinator.test.ts | 21 pass | 21 pass | 一致 |
| deepseek-server.test.ts | 1 pass / 1 fail | 1 pass / 1 fail | 既有失败 |
| desktop-queue.test.ts | 7 pass / 1 fail | 7 pass / 1 fail | 既有失败 |
| launcher.test.ts | 0 pass / 1 fail | 0 pass / 1 fail | 既有失败 |
| native-desktop-trigger.test.ts | 24 pass | 24 pass | 一致 |
| package.test.ts | 5 pass / 3 fail | 5 pass / 3 fail | 既有失败 |
| persistent-service.test.ts | **HANG > 60s** | **HANG > 60s** | 既有挂死 |
| platform.test.ts | 14 pass | 14 pass | 一致 |
| run-journal.test.ts | 5 pass / 2 fail | 5 pass / 2 fail | 既有失败 |
| run-worker.test.ts | 5 pass | 5 pass | 一致 |
| task-store.test.ts | 6 pass / 1 fail | 6 pass / 1 fail | 既有失败 |
| workbuddy-client.test.ts | 2 pass | 2 pass | 一致 |
| workspace-workers.test.ts | 8 pass / 2 fail | 8 pass / 2 fail | 既有失败 |
| workflow-contracts.test.ts | 不存在 | **10 pass** | 本次新增 |

## 已知既有问题（不归因于本次改动）

1. **`persistent-service.test.ts` 挂死**。`npm test` 整体因此永不返回，全量套件在这台机器上不可用。已用 300 秒上限的基线对照确认上游原版同样挂死。
2. **`deepseek-client.test.ts` 4 项全败**。该组在 `socketPath` 上监听，Windows 下 Unix domain socket 路径语义与 macOS 不同。
3. **`launcher.test.ts` 全败**。启动器脚本按 macOS `LaunchAgent` 写，Windows 无对应机制。
4. **`package.test.ts` 3 项失败**。打包白名单断言依赖 macOS 目录布局。
5. 其余零星失败未逐项定位，因为在本轮范围内它们与本仓库新增代码无因果关系。

## 命令与退出码

```
npm ci                     exit=0   added 100 packages
npm run build              exit=0   tsc -p tsconfig.json
npx tsx --test test/workflow-contracts.test.ts   exit=0   pass 10 fail 0
npm test                   exit=HANG（>300s 未返回，见上）
```

## 对后续阶段的影响

- 全量 `npm test` 不能作为门禁证据，因为它不会返回。
- G2/G4 门禁必须改为**按文件运行**并显式声明"本次改动相关的测试集合"，而不是跑全量。
- `persistent-service.test.ts` 的挂死需要单独修复或排除，属于既有债务，不在本轮范围。
