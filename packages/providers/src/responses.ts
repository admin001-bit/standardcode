// OpenAI Responses API 协议适配器（L5，v2.8 §2 行 M3、ADR-018 分期、ADR-0039 线制键）。
// 端点 POST {baseUrl}/responses，SSE 帧 event: response.* / data: {type:"response.*",...}。
// 请求编码（CTX-009 实证）：
//   system → instructions 顶层字段（Responses 无 system 角色消息）；
//   input 数组消息编码：user 文本 → {role:"user", content:[{type:"input_text",text}]}；
//   assistant tool_use → {type:"function_call", call_id, name, arguments}；
//   tool_result → {type:"function_call_output", call_id, output}；thinking 块不上传（同 openai.ts）。
// 流解码（Codex codex-api/src/sse/responses.rs 事件面同构）：
//   response.output_text.delta → text_delta
//   response.reasoning_summary_text.delta / response.reasoning_text.delta → 乱序重排缓冲 → thinking_delta
//     （按 item_id×summary_index 分组缓冲，done 触发连续前缀产出、统一收束按 index 升序冲刷——
//      同构 OpenCode reasoning 三态机 best-effort 语义，调研报告_Codex沙箱与OpenCode-Provider.md §B2）
//   response.output_item.added(type=function_call) → tool_start；delta 拼装：
//   response.function_call_arguments.delta → tool_input_delta（item_id 归因，input_json_delta 拼装同构）
//   response.completed → 收束全部开工具 + finish（工具轮=tool_calls；usage 可同帧或分离帧）
//   response.failed(error.code=context_length_exceeded|model_context_window_exceeded) → error{context_length}
//     （Codex is_context_window_error，responses.rs:680-682；harness 侧 kind==="context_length"
//      路由 context_exhausted——agent-loop.ts:351）
//   流止未发 completed/failed → finish{unknown}；usage 在 response.completed.response.usage。
// 事件白名单外（in_progress/output_text.done/content_part.* 等）忽略——同 Codex 忽略分支（responses.rs:497-507）。

import { classifyHttpError, classifyNetworkError, ProviderError } from "./errors.ts";
import type { LLMEvent, ProviderFinishReason } from "./events.ts";
import { withRetry } from "./retry.ts";
import { parseSse } from "./sse.ts";
import type { ContentBlock, LLMMessage, LLMRequest, ModelCapabilities, ProviderAdapter, ProviderOptions } from "./types.ts";
import { doFetch, httpRetryJudge, retryHooksOf, retryPolicyOf } from "./anthropic.ts";
import type { OpenAIModelEntry } from "./openai.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// wire_api 线制键解析（ADR-0039：settings providers.openai.wire_api / env STANDARD_CODE_WIRE_API，
// env 优先；值 chat|responses，缺省 chat 不回归 M1/M2 行为；其他值 fail-closed 抛错）。
// Codex 先例 WireApi 枚举（model-provider-info/src/lib.rs:64-68）反向缺省——本仓存量 chat 行为零迁移。
export function parseWireApi(raw: string | undefined | null): "chat" | "responses" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "chat") return "chat";
  if (v === "responses") return "responses";
  throw new Error(`invalid wire_api: ${raw}（可选 chat|responses，缺省 chat；见 ADR-0039）`);
}

// stop_reason 语义在 Responses 走 response.completed/incomplete 的 status（协议无 tool_calls 终止码）：
//   completed + output 含 function_call → tool_calls（同 Anthropic stop_reason=tool_use 映射先例）；
//   incomplete 按 incomplete_details.reason 细分（max_output_tokens→truncated／content_filter→filtered）。
// usage 与 finish 容忍分离两帧（兼容端点变体；Codex 实证 completed 的 usage 可缺省，
// responses.rs:841-858 token_usage.is_none() 测试）——finish 恰一次，任意终局帧携带 usage 均产出 usage 事件。
const INCOMPLETE_REASON_TO_IR: Readonly<Record<string, string>> = {
  max_output_tokens: "truncated",
  content_filter: "filtered",
};

export function responsesCapabilities(entry: OpenAIModelEntry): ModelCapabilities {
  return {
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    thinking: entry.thinking,
    input: entry.input,
    streaming: true,
    toolCalling: true,
    // 自动前缀缓存：不发显式打点（与 openai.ts 同一 CTX-004 退化路径）
    cache: { ttlLevels: [], explicitBreakpoints: false },
  };
}

// --- 请求体编码 ---

export function encodeInputResponses(messages: LLMMessage[]): unknown[] {
  // 内部 IR（Anthropic 形状块）→ Responses input 数组。
  // tool_result 归属其 toolUseId（call_id）；assistant 文本与 tool_use 同轮可拆多条 item
  // （Responses 侧 function_call 为独立 output item，不挂在消息 content 内）。
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
      for (const r of toolResults) {
        out.push({ type: "function_call_output", call_id: r.toolUseId, output: r.content });
      }
      const texts = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
      if (texts.length) {
        out.push({ role: "user", content: texts.map((t) => ({ type: "input_text", text: t.text })) });
      }
    } else {
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      for (const t of toolUses) {
        out.push({
          type: "function_call",
          call_id: t.id,
          name: t.name,
          arguments: typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? {}),
        });
      }
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((t) => t.text)
        .join("");
      if (text) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }
  }
  return out;
}

function encodeToolsResponses(tools: LLMRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  // Responses 工具面为扁平形状（无 Chat Completions 的 function 嵌套层）
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
}

// --- 事件流解码 ---

interface OpenToolItem {
  id: string; // Responses 侧 item_id（流内归因键）
  callId: string; // tool_use↔tool_result 配对键（tool_end 事件与协议不变量以此）
  name: string;
}

async function* decodeResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LLMEvent> {
  let sawStart = false;
  let finished = false;
  // 开而未收的 function_call item：item_id → {callId, name}（乱序 delta 按 item_id 归因拼装）
  const openTools = new Map<string, OpenToolItem>();
  // —— reasoning 乱序重排缓冲（DoD① reasoning 乱序重排）——
  // 按 item（item_id）× part（summary_index|content_index，缺省 0）缓存增量；
  // 产出触发：该 part 的 done 到达（且前序 part 已产出）或统一收束（flushReasoningAll），
  // 后者按 index 升序冲刷（乱序到达→重排；同构 OpenCode 三态机 best-effort 语义，调研报告 §B2）。
  const reasoningParts = new Map<string, Map<number, string[]>>();
  const reasoningNextEmit = new Map<string, number>();
  const reasoningItemOrder: string[] = []; // 首见序（多 item 时稳定产出序）
  let sawReasoning = false;
  let reasoningText = "";

  function* emitPart(item: string, idx: number): Generator<LLMEvent> {
    const parts = reasoningParts.get(item);
    const chunks = parts?.get(idx);
    if (!chunks) return;
    parts!.delete(idx);
    for (const c of chunks) {
      reasoningText += c;
      yield { type: "thinking_delta", thinking: c };
    }
  }

  /** done 触发：冲刷该 item 从 nextEmit 起的连续 index 前缀（乱序下保序增量产出）。 */
  function* flushContiguous(item: string): Generator<LLMEvent> {
    const parts = reasoningParts.get(item);
    if (!parts) return;
    let next = reasoningNextEmit.get(item) ?? 0;
    while (parts.has(next)) {
      yield* emitPart(item, next);
      next++;
      reasoningNextEmit.set(item, next);
    }
  }

  /** 统一收束（text/tool/终局/流止）：全部余量按 index 升序冲刷 + thinking_end。 */
  function* flushReasoningAll(): Generator<LLMEvent> {
    for (const item of reasoningItemOrder) {
      const parts = reasoningParts.get(item);
      if (!parts) continue;
      const idxs = [...parts.keys()].sort((a, b) => a - b);
      for (const idx of idxs) yield* emitPart(item, idx);
    }
    if (sawReasoning) {
      sawReasoning = false;
      yield { type: "thinking_end", thinking: reasoningText };
      reasoningText = "";
    }
  }

  for await (const frame of parseSse(body)) {
    if (!frame.data) continue;
    let ev: any;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    // Responses SSE：type 字段为事件名（event: 行冗余，以 data.type 为准——两者同值）
    const type: string | undefined = ev.type ?? frame.event ?? undefined;
    if (!type) continue;

    if (type === "response.created" && !sawStart) {
      sawStart = true;
      yield { type: "message_start", id: ev.response?.id ?? null, model: ev.response?.model ?? "" };
      continue;
    }
    if (type === "response.output_text.delta") {
      yield* flushReasoningAll();
      yield { type: "text_delta", text: ev.delta ?? "" };
      continue;
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const item: string = ev.item_id ?? "";
      const idx: number = ev.summary_index ?? ev.content_index ?? 0;
      if (!reasoningParts.has(item)) {
        reasoningParts.set(item, new Map());
        reasoningItemOrder.push(item);
      }
      const parts = reasoningParts.get(item)!;
      if (!parts.has(idx)) parts.set(idx, []);
      parts.get(idx)!.push(ev.delta ?? "");
      sawReasoning = true;
      continue;
    }
    if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
      yield* flushContiguous(ev.item_id ?? "");
      continue;
    }
    if (type === "response.output_item.added" && ev.item?.type === "function_call") {
      yield* flushReasoningAll();
      const itemId: string = ev.item.id ?? "";
      const callId: string = ev.item.call_id ?? itemId;
      if (itemId && !openTools.has(itemId)) {
        openTools.set(itemId, { id: itemId, callId, name: ev.item.name ?? "" });
        yield { type: "tool_start", id: callId, name: ev.item.name ?? "" };
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const item = openTools.get(ev.item_id ?? "");
      if (item) yield { type: "tool_input_delta", id: item.callId, jsonPartial: ev.delta ?? "" };
      continue;
    }
    if (type === "response.function_call_arguments.done") continue; // 拼装以 delta 累积为准，done 不重发
    if (type === "response.completed" || type === "response.incomplete") {
      if (!finished) {
        yield* flushReasoningAll();
        finished = true;
        // 终局 finish 语义：有工具调用 → tool_calls（同 Anthropic stop_reason=tool_use 先例，
        // harness 工具轮回灌驱动在 tool_use 块不在 finish）；无工具按 status 映射。
        const hasTools = openTools.size > 0;
        // 收束全部开工具（tool_end 以 call_id 发——与 tool_start/tool_input_delta 同键）
        for (const item of openTools.values()) yield { type: "tool_end", id: item.callId };
        openTools.clear();
        let reason: string;
        if (type === "response.incomplete") {
          reason = INCOMPLETE_REASON_TO_IR[ev.response?.incomplete_details?.reason ?? ""] ?? "truncated";
        } else {
          reason = hasTools ? "tool_calls" : "completed";
        }
        yield { type: "finish", reason: reason as ProviderFinishReason, raw: type === "response.incomplete" ? "incomplete" : "completed" };
      }
      // usage 与 finish 容忍分离两帧（completed 自带 usage 则此处产出）；重复帧不重复发 finish
      const usage = ev.response?.usage;
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreationTokens: 0,
            cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          },
        };
      }
      continue;
    }
    if (type === "response.failed") {
      const err = ev.response?.error ?? {};
      const code: string | undefined = err.code ?? undefined;
      if (code === "context_length_exceeded" || code === "model_context_window_exceeded") {
        // 前者=Codex is_context_window_error（responses.rs:680-682）；后者=§2 行 M3 吸收清单映射词。
        // harness 侧 kind==="context_length" 路由 context_exhausted（agent-loop.ts:351）。
        yield { type: "error", error: new ProviderError("context_length", String(err.message ?? "context length exceeded")) };
        return;
      }
      yield { type: "error", error: new ProviderError("unknown", String(err.message ?? "response.failed event received")) };
      return;
    }
    // 其余事件（response.in_progress / output_text.done / content_part.* / reasoning_summary_part.added
    // 等白名单外帧）忽略——同 Codex 忽略分支（responses.rs:497-507）
  }
  if (sawStart && !finished) {
    // 流止未发 completed/failed（截断）：unknown 语义（与 openai.ts 同构）
    yield* flushReasoningAll();
    for (const item of openTools.values()) yield { type: "tool_end", id: item.callId };
    openTools.clear();
    yield { type: "finish", reason: "unknown", raw: null };
  }
  if (!sawStart) {
    yield { type: "error", error: new ProviderError("unknown", "stream ended before first event") };
  }
}

// --- 适配器 ---

export class ResponsesAdapter implements ProviderAdapter {
  private readonly models: Map<string, OpenAIModelEntry>;
  private readonly opts: ProviderOptions;

  constructor(models: Record<string, OpenAIModelEntry>, opts: ProviderOptions) {
    this.models = new Map(Object.entries(models));
    this.opts = opts;
  }

  capabilities(model: string): ModelCapabilities {
    const entry = this.models.get(model);
    if (!entry) throw new Error(`unknown model: ${model}`);
    return responsesCapabilities(entry);
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMEvent> {
    const caps = this.capabilities(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      max_output_tokens: req.maxTokens ?? caps.maxOutputTokens.default,
    };
    if (req.system) body.instructions = req.system; // CTX-009：Responses 需 instructions 顶层字段
    body.input = encodeInputResponses(req.messages);
    if (req.tools?.length) body.tools = encodeToolsResponses(req.tools);
    // WP-11 toolChoice IR→Responses wire（"auto"/"required"/{type:"function",name}，缺省不发）。
    if (req.toolChoice) {
      body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", name: req.toolChoice.name };
    }

    const res = await withRetry(
      () =>
        doFetch(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/responses`, req.signal, this.opts, {
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
    yield* decodeResponsesStream(res.body!);
  }

  async countTokens(req: LLMRequest): Promise<number> {
    // 本地估算，同 Anthropic/OpenAI 侧口径（§13 行 1：API usage 对账为准、本地估算标注误差）。
    return Math.ceil(JSON.stringify(req).length / 4);
  }
}
