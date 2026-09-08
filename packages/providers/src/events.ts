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
  /** M2 CTX-020：thinking 增量透传（harness 同时累积，块停时以 thinking_end 回传签名）。 */
  | { type: "thinking_delta"; thinking: string }
  /**
   * M2 CTX-020 工程不变量①：thinking 块完整收束——thinking/thinkingSignature 原样回传
   * （压缩/续传时签名丢失会被 API 拒绝）。signature 语义=Provider 原文字节，不做任何加工。
   * 无签名方言（OpenAI 兼容 reasoning）=signature 省略。
   */
  | { type: "thinking_end"; thinking: string; thinkingSignature?: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input_delta"; id: string; jsonPartial: string }
  | { type: "tool_end"; id: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: ProviderFinishReason; raw: string | null }
  | { type: "error"; error: ProviderError };
