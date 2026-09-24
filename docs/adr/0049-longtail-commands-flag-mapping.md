# ADR-0049: 四长尾命令 flag 映射与语义（M7-1 板 WP-07 交付物；[自定] 登记）

- 状态：已接受（2026-09-24，X 会话按卡内定并登记；§8.2 行 365 M7 分期含 `/branch` `/batch` `/loop` `/btw`）
- 前序锚：M6-WP-01（实验门基座）、M6-WP-10（fork/export 落 `fork` flag）、M6-WP-05（workflows 落 `workflow` flag）、ADR-0048（mini-ADR 最短形制先例）；BLK-06=①（M6 复审用户裁决：四件延后 M7）。

## 背景

- §8.2 行 365 列四件命令名但未定归属 flag 与语义形制（规格空白面）。M6 复审（BLK-06=①）裁：四件延后 M7，自 `EXPERIMENTAL_DEFERRED_COMMANDS` 迁入门对应 flag 映射并实现。
- 本卡落点：`apps/cli/src/experimental-gate.ts`（映射＋门内命令体）、`apps/cli/src/repl.ts`（ctx 方法：branch/btw/loop/batch）、`packages/platform/src/i18n.ts`（双包文案键）、`apps/cli/test/wp07-longtail-commands.test.ts`（DoD 判据）。
- 计数口径（CLI_COMMANDS 守恒 35 不变）：默认关=零注册；workflow 开=+3（workflows/batch/loop→38）、fork 开=+3（fork/export/branch→38）、teams 开=+0（无命令面→35）、三 flag 全开=+6（→41）；`/btw` 侧信道恒不注册。

## 决策

1. **flag 映射**（[自定]，登记面）：`workflow → ["workflows","batch","loop"]`、`fork → ["fork","export","branch"]`、`teams → []`（无斜杠命令面；**`/btw` 属 teams 侧信道**——不进本表、恒不注册，仅 REPL 在 teams 开启时旁路派发，见决策 3）。〔补注 2026-09-25 WP-14 收口：**于决策 1 行内补注 `/btw` 的 teams 侧信道归属**（非增列独立映射条目），映射表本体与决策内容均不变。〕
2. **`/branch [name]`（fork flag）**：复制当前会话转录为新 session 文件并注册进会话索引（供 `/resume` 恢复），打印新分支 session id；**不切换当前会话**（降级态：无 writer 时从内存消息重建最小转录落 `transcriptsDir`）。无 fail-closed——空会话仍可分叉为空分支（与 fork 派生"空会话拒绝"不同族：branch 是快照复制，非 agent 派生）。
3. **`/btw <question>`（teams flag 侧信道）**：旁路边问——以 provider 单轮流式问、答案经 `ctx.write` 上屏；**不进主消息流、不写转录**（[CC] CHANGELOG:2859 教训：旁路问询不污染主上下文）。`teams:[]` 无斜杠命令面，故 `/btw` 不进 `EXPERIMENTAL_FLAG_COMMANDS`、不入注册表（`experimentalCommandNames` 经 `EXPERIMENTAL_SIDECHANNEL_COMMANDS` 仍含 `btw` 以保拒绝面），仅 REPL 在 teams 开启时旁路派发。
4. **`/loop <n> <prompt>`（workflow flag，计数制）**：把 `<prompt>` 连续执行 `<n>` 次（上限 `LOOP_MAX_ROUNDS=10` 防失控）；无参=查看状态（"[loop] 无活动循环"）。每轮 push user+assistant 消息并 `transcriptAppend` 落盘；`ReplDeps.isInterrupted?.()` 支持 REPL 中断（Esc/Ctrl+C）提前退出。
5. **`/batch <file>`（workflow flag，逐行制，无锚 [自定]）**：读文件逐非空行（trim 后）作为 user turn 顺序执行（行数上限 `BATCH_LINE_CAP=200` 防失控）；空参/缺文件/超行数均 fail-closed 点名。**无锚**：[CC] 无 `/batch` 一手锚，语义按批处理最小可测形（逐行=一轮一行的单轮执行）[自定]，不引入锚定编排/重试/并发（见边界）。
6. **实现复用**：四命令体均为 `SlashCommand` 薄壳，委托 `repl.ts` 的 ctx 方法，走既有会话存储面（`ResilientTranscriptWriter`/`transcriptsDir`/`renameSessionTitle`）与 provider 面（`s.provider.stream`），不另立第二套存储/provider 接线。

## 理由

- **计数制 vs 时间制（loop）**：[CC] `/loop` 为时间制（"run for N minutes"）；本仓取计数制（"run N times"）因 M7 长尾定位=可测的最小执行语义（单轮单问 ×N，落转录可 resume 核对），上限防失控；时间制依赖 agent 循环计时器（属 §3.2 自动续跑面），不在本卡边界。
- **batch 无锚**：无 [CC] 锚可对照，取"逐行=顺序单轮执行"最窄语义，明确拒绝编排/并发以避免越界；行数上限为唯一防失控面。
- **btw 侧信道不进注册表**：保计数矩阵（teams 开=注册表仍 35、`EXPERIMENTAL_FLAG_COMMANDS.teams=[]`）与"默认关=零注册"同形，同时 teams flag 仍可用（REPL 旁路派发），不污染命令帮助表/派发面。
- **branch 不 fail-closed**：快照复制语义，空会话复制为空分支属合法可恢复态；fail-closed 留给 fork 派生（agent 派生须有父转录）。

## 边界

- 四件均默认关（门关=零注册）；仅对应 flag 开启才注册（组合面见背景计数口径）。
- `/loop` `/batch` 为单轮执行语义（非完整 agent 循环/工具序列）；不触 ORC-022 校验、不派 subagent。
- `/batch` 不做并发/重试/断点续跑；超行数拒绝而非截断执行。
- `/btw` 不写转录、不进 `s.messages`，不影响主对话 resume 等价性。
- 不新增 settings 键（故不登记 ADR-0030 键位，仅登记 flag→命令映射表）；不触 M5/M6 冻结面。

## 参考

- v2.8 §8.2 行 365；M7-1 板 WP-07 卡；`apps/cli/src/experimental-gate.ts`（映射＋门内命令体）、`apps/cli/src/repl.ts`（branch/btw/loop/batch ctx 方法）、`packages/platform/src/i18n.ts`（双包键 `cmd.{branch,batch,loop,btw}.*`/`repl.{branch,batch,loop,btw}.*`）、`apps/cli/test/wp07-longtail-commands.test.ts`（DoD①④②③⑤）。
- ADR-0048（mini-ADR 最短形制先例）、ADR-0030（实验 flag 键位＋本卡增补 flag→命令映射表）、M6-WP-01（实验门基座）。
