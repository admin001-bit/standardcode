// Anthropic Messages 协议适配器（L5，v2.8 §2 行 M1 PROD-010、§5.3(1)）。
// SSE 事件映射：
//   message_start（usage.input_tokens/cache_*）→ message_start + usage
//   content_block_start(tool_use) → tool_start（index→id 关联后续 delta）
//   content_block_delta text_delta/thinking_delta/input_json_delta → 对应 delta 事件
//   content_block_stop(tool_use 块) → tool_end
//   message_delta（stop_reason + usage.output_tokens）→ usage（四列合并）+ finish
//   流内 error 帧 → error 事件后终止
//   流止而未发 stop_reason → finish{unknown}（kosong null 语义）
// 缓存：explicitBreakpoints=true（Anthropic 语义）→ 末条 user 消息末块挂 cache_control（§7.1/CTX-004）。

import { classifyHttpError, classifyNetworkError, ProviderError } from "./errors.ts";
import { ANTHROPIC_STOP_REASON_TO_IR, mapFinishReason } from "./finish.ts";
import type { LLMEvent, TokenUsage } from "./events.ts";
import { withRetry, DEFAULT_RETRY_POLICY } from "./retry.ts";
import { parseSse } from "./sse.ts";
import type {
  ContentBlock,
  LLMMessage,
  LLMRequest,
  ModelCapabilities,
  ProviderAdapter,
  ProviderOptions,
  ToolDef,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface AnthropicModelEntry {
  contextWindow: number;
  maxOutputTokens: { default: number; upper: number };
  thinking: "none" | "adaptive" | "budget";
  input: Array<"text" | "image" | "video" | "audio">;
}

export function anthropicCapabilities(entry: AnthropicModelEntry): ModelCapabilities {
  return {
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    thinking: entry.thinking,
    input: entry.input,
    streaming: true,
    toolCalling: true,
    cache: { ttlLevels: ["5m", "1h"], explicitBreakpoints: true },
  };
}

// --- 请求体编码 ---

function encodeBlock(b: ContentBlock, cacheControl: boolean): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return cacheControl
        ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } }
        : { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
  }
}

export function encodeMessagesAnthropic(messages: LLMMessage[], explicitBreakpoints: boolean): unknown[] {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) => ({
    role: m.role,
    content: m.content.map((b, bi) =>
      encodeBlock(b, explicitBreakpoints && i === lastUserIdx && bi === m.content.length - 1),
    ),
  }));
}

function encodeToolsAnthropic(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// --- 事件流解码 ---

async function* decodeAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LLMEvent> {
  let sawStart = false;
  let inputUsage: TokenUsage | null = null;
  // content block index → tool_use id（input_json_delta 按 index 关联）
  const blockTools = new Map<number, string>();
  for await (const frame of parseSse(body)) {
    let ev: any;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "message_start": {
        sawStart = true;
        const u = ev.message?.usage ?? {};
        inputUsage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
        };
        yield { type: "message_start", id: ev.message?.id ?? null, model: ev.message?.model ?? "" };
        if (inputUsage) yield { type: "usage", usage: inputUsage };
        break;
      }
      case "content_block_start": {
        const c = ev.content_block;
        if (c?.type === "tool_use") {
          blockTools.set(ev.index, c.id);
          yield { type: "tool_start", id: c.id, name: c.name };
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta;
        if (d?.type === "text_delta") {
          yield { type: "text_delta", text: d.text };
        } else if (d?.type === "thinking_delta") {
          yield { type: "thinking_delta", thinking: d.thinking };
        } else if (d?.type === "input_json_delta") {
          const id = blockTools.get(ev.index);
          if (id !== undefined) yield { type: "tool_input_delta", id, jsonPartial: d.partial_json ?? "" };
        }
        // signature_delta：M1 忽略（thinking 签名原样回传属 M2，CTX-020）
        break;
      }
      case "content_block_stop": {
        const id = blockTools.get(ev.index);
        if (id !== undefined) {
          yield { type: "tool_end", id };
          blockTools.delete(ev.index);
        }
        break;
      }
      case "message_delta": {
        const out = ev.usage?.output_tokens;
        if (inputUsage && typeof out === "number") {
          const merged: TokenUsage = { ...inputUsage, outputTokens: out };
          yield { type: "usage", usage: merged };
        }
        yield { type: "finish", ...mapFinishReason(ANTHROPIC_STOP_REASON_TO_IR, ev.delta?.stop_reason) };
        break;
      }
      case "error": {
        const e = ev.error ?? {};
        yield {
          type: "error",
          error: new ProviderError("unknown", `${e.type ?? "error"}: ${e.message ?? ""}`),
        };
        return;
      }
      default:
        break; // ping / 未知类型忽略
    }
  }
  if (!sawStart) {
    // 未收到 message_start 即流止：协议异常，交 L1 恢复链④（流中断）处理
    yield { type: "error", error: new ProviderError("unknown", "stream ended before message_start") };
  }
}

// --- 适配器 ---

export class AnthropicAdapter implements ProviderAdapter {
  private readonly models: Map<string, AnthropicModelEntry>;
  private readonly opts: ProviderOptions;

  constructor(models: Record<string, AnthropicModelEntry>, opts: ProviderOptions) {
    this.models = new Map(Object.entries(models));
    this.opts = opts;
  }

  capabilities(model: string): ModelCapabilities {
    const entry = this.models.get(model);
    if (!entry) throw new Error(`unknown model: ${model}`);
    return anthropicCapabilities(entry);
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMEvent> {
    const caps = this.capabilities(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? caps.maxOutputTokens.default,
      ...(req.system ? { system: req.system } : {}),
      messages: encodeMessagesAnthropic(req.messages, caps.cache.explicitBreakpoints),
      stream: true,
    };
    if (req.tools?.length) body.tools = encodeToolsAnthropic(req.tools);

    const res = await withRetry(
      () =>
        doFetch(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, req.signal, this.opts, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.opts.apiKey,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify(body),
        }),
      httpRetryJudge,
      retryPolicyOf(this.opts),
      retryHooksOf(this.opts),
    );
    yield* decodeAnthropicStream(res.body!);
  }

  async countTokens(req: LLMRequest): Promise<number> {
    // M1：本地估算（§13 行 1 处置=API usage 对账为准、本地估算标注误差）。
    // /v1/messages/count_tokens 端点接入推迟到对账需求出现时（结果页偏差登记）。
    return Math.ceil(JSON.stringify(req).length / 4);
  }
}

// --- 共用传输 ---

export async function doFetch(
  url: string,
  signal: AbortSignal | undefined,
  opts: Pick<ProviderOptions, "fetchImpl" | "sleep" | "rng">,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    throw classifyNetworkError(err);
  }
  if (!res.ok) throw await classifyHttpError(res);
  if (!res.body) throw new Error("response has no body");
  return res;
}

export function httpRetryJudge(err: unknown): { retryable: boolean; retryAfterMs: number | null } {
  const e = err as { retryable?: boolean; retryAfterMs?: number | null };
  return { retryable: e?.retryable === true, retryAfterMs: e?.retryAfterMs ?? null };
}

export function retryPolicyOf(opts: ProviderOptions) {
  return { ...DEFAULT_RETRY_POLICY, maxAttempts: opts.maxRetryAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts };
}

export function retryHooksOf(opts: ProviderOptions) {
  return opts.sleep ? { sleep: opts.sleep, rng: opts.rng } : { rng: opts.rng };
}
