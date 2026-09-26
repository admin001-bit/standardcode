# ADR-0052: subagent deny 规则覆盖缺省类型（生效类型判定；M8-1 板 WP-03 交付物）

- 状态：已接受（2026-09-26，X 会话按卡内定并登记；§2 行 116 M8 范围"harness deny 缺省类型（规格变更，mini-ADR）"）
- 前序锚：M7 遗留 #21（`docs/milestones/M7.md` 行 111：harness deny 段仅查显式 subagentType，缺省类型×deny 在 `/fork` 与 `/subtask` 两通道同不设防；M3 既有语义、非本板引入）；M6-1-results §WP-10 D-1（行 273／行 284：D-1 裁定＝"记入偏差台账，供后续里程碑裁处"）；v2.8 §12.6（未覆盖级先 mini-ADR，B-06）；§5.2 行 216〔旧号，现行 217，按根 README §9「+1」解析〕（permission-broker 权限仲裁职责）；§2 行 111（M3：ORC-022 校验序列）；本卡新增接缝㉕（deny × 缺省类型 × /fork·/subtask 两通道；`docs/dev/seams.md` 登记随 WP-10 收口）

## 背景

- 现状（`packages/harness/src/subagent.ts` 校验段③）：`input.subagentType !== undefined && denied.has(input.subagentType.toLowerCase())` —— **仅显式类型过 deny**；类型省略时（段⑥解析为 `general-purpose`）不查 deny。
- 两通道同暴露：`/subtask`（`apps/cli/src/repl.ts:431`）与 `/fork`（`apps/cli/src/repl.ts:740`）都只在类型显式时传 `subagentType`；缺省时下游按 `general-purpose` 派发（`apps/cli/src/session.ts:401` 注册表取 `subagentType ?? "general-purpose"`）。
- 用户在 settings 写 `permissions.deny: ["Agent(general-purpose)"]` 的意图＝禁止该类型被派发；该规则对"缺省类型派发"静默失效 ⇒ deny 规则 fail-open 缺口（安全面）。
- 规格空白：v2.8／ORC-022 只写"Agent(X) deny 规则拒绝"，未言明 X 取"显式字面量"还是"生效类型"。本 ADR 定规格为**生效类型**。

## 决策

1. **判定取生效类型**：段③ deny 判定改用 `input.subagentType ?? "general-purpose"`（与段⑥缺省解析同源；抽模块级常量 `DEFAULT_SUBAGENT_TYPE` 消双份字面量）。显式类型的既有判定语义**零改**（含大小写不敏感）。
2. **判定位置不变**（段③，trace 步骤序不变）：不在段⑥解析后补查——保 ORC-022 步骤序与既有 trace 断言；拒绝码沿用 `agent_denied`。
3. **消息形**：显式形消息逐字不变（`Agent type 'X' has been denied by permission rule 'Agent(X)'.`）；缺省形在类型名后追加 ` (default)` 标注（`Agent type 'general-purpose' (default) has been denied …`），使"因缺省而拒"对用户可见、不误导为显式传入。
4. **提取口径不变**：`extractDeniedAgentTypes`（`apps/cli/src/session.ts:357`）仍只认 `Agent(X)` 形；不新增 settings 键；不做裸 `Agent`／通配形（见边界）。

## 理由

- deny 规则语义＝"该类型不得被派发"；缺省解析是该类型的一种派发路径，遗漏即规则静默失效（fail-open）——与本仓 fail-closed 家族（M5 B-12 等）不一致。
- 判定放段③＝最早拒绝点（权限先于解析/预算/并发），与既有九段"先拒后解析"序一致。
- 收紧型变更：只在"用户已显式写出该 deny 且以缺省类型派发"时多拒；无合法用法依赖旧漏洞。

## 向后兼容判定

- 只可能**多拒**不会少拒；先前放行、现被拒的唯一情形＝deny 已列 `Agent(general-purpose)`（或大小写变体）而调用未显式类型。
- 既有断言零改：显式类型既有用例（`packages/harness/test/subagent-spawn.test.ts`、`apps/cli/test/wp10-agent-wiring.test.ts`）语义与消息逐字不变。
- 边界形登记：缺省＋deny 命中但注册表无 `general-purpose` 时，错误码由 `type_missing` 变为 `agent_denied`（更早拒绝）——测试内显式覆盖该形。

## 影响面逐条

① `/subtask`（`repl.ts:431`）② `/fork`（`repl.ts:740`）③ workflow kernel（`packages/capabilities/src/workflow/kernel.ts:307` 复用同一 `validateSpawn`；其 `deniedAgentTypes` 由调用方 `options.deniedAgentTypes` 供给——"供给且缺省类型"组合同样收紧，语义一致）④ 程序面直调 `spawnSubagentTask`／`validateSpawn` 者同受（同一入口，单源）⑤ 命令面零改（无新增命令、无 i18n 键新增/变更）⑥ permission-broker 其它面零改。

## 边界

- 不做裸 `Agent` 规则形（无括号）与通配（`Agent(*)`）语义；不改 `permissions.deny` 对其它工具的规则面；不新增 settings 键；不改显式类型判定语义。
- 接缝㉕ 的 `docs/dev/seams.md` 登记随 WP-10 收口（板头接缝自检口径：㉕㉖ 均随收口卡登记）。

## 参考

- M7 遗留 #21（`docs/milestones/M7.md` 行 111）；M6-1-results §WP-10 D-1（行 273／行 284）；v2.8 §12.6／§5.2 行 216〔现行 217〕／§2 行 111／§2 行 116；M8-1 板 WP-03 卡。
- 实现：`packages/harness/src/subagent.ts`（段③，常量＋判定）；判据：`packages/harness/test/subagent-deny-default.test.ts`＋`apps/cli/test/wp03-deny-default.test.ts`（双通道）。
- ADR-0051（mini-ADR 形制前例）；ADR-0043（subagent 注册表与校验序列接线）。
