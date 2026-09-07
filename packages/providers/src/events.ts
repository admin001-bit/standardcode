// 事件 IR（v2.8 §5.3(1)：事件统一为 L5 内部 IR，finish 枚举穷尽）。
// ProviderFinishReason 同构 kosong packages/kosong/src/provider.ts:76-82 六枚举，
// 另增 "unknown"（=kosong 的 null：provider 未发 finish_reason，如流截断）——穷尽全覆盖。

import type { ProviderError } from "./errors.ts";

export type ProviderFinishReason =
  | "completed"
  | "tool_calls"
  | "truncated"
  | "filtered"
  | "paused"
  | "other"
  | "unknown";

// v2.8 §7.2 CTX-102[自定] 四列：input/output/cache_creation/cache_read
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export type LLMEvent =
  | { type: "message_start"; id: string | null; model: string }
  | { type: "text_delta"; text: string }
  /** M1 仅透传 thinking 增量；签名原样回传属 M2（CTX-020）。 */
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input_delta"; id: string; jsonPartial: string }
  | { type: "tool_end"; id: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: ProviderFinishReason; raw: string | null }
  | { type: "error"; error: ProviderError };
