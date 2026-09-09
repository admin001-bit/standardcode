# ADR-0039: providers 配置形状——openai 线制 wire_api 键（M3，ADR-018 分期落地）

- 状态：已接受（2026-09-10，M3-WP-02）
- 规格处置：v2.8 §2 行 M3（"Responses API + OpenAI 兼容配置接入"，吸收清单 wire_api）；ADR-018 `[修正，已定]`（协议分期 M3=Responses）；§5.3(1)（ProviderAdapter 三方法/L5 内部 IR）；CTX-009（OpenAI Responses 需 `instructions` 顶层字段）；B-01/B-06（未覆盖级先 mini-ADR）。

## 背景

M1/M2 已落 Anthropic Messages 与 OpenAI Chat Completions 双 adapter（`packages/providers/src/anthropic.ts`/`openai.ts`），provider 选择走 `providers.default` + `STANDARD_CODE_PROVIDER`（apps/cli/src/session.ts `buildProvider`，缺省 anthropic）。M3 增第三协议 OpenAI Responses——同一 OpenAI 兼容账号下 `/v1/chat/completions` 与 `/v1/responses` 两条线并存，需要配置键区分线制；v2.8 对配置形状未定，按 B-06 落本 mini-ADR。

## 决策

1. **线制键 `wire_api`**（settings `providers.openai.wire_api`，env `STANDARD_CODE_WIRE_API` 同构覆盖，env 优先——与 baseUrl 解析序一致；值 `"chat" | "responses"`，缺省 `"chat"`）作用于 `openai` provider：`"chat"`=现行为 OpenAIChatAdapter 不回归；`"responses"`=ResponsesAdapter（端点 `/v1/responses`）。模型目录与 baseUrl 等其余 `providers.openai.*` 键两线共用（ADR-0030 键位）。其他值=配置错误，抛错拒绝启动（fail-closed）。
2. **先例标注**：Codex `WireApi` 枚举（`codex-rs/model-provider-info/src/lib.rs:64-68`——Responses 为 `#[default]`，chat 变体已删除并报错 `CHAT_WIRE_API_REMOVED_ERROR`，lib.rs:57）。本仓反向取缺省 `"chat"`：存量 M1/M2 行为零迁移，Responses 为显式 opt-in（[自定]）。键名沿用 Codex 的 snake_case `wire_api`（[自定]：settings 现存键为 camelCase，但线制键语义与 Codex 同名先例对齐，值域一致）。
3. **不做的**：不引入 wire_api 之外的 Codex 供给商配置面（query params/headers/cookie 等 `ModelProviderInfo` 其余字段）；不做 Bedrock/Vertex（板 WP-02 边界）。

## 参考

- 板 `plan\T1-能力\M3-任务化\M3-1-board.md` 卡 WP-02（边界：只做 ResponsesAdapter+providers.default/wire_api 配置键）。
- ADR-018（分期）、ADR-0030（settings 键位）。
