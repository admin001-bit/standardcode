// WP-04（M2）：9 段压缩摘要（v2.8 §7.2 CTX-036 全条；§2 行 M2"压缩期禁工具与安全相关指令逐字保留"不变量；
// §12.5 接缝②cacheScope×AutoCompact——压缩响应共享 prompt cache）。
// 提示词=A 级报告 claude-code-context-control.md §3 全文提取（c3o，_440.js L137984）的自研转写；
// 9 段名与顺序=源码确认口径（L138005-138013，三变体均 9 段）；partial 变体第 8/9 段=Work Completed/Context for Continuing Work。
// 禁工具：压缩请求不携带 tools（[CC]"Tool use is not allowed during compaction"）。
// cache sharing（接缝②）：压缩请求=原 system+原消息前缀（逐字节一致）+末尾 user 指令消息——前缀共享主对话缓存；
//   Anthropic 侧末条 user 块 cache_control 挂点由 adapter 自动生效（M1 WP-01 已测），OpenAI 自动前缀缓存同享。
// ≤32MB：请求体序列化 >32MB → 拒绝执行（CTX-036"请求 ≤32MB"）。
// thinking 继承：会话 thinking 配置经 carryThinkingConfig（WP-06 接缝）带入压缩请求（CTX-021 工程不变量②）。

import type { LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { carryThinkingConfig, type ThinkingSetting } from "./thinking-carry.ts";

export const COMPACT_REQUEST_MAX_BYTES = 32 * 1024 * 1024;

/** 9 段名与顺序（CTX-036 原文口径）。 */
export const COMPACT_SECTIONS: readonly string[] = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "All user messages",
  "Pending Tasks",
  "Current Work",
  "Optional Next Step",
];

/** partial 变体第 8/9 段（compact_partial）。 */
export const PARTIAL_SECTION_8 = "Work Completed";
export const PARTIAL_SECTION_9 = "Context for Continuing Work";

export interface CompactPromptOptions {
  /** partial 压缩：第 8/9 段换 Work Completed/Context for Continuing Work。 */
  partial?: boolean;
}

/** 压缩指令文本（自研转写；安全相关指令逐字保留=S-1 在压缩路径的具体化）。 */
export function buildCompactPrompt(opts: CompactPromptOptions = {}): string {
  const s8 = opts.partial ? PARTIAL_SECTION_8 : COMPACT_SECTIONS[7]!;
  const s9 = opts.partial ? PARTIAL_SECTION_9 : COMPACT_SECTIONS[8]!;
  const numbered = COMPACT_SECTIONS.map((n, i) => {
    const idx = i + 1;
    if (idx === 8) return `${idx}. ${s8}`;
    if (idx === 9) return `${idx}. ${s9}`;
    return `${idx}. ${n}`;
  }).join("\n");
  return [
    "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
    "This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",
    "Before providing your final summary, wrap your analysis in <analysis> tags. The <analysis> section is internal working notes and is stripped before the summary is used.",
    "",
    "1. Chronologically analyze each message. Pay special attention to user feedback telling you to do something differently, and preserve security-related instructions verbatim (they MUST appear in the summary word-for-word, unmodified).",
    "2. Double-check technical accuracy and completeness.",
    "",
    "The summary MUST contain exactly these sections, in this order:",
    numbered,
    "",
    "Tool use is not allowed during compaction — produce a text summary only.",
  ].join("\n");
}

/** <analysis> 剥离：成对标签整段移除；未闭合则自标签起剥到尾（防内部笔记泄漏进摘要）。 */
export function stripAnalysis(text: string): string {
  const closed = /<analysis>[\s\S]*?<\/analysis>/g;
  let out = text.replace(closed, "");
  const open = out.indexOf("<analysis>");
  if (open !== -1) out = out.slice(0, open); // 未闭合：剥到尾
  return out.trim();
}

/** partial 压缩边界：保留 selected 起的消息，压其前缀（compact_partial messagesKept 同构）。 */
export function splitForPartial(messages: LLMMessage[], selectedIdx: number): { toSummarize: LLMMessage[]; kept: LLMMessage[] } {
  const idx = Math.max(0, Math.min(selectedIdx, messages.length));
  return { toSummarize: messages.slice(0, idx), kept: messages.slice(idx) };
}

export interface BuildCompactRequestInput {
  system?: string;
  /** 被压缩的对话前缀（partial 时=toSummarize）。 */
  messages: LLMMessage[];
  thinking?: ThinkingSetting;
  partial?: boolean;
}

export interface CompactRequestParts {
  request: LLMRequest;
  /** 前缀共享断言用：原对话消息（逐字节一致，接缝②）。 */
  prefix: LLMMessage[];
}

/**
 * 构造压缩请求：原 system+原消息前缀原样保留（cache 共享）+末尾 user 指令消息；
 * 不携带 tools（禁工具）；thinking 经 WP-06 接缝继承。
 */
export function buildCompactRequest(input: BuildCompactRequestInput): CompactRequestParts {
  const instruction: LLMMessage = { role: "user", content: [{ type: "text", text: buildCompactPrompt({ partial: input.partial }) }] };
  const messages = [...input.messages, instruction];
  const request: LLMRequest = {
    model: "",
    ...(input.system ? { system: input.system } : {}),
    messages,
    // 禁工具：无 tools 字段（CTX-036）
    ...(input.thinking ? { thinking: carryThinkingConfig(input.thinking) } : {}),
  };
  return { request, prefix: input.messages };
}

/** 请求体 ≤32MB 断言（CTX-036）。 */
export function assertRequestSize(request: LLMRequest): void {
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  if (bytes > COMPACT_REQUEST_MAX_BYTES) {
    throw new Error(`compact request too large: ${bytes} bytes > ${COMPACT_REQUEST_MAX_BYTES} (CTX-036)`);
  }
}

export interface RunCompactionInput {
  provider: ProviderAdapter;
  model: string;
  system?: string;
  messages: LLMMessage[];
  thinking?: ThinkingSetting;
  partial?: { selectedIdx: number };
  /** token 估算（缺省 JSON/4，ADR-0027 口径）。 */
  estimate?: (text: string) => number;
}

export interface CompactionResult {
  /** 剥离 <analysis> 后的摘要。 */
  summary: string;
  newMessages: LLMMessage[];
  preTokens: number;
  postTokens: number;
}

/** 执行压缩：构造请求→流式取文本→剥 <analysis>→摘要替换历史（user 消息承载，[自定]）。 */
export async function runCompaction(input: RunCompactionInput): Promise<CompactionResult> {
  const estimate = input.estimate ?? ((t: string) => Math.ceil(Buffer.byteLength(t, "utf8") / 4));
  let toSummarize = input.messages;
  let kept: LLMMessage[] = [];
  if (input.partial) {
    const split = splitForPartial(input.messages, input.partial.selectedIdx);
    toSummarize = split.toSummarize;
    kept = split.kept;
  }
  const { request } = buildCompactRequest({ system: input.system, messages: toSummarize, thinking: input.thinking, partial: input.partial !== undefined });
  const full: LLMRequest = { ...request, model: input.model };
  assertRequestSize(full);
  // 前缀一致断言（接缝② cache sharing 的结构前提）
  if (JSON.stringify(full.messages.slice(0, toSummarize.length)) !== JSON.stringify(toSummarize)) {
    throw new Error("compact request prefix mismatch (cache sharing invariant)");
  }

  const preTokens = estimate(JSON.stringify(toSummarize));
  let text = "";
  for await (const ev of input.provider.stream(full)) {
    if (ev.type === "text_delta") text += ev.text;
    else if (ev.type === "error") throw ev.error;
  }
  const summary = stripAnalysis(text);
  if (summary === "") throw new Error("compaction produced empty summary");
  const postTokens = estimate(summary);
  const newMessages = [...kept, { role: "user" as const, content: [{ type: "text" as const, text: summary }] }];
  return { summary, newMessages, preTokens, postTokens };
}
