# ADR-0038: transcript compact 记录与重建截断语义（M3，M2 偏差⑤清偿）

- 状态：已接受（2026-09-10，M3-WP-01）
- 规格处置：v2.8 §12.4 ENG-080（schemaVersion/frontmatter 语义变更登记 ADR + `/doctor` 迁移提示）；§13 行 2（ADR-0028 schema 基座扩展）；§8.2 /compact 与 §7.2 AutoCompact 的落盘一致性；M2-1-results §WP-11 修复节偏差⑤（"压缩回缩缺口"移交本里程碑）。

## 背景（缺口本体）

M2 冻结时：压缩（手动 /compact 与自动 autocompact）只替换内存中的 `session.messages`，transcript **没有任何 compact 记录**——压缩后的新 turn 继续追加在压缩前全史之后。/resume 重建=压缩前全史+压缩后增量 ≠ 压缩后活体终态（M1 恢复等价 toEqual 口径在压缩路径上失效），且跨会话丢失压缩收益。

## 决策

1. **新增记录 kind=`compact`**：`{kind:"compact", preTokens, postTokens, mode:"manual"|"auto", summary?}`——`summary` 存压缩摘要文本（重建时的历史起点锚点）。schemaVersion 保持 1：kind 枚举扩展对旧 reader 无害（旧 `rebuildMessages` 只消费 user_message/assistant_message，compact 记录被忽略=旧行为），不构成破坏性变更，无需次要版本废弃周期。
2. **重建截断语义**：`rebuildMessages` 遇 compact 记录时，**丢弃其之前的全部消息**，以 `{role:"user", content:[{type:"text", text: summary}]}`（压缩摘要消息）作为历史起点，其后消息照常追加——重建结果=压缩后活体终态（与 M1 恢复等价口径一致）。多个 compact 记录按序多次截断（最后一次生效后的增量保留）。`summary` 缺失（兼容防御）时仅截断、以空摘要占位消息起点。
3. **写入点**（repl 压缩两通道）：`runCompaction` 成功后、`s.messages = r.newMessages` 同步处——手动通道（ctx.compact，mode:"manual"）与自动通道（autocompact.perform，mode:"auto"）各 append 一条 compact 记录；写入失败不阻断会话（Resilient 层降级语义不变）。
4. **seq 单调性不受影响**：compact 记录走 `TranscriptWriter.append` 正常递增 seq；done 记录的 usage 累计口径不变（压缩不重置 meter）。
5. **迁移提示**：本扩展不要求旧文件迁移（无 compact 记录=现行为）；`/doctor` 迁移提示通道（ENG-080）在 settings schemaVersion 检查中已覆盖落盘契约告警面，本 ADR 不新增 doctor 检查项（kind 缺失非错误状态）。

## 影响的相邻机制

- `apps/cli/src/repl.ts` 压缩两通道写入点；`switchSession` drain 串行链（compact 记录与其他记录同链保序）。
- WP-10 复验根修的"turn 末统一写入"时序不变——compact 记录在压缩发生时即写，与 turn 末块写入互斥不冲突。
- evals（WP-11）与 E2E②：含压缩会话的 resume 等价断言从此可测（本轮补回归）。
- /rewind file-history：不受影响（快照在工具写盘前，与压缩记录无交集）。

## 参考

- M2-1-results §WP-11 修复节偏差⑤（缺口移交原文）、§WP-13 复验二轮"压缩回缩缺口归 WP-11 /compact 范畴"。
- ADR-0028（schema v1 基座）、ADR-0027（usage 四列）。
