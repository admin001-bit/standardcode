# ADR-0027: token 计量口径——API usage 对账为准，本地估算标注误差

- 状态：已接受（2026-09-08，M1-WP-05）
- 规格处置：v2.8 §13 行 1（token 计数器选型 → M1 mini-ADR）原文：**"API usage 对账为准、本地估算标注误差"**；CTX-102[自定]（usage 四列自首轮流式累计，M1 打印原始 usage，M3 /usage 与价格表收口）。
- 背景：各协议 tokenizer 不一致（Anthropic/OpenAI/本地模型各有词表），任何本地估算都无法作为计费/限额权威。

## 决策

1. **四列语义**：input / output / cache_creation / cache_read（CTX-102 原文）。
2. **快照 vs 增量**：单轮内的 usage 事件是**该轮快照**（最后一条为准）——Anthropic message_start（input+cache 列）与 message_delta（合并 output）为合并式上报，OpenAI include_usage 末条为全量；跨轮累计由 UsageMeter.observe() 完成（单调递增）。主循环（WP-02）不得对快照做增量累加。
3. **权威与标注**：计费/限额对账以 API 返回的 usage 为唯一权威；`countTokens`/本地估算仅作预估，展示时 MUST 携带误差标注（`reconcileEstimate` 返回 deltaTokens/deltaPct 与固定 note）。
4. **M1 边界**：打印原始 usage（formatRawUsage）；/usage 命令、价格表、成本估算留 M3（B-03：进不了本 M 的 MUST 不提前实现）。

## 影响的相邻机制

- WP-02 主循环 usage 事件语义（快照转发，不跨轮累加——主循环事件流透传，Meter 归 context 包）。
- M2 /context 对账（v2.8 §2 行 M2：/context 与真实 usage 对账）——直接消费本 ADR 的 reconcile 口径。
- WP-01 两 adapter 的 usage 事件形状（快照语义已与其实测上报一致，无需改动）。

## 参考

- v2.8 §13 行 1、§7.2 CTX-102、§2 行 M2（/context 对账）。
- kosong `TokenUsage` 形态（packages/kosong/src/provider.ts，[CC] 同构参照）。
