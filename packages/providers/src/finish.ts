// stop_reason / finish_reason → IR 映射表。
// 覆盖 §5.4 九级恢复链所需枚举：
//   ③ max_tokens 续写 ← truncated；④ 流中断/pause_turn 续写 ← paused；⑨ 正常完成 ← completed。
//   ⑤ 畸形工具调用在工具层以 input JSON 解析失败判定、⑥ thinking-only 由 L1 在 completed
//   语义上判定、⑧ max-turns 为 loop 内部计数——三者不依赖 finish 枚举。
//   ② prompt-too-long 走 HTTP 错误分类（errors.ts context_length），非 finish 路径。
// 未收录的 raw 值 → "other"（kosong 语义，provider.ts:73-74）；null/未发 → "unknown"。
// 原始值一律随 finish 事件透传（raw 字段），供诊断与 §12.5 差异登记。

import type { ProviderFinishReason } from "./events.ts";

export const ANTHROPIC_STOP_REASON_TO_IR: Readonly<Record<string, ProviderFinishReason>> = {
  end_turn: "completed",
  stop_sequence: "completed",
  max_tokens: "truncated",
  tool_use: "tool_calls",
  pause_turn: "paused",
  refusal: "filtered",
};

export const OPENAI_FINISH_REASON_TO_IR: Readonly<Record<string, ProviderFinishReason>> = {
  stop: "completed",
  length: "truncated",
  tool_calls: "tool_calls",
  function_call: "tool_calls", // 旧字段（deprecated），语义仍为工具调用
  content_filter: "filtered",
};

export function mapFinishReason(
  table: Readonly<Record<string, ProviderFinishReason>>,
  raw: string | null | undefined,
): { reason: ProviderFinishReason; raw: string | null } {
  if (raw == null) return { reason: "unknown", raw: null };
  return { reason: table[raw] ?? "other", raw };
}
