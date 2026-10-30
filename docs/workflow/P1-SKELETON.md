# P1 骨架：统一协议与适配器登记

## 交付内容

| 文件 | 作用 |
|---|---|
| `src/workflow/contracts.ts` | 任务输入/输出协议、REQ/AC 标识、状态枚举、`claimIsSupported` 证据校验 |
| `src/workflow/states.ts` | 13 个阶段、合法流转边、门禁挂载点、BLOCKED 回退规则 |
| `src/workflow/adapters.ts` | `WorkflowAdapter` 接口、能力报告、证据包、按 id 注册表 |
| `test/workflow-contracts.test.ts` | 10 项契约测试 |

## 关键设计决定

1. **角色是能力槽位，不是厂商名。** `analyst / architect / developer / reviewer / tester / integrator` 六个槽位由配置绑定到具体适配器。换适配器不改协议。
2. **`succeeded` 是可机械校验的。** `claimIsSupported()` 要求：至少一条命令记录，且没有 `failed` 或 `unverified` 的测试。空口声称成功在这套协议里是非法返回值。
3. **阶段不能跳。** `LEGAL_TRANSITIONS` 是白名单，`assertTransition` 对非法边抛 `ProtocolError`。REVIEW/VERIFY 可退回 IMPLEMENT，其他阶段只能前进或 BLOCKED。
4. **BLOCKED 只回原阶段。** 必须带 `blockedFrom`，否则不允许退出。这样"卡住后偷偷跳到后面"在类型层面就不可能。
5. **门禁挂在边上，不挂在阶段上。** `SPEC->PLAN` 是 G0，`IMPLEMENT->REVIEW` 是 G2，等等。门禁不通过就没有这条边。

## 已知限制

- 门禁的**判定逻辑**还没实现，目前只有挂载点（哪条边对应哪个门禁）。
- 适配器只有接口和登记表，还没有具体实现。
- 证据落盘格式尚未定型。

## 验证

```
npm run build   exit=0
npx tsx --test test/workflow-contracts.test.ts   exit=0  pass 10 fail 0
```
