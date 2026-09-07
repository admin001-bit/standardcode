// OpenAI Chat Completions 协议适配器（L5，v2.8 §2 行 M1 PROD-010、§5.3(1)）。
// SSE 映射（data: {...} / [DONE]）：
//   首个 chunk → message_start；delta.content → text_delta
//   delta.reasoning_content | delta.reasoning → thinking_delta（方言 auto=流内探测，§5.3(1)）
//   delta.tool_calls[]：id+name 首现 → tool_start；arguments 片段 → tool_input_delta；
//     多工具/无 id 场景按 finish_reason 收束全部 tool_end
//   usage chunk（stream_options.include_usage）→ usage（cached_tokens → cacheRead 列）
//   choices[0].finish_reason → finish（映射表 finish.ts）；流止未发 → finish{unknown}
// 缓存：OpenAI 兼容端点为自动前缀缓存——**零 cache_control 打点**（CTX-004 能力退化，
// explicitBreakpoints=false）；cacheScope 仅内部计量与 Golden 对账。
// 请求方言：useMaxCompletionTokens → max_completion_tokens（o 系），默认 max_tokens。

import { classifyHttpError, classifyNetworkError, ProviderError } from "./errors.ts";
import { OPENAI_FINISH_REASON_TO_IR, mapFinishReason } from "./finish.ts";
import type { LLMEvent } from "./events.ts";
import { withRetry, DEFAULT_RETRY_POLICY } from "./retry.ts";
import { parseSse } from "./sse.ts";
import type { ContentBlock, LLMMessage, LLMRequest, ModelCapabilities, ProviderAdapter, ProviderOptions } from "./types.ts";
import { doFetch, httpRetryJudge, retryHooksOf, retryPolicyOf } from "./anthropic.ts";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIModelEntry {
  contextWindow: number;
  maxOutputTokens: { default: number; upper: number };
  thinking: "none" | "adaptive" | "budget";
  input: Array<"text" | "image" | "video" | "audio">;
  /** 方言：reasoning_content（DeepSeek 等）| reasoning | auto=流内探测（默认）。 */
  reasoningDialect?: "reasoning_content" | "reasoning" | "auto";
  /** 新方言端点用 max_completion_tokens，默认 false（通用 Chat Completions 面）。 */
  useMaxCompletionTokens?: boolean;
}

export function openaiCapabilities(entry: OpenAIModelEntry): ModelCapabilities {
  return {
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    thinking: entry.thinking,
    input: entry.input,
    streaming: true,
    toolCalling: true,
    // 自动前缀缓存：不发显式打点（CTX-004 退化路径）
    cache: { ttlLevels: [], explicitBreakpoints: false },
  };
}

// --- 请求体编码 ---

export function encodeMessagesOpenAI(messages: LLMMessage[]): unknown[] {
  // 内部 IR（Anthropic 形状块）→ OpenAI 消息：user 文本→user；tool_result→tool 角色；
  // assistant 文本+tool_use→assistant(content+tool_calls)。M1 忽略 thinking 块（不上传）。
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
        }
      }
      const texts = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
      if (texts.length) out.push({ role: "user", content: texts.map((t) => ({ type: "text", text: t.text })) });
    } else {
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((t) => t.text)
        .join("");
      const msg: Record<string, unknown> = { role: "assistant" };
      if (text) msg.content = text;
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? {}) },
        }));
      }
      if (text || toolUses.length) out.push(msg);
    }
  }
  return out;
}

function encodeToolsOpenAI(tools: LLMRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// --- 事件流解码 ---

async function* decodeOpenAIStream(body: ReadableStream<Uint8Array>, dialect: OpenAIModelEntry["reasoningDialect"]): AsyncGenerator<LLMEvent> {
  let sawStart = false;
  let sawFinish = false;
  // 已 tool_start 且未收尾的工具 id；finish_reason 时统一收束
  const openTools = new Set<string>();
  let reasoningSeen: "reasoning_content" | "reasoning" | null = null;
  for await (const frame of parseSse(body)) {
    if (frame.data === "[DONE]") break;
    let ev: any;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const choice = ev.choices?.[0];
    if (ev.usage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: ev.usage.prompt_tokens ?? 0,
          outputTokens: ev.usage.completion_tokens ?? 0,
          cacheCreationTokens: 0,
          cacheReadTokens: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    }
    if (!choice) continue;
    if (!sawStart) {
      sawStart = true;
      yield { type: "message_start", id: ev.id ?? null, model: ev.model ?? "" };
    }
    const delta = choice.delta ?? {};
    if (delta.content) yield { type: "text_delta", text: delta.content };
    const useKey: "reasoning_content" | "reasoning" | null =
      dialect === "auto"
        ? (reasoningSeen ?? (delta.reasoning_content ? "reasoning_content" : delta.reasoning ? "reasoning" : null))
        : (dialect ?? null);
    if (dialect === "auto") reasoningSeen = useKey;
    const reasoning = useKey === "reasoning_content" ? delta.reasoning_content : useKey === "reasoning" ? delta.reasoning : undefined;    if (reasoning) yield { type: "thinking_delta", thinking: reasoning };
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.id && tc.function?.name) {
          openTools.add(tc.id);
          yield { type: "tool_start", id: tc.id, name: tc.function.name };
        }
        if (tc.function?.arguments) {
          yield { type: "tool_input_delta", id: tc.id ?? "", jsonPartial: tc.function.arguments };
        }
      }
    }
    if (choice.finish_reason) {
      sawFinish = true;
      for (const id of openTools) yield { type: "tool_end", id };
      openTools.clear();
      yield { type: "finish", ...mapFinishReason(OPENAI_FINISH_REASON_TO_IR, choice.finish_reason) };
    }
  }
  if (sawStart && !sawFinish) {
    // 流止未发 finish_reason（截断）：unknown 语义（kosong null）
    yield { type: "finish", reason: "unknown", raw: null };
  }
  if (!sawStart) {
    yield { type: "error", error: new ProviderError("unknown", "stream ended before first chunk") };
  }
}

// --- 适配器 ---

export class OpenAIChatAdapter implements ProviderAdapter {
  private readonly models: Map<string, OpenAIModelEntry>;
  private readonly opts: ProviderOptions;

  constructor(models: Record<string, OpenAIModelEntry>, opts: ProviderOptions) {
    this.models = new Map(Object.entries(models));
    this.opts = opts;
  }

  capabilities(model: string): ModelCapabilities {
    const entry = this.models.get(model);
    if (!entry) throw new Error(`unknown model: ${model}`);
    return openaiCapabilities(entry);
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMEvent> {
    const caps = this.capabilities(req.model);
    const entry = this.models.get(req.model)!;
    const maxKey = entry.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens";
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...encodeMessagesOpenAI(req.messages),
      ],
      stream: true,
      stream_options: { include_usage: true },
      [maxKey]: req.maxTokens ?? caps.maxOutputTokens.default,
    };
    if (req.tools?.length) body.tools = encodeToolsOpenAI(req.tools);

    const res = await withRetry(
      () =>
        doFetch(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, req.signal, this.opts, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
        }),
      httpRetryJudge,
      retryPolicyOf(this.opts),
      retryHooksOf(this.opts),
    );
    yield* decodeOpenAIStream(res.body!, entry.reasoningDialect ?? "auto");
  }

  async countTokens(req: LLMRequest): Promise<number> {
    // M1：本地估算，同 Anthropic 侧口径（§13 行 1：API usage 对账为准、本地估算标注误差）。
    return Math.ceil(JSON.stringify(req).length / 4);
  }
}
