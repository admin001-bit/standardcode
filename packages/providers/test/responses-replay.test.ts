// WP-02 契约回放测试（v2.8 §12.2 契约层：SSE 帧→事件 IR；判据自足：板 WP-02 DoD①-④ 逐条）。
// 形状实证锚点：Codex codex-api/src/sse/responses.rs（事件面/usage 可缺省 841-858/乱序 best-effort）
// + OpenCode reasoning 三态机（调研报告_Codex沙箱与OpenCode-Provider.md §B2）+ CTX-009 instructions。

import { describe, expect, it } from "vitest";
import { ResponsesAdapter, parseWireApi, responsesCapabilities, encodeInputResponses } from "../src/responses.ts";
import { ProviderError } from "../src/errors.ts";
import { collect, sseResponse } from "./helpers.ts";
import type { LLMMessage } from "../src/types.ts";

const MODELS = {
  "gpt-resp": {
    contextWindow: 128000,
    maxOutputTokens: { default: 4096, upper: 16384 },
    thinking: "none" as const,
    input: ["text"] as Array<"text" | "image">,
  },
};

function adapter(fetchImpl: typeof fetch) {
  return new ResponsesAdapter(MODELS, { apiKey: "test-key", fetchImpl });
}

// 帧 helper：Responses SSE 以 data.type 为事件名（event: 行冗余）
const f = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("ResponsesAdapter 契约回放（DoD①）", () => {
  it("夹具：文本+工具+usage 全链事件序（input_json_delta 拼装/双事件结束）", async () => {
    // 事件序列按 Codex responses.rs 测试夹具形制：created → output_item.added → arguments.delta×2 → completed(usage 同帧)
    const frames = [
      f({ type: "response.created", response: { id: "resp_1", model: "gpt-resp" } }),
      f({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash" } }),
      f({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"comm' }),
      f({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'and":"ls"}' }),
      // 双事件结束（Bedrock 式）：finish 帧（无 usage）+ usage 分离帧——finish 恰一次，
      // usage 晚到仍收账（Codex completed 的 token_usage 可缺省 rs:841-858 的分离形态镜像）
      f({ type: "response.completed", response: { id: "resp_1" } }),
      f({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 88, output_tokens: 23, input_tokens_details: { cached_tokens: 64 } } } }),
    ].join("");
    const a = adapter(async () => sseResponse(frames));
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));

    expect(events[0]).toMatchObject({ type: "message_start", id: "resp_1", model: "gpt-resp" });
    expect(events).toContainEqual({ type: "tool_start", id: "call_1", name: "Bash" });
    // input_json_delta 拼装：增量按 item_id 归因、tool_input_delta 携带 call_id
    expect(events.filter((e) => e.type === "tool_input_delta").map((e: any) => e.jsonPartial).join("")).toBe('{"command":"ls"}');
    expect(events.filter((e) => e.type === "tool_input_delta").every((e: any) => e.id === "call_1")).toBe(true);
    expect(events).toContainEqual({ type: "tool_end", id: "call_1" });
    // 工具轮 finish=tool_calls（Anthropic stop_reason=tool_use 同构）；分离两帧下 finish 恰一次
    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toEqual([{ type: "finish", reason: "tool_calls", raw: "completed" }]);
    const usage = events.find((e) => e.type === "usage") as any;
    expect(usage.usage).toEqual({ inputTokens: 88, outputTokens: 23, cacheCreationTokens: 0, cacheReadTokens: 64 });
  });

  it("纯文本轮：instructions 顶层字段 + input 编码（CTX-009）", async () => {
    let captured: any;
    const a = adapter(async (_url, init) => {
      captured = JSON.parse(init!.body as string);
      return sseResponse(
        f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }) +
          f({ type: "response.output_text.delta", delta: "Hel" }) +
          f({ type: "response.output_text.delta", delta: "lo" }) +
          f({ type: "response.completed", response: { id: "r" } }), // usage 缺省（Codex 实证面）
      );
    });
    const events = await collect(
      a.stream({
        model: "gpt-resp",
        system: "You are StandardCode.",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );
    // CTX-009：system → instructions 顶层字段（无 system 消息）
    expect(captured.instructions).toBe("You are StandardCode.");
    expect(JSON.stringify(captured)).not.toContain('"role":"system"');
    expect(captured.model).toBe("gpt-resp");
    expect(captured.stream).toBe(true);
    expect(captured.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Hello");
    expect((events.find((e) => e.type === "finish") as any).reason).toBe("completed");
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });

  it("DoD① reasoning 乱序重排：text→reasoning(2 段乱序 summary)→text，产出按 index 升序", async () => {
    const frames = [
      f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }),
      // 先到 text（触发缓冲冲刷点：reasoning 未产出前不阻塞）
      f({ type: "response.output_text.delta", delta: "A" }),
      // summary part 1 先于 part 0 到达（乱序）——缓冲不即时产出
      f({ type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 1, delta: "B" }),
      f({ type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: "C" }),
      // part 0 done：连续前缀（index 0）产出；part 1 尚缓冲
      f({ type: "response.reasoning_summary_text.done", item_id: "rs", summary_index: 0 }),
      // 迟到的 reasoning 再到 text：收束余量
      f({ type: "response.output_text.delta", delta: "D" }),
      f({ type: "response.completed", response: { id: "r" } }),
    ].join("");
    const a = adapter(async () => sseResponse(frames));
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e: any) => e.thinking);
    // 乱序到达按 index 重排：C(part0) 先产出，B(part1) 在收束点冲刷
    expect(thinking).toEqual(["C", "B"]);
    // thinking_end 累积全块（顺序=B+C 语义的到达序拼接：缓冲产出序 C→B）
    expect((events.find((e) => e.type === "thinking_end") as any).thinking).toBe("CB");
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("AD");
  });

  it("reasoning_text.delta（content_index 形状）与 summary 形状同通道", async () => {
    const frames = [
      f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }),
      f({ type: "response.reasoning_text.delta", item_id: "rt", content_index: 0, delta: "想" }),
      f({ type: "response.reasoning_text.done", item_id: "rt", content_index: 0 }),
      f({ type: "response.completed", response: { id: "r" } }),
    ].join("");
    const a = adapter(async () => sseResponse(frames));
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events).toContainEqual({ type: "thinking_delta", thinking: "想" });
    expect(events).toContainEqual({ type: "thinking_end", thinking: "想" });
  });
});

describe("错误映射（DoD②）", () => {
  it("response.failed code=model_context_window_exceeded → error{context_length}（吸收清单映射）", async () => {
    const a = adapter(async () =>
      sseResponse(
        f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }) +
          f({ type: "response.failed", response: { error: { code: "model_context_window_exceeded", message: "context window exceeded" } } }),
      ),
    );
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    const err = events.find((e) => e.type === "error") as any;
    expect(err.error).toBeInstanceOf(ProviderError);
    expect(err.error.kind).toBe("context_length");
    // harness 路由对质：agent-loop.ts:351 isContextLength 以 kind==="context_length" 判定
  });

  it("response.failed code=context_length_exceeded → error{context_length}（Codex 先例码）", async () => {
    const a = adapter(async () =>
      sseResponse(f({ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "too long" } } })),
    );
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect((events.find((e) => e.type === "error") as any).error.kind).toBe("context_length");
  });

  it("HTTP 400 体含 model_context_window_exceeded → classifyHttpError kind=context_length", async () => {
    const a = adapter(async () => new Response(JSON.stringify({ error: { code: "model_context_window_exceeded" } }), { status: 400 }));
    await expect(collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))).rejects.toMatchObject({
      kind: "context_length",
    });
  });
});

describe("wire_api 配置键（DoD③）", () => {
  it("parseWireApi：缺省 chat、responses 显式、非法值 fail-closed", () => {
    expect(parseWireApi(undefined)).toBe("chat");
    expect(parseWireApi("")).toBe("chat");
    expect(parseWireApi("chat")).toBe("chat");
    expect(parseWireApi("responses")).toBe("responses");
    expect(parseWireApi(" RESPONSES ")).toBe("responses");
    expect(() => parseWireApi("grpc")).toThrow(/wire_api/);
  });

  it("buildProvider 缺省不回归：openai+wire_api 缺省仍为 chat 线（session 侧断言在 apps/cli）", () => {
    // 本仓契约：ResponsesAdapter 与 OpenAIChatAdapter 可按线制并存实例化
    const a = new ResponsesAdapter(MODELS, { apiKey: "k" });
    expect(responsesCapabilities(MODELS["gpt-resp"])).toMatchObject({ streaming: true, toolCalling: true, cache: { explicitBreakpoints: false } });
    expect(a.capabilities("gpt-resp").contextWindow).toBe(128000);
  });
});

describe("协议不变量（DoD④）：tool_use↔tool_result 配对编码", () => {
  it("encodeInputResponses：assistant function_call ↔ user function_call_output 按 call_id 配对", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "run" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_9", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    const input = encodeInputResponses(messages);
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "run" }] },
      { type: "function_call", call_id: "call_9", name: "Bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "call_9", output: "ok" },
      { role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
    // 配对不变量：每个 function_call_output 的 call_id 都有前序 function_call
    const calls = new Set(input.filter((x: any) => x.type === "function_call").map((x: any) => x.call_id));
    for (const out of input.filter((x: any) => x.type === "function_call_output") as Array<{ call_id: string }>) {
      expect(calls.has(out.call_id)).toBe(true);
    }
  });

  it("流级不变量：双工具乱序 delta→tool_end 各自配对收束", async () => {
    const frames = [
      f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }),
      f({ type: "response.output_item.added", item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "Bash" } }),
      f({ type: "response.output_item.added", item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "Read" } }),
      f({ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: '{"f":1}' }),
      f({ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"c":"x"}' }),
      f({ type: "response.completed", response: { id: "r" } }),
    ].join("");
    const a = adapter(async () => sseResponse(frames));
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    // 增量按 item_id 归因不串线
    expect(events.filter((e) => e.type === "tool_input_delta")).toEqual([
      { type: "tool_input_delta", id: "call_b", jsonPartial: '{"f":1}' },
      { type: "tool_input_delta", id: "call_a", jsonPartial: '{"c":"x"}' },
    ]);
    // tool_start/tool_end 数量一致（无孤儿 tool_use）
    const starts = events.filter((e) => e.type === "tool_start").map((e: any) => e.id);
    const ends = events.filter((e) => e.type === "tool_end").map((e: any) => e.id);
    expect(starts.sort()).toEqual(["call_a", "call_b"]);
    expect(ends.sort()).toEqual(["call_a", "call_b"]);
  });

  it("流截断：无 completed/failed → 余量收束 + finish{unknown}（恢复链④输入面）", async () => {
    const frames = [
      f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }),
      f({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash" } }),
      f({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"c"' }),
      // 流止：无 completed
    ].join("");
    const a = adapter(async () => sseResponse(frames));
    const events = await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "unknown", raw: null });
    // 截断轮工具调用仍收束 tool_end（harness 未终止调用语义：入历史+error tool_result）
    expect(events).toContainEqual({ type: "tool_end", id: "call_1" });
  });

  it("incomplete 终局按 reason 细分：max_output_tokens→truncated / content_filter→filtered", async () => {
    const run = async (reason: string) => {
      const a = adapter(async () =>
        sseResponse(
          f({ type: "response.created", response: { id: "r", model: "gpt-resp" } }) +
            f({ type: "response.incomplete", response: { id: "r", incomplete_details: { reason } } }),
        ),
      );
      return (await collect(a.stream({ model: "gpt-resp", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))).find((e) => e.type === "finish");
    };
    expect(await run("max_output_tokens")).toEqual({ type: "finish", reason: "truncated", raw: "incomplete" });
    expect(await run("content_filter")).toEqual({ type: "finish", reason: "filtered", raw: "incomplete" });
  });
});
