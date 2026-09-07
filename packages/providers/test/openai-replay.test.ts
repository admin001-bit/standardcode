import { describe, expect, it } from "vitest";
import { OpenAIChatAdapter } from "../src/openai.ts";
import { collect, sseResponse } from "./helpers.ts";

const MODELS = {
  "gpt-test": {
    contextWindow: 128000,
    maxOutputTokens: { default: 4096, upper: 16384 },
    thinking: "none" as const,
    input: ["text"] as Array<"text" | "image">,
  },
  "deepseek-test": {
    contextWindow: 64000,
    maxOutputTokens: { default: 4096, upper: 8192 },
    thinking: "adaptive" as const,
    input: ["text"] as Array<"text" | "image">,
    reasoningDialect: "auto" as const,
  },
};

function adapter(fetchImpl: typeof fetch) {
  return new OpenAIChatAdapter(MODELS, { apiKey: "test-key", fetchImpl });
}

// 回放夹具②：文本 + 工具调用 + usage + finish_reason（形状按 Chat Completions 流式协议）
const TOOL_FIXTURE = `data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"He"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Bash","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"chatcmpl-1","model":"gpt-test","choices":[],"usage":{"prompt_tokens":88,"completion_tokens":23,"prompt_tokens_details":{"cached_tokens":64}}}

data: [DONE]

`;

describe("OpenAIChatAdapter SSE 回放", () => {
  it("夹具②：文本+工具+usage+finish 全链事件序", async () => {
    const calls: string[] = [];
    const a = adapter(async (url) => {
      calls.push(String(url));
      return sseResponse(TOOL_FIXTURE);
    });
    const events = await collect(
      a.stream({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );

    expect(events[0]).toMatchObject({ type: "message_start", id: "chatcmpl-1", model: "gpt-test" });
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Hello");
    expect(events).toContainEqual({ type: "tool_start", id: "call_1", name: "Bash" });
    // 回归（WP-01 V 跑偏#1）：后续增量只带 index 不带 id，仍须归因到 call_1
    expect(events.filter((e) => e.type === "tool_input_delta").map((e: any) => e.jsonPartial).join("")).toBe('{"command":"ls"}');
    expect(events.filter((e) => e.type === "tool_input_delta").every((e: any) => e.id === "call_1")).toBe(true);
    expect(events).toContainEqual({ type: "tool_end", id: "call_1" });
    // OpenAI 协议：usage 块在 finish_reason 帧之后到达 → finish 先于 usage
    expect(events[events.length - 2]).toEqual({ type: "finish", reason: "tool_calls", raw: "tool_calls" });
    expect(events.at(-1)).toMatchObject({ type: "usage" });
    const usage = events.filter((e) => e.type === "usage").at(-1) as any;
    expect(usage.usage).toEqual({ inputTokens: 88, outputTokens: 23, cacheCreationTokens: 0, cacheReadTokens: 64 });
    expect(calls[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("零 cache_control：请求体不含缓存字段（CTX-004 false 路径）", async () => {
    let captured: any;
    const a = adapter(async (_url, init) => {
      captured = JSON.parse(init!.body as string);
      return sseResponse(`data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    });
    await collect(a.stream({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(JSON.stringify(captured)).not.toContain("cache_control");
    expect(captured.stream).toBe(true);
    expect(captured.stream_options).toEqual({ include_usage: true });
  });

  it("tool_result → tool 角色；assistant tool_use → tool_calls（IR 编码对质）", async () => {
    let captured: any;
    const a = adapter(async (_url, init) => {
      captured = JSON.parse(init!.body as string);
      return sseResponse(`data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    });
    await collect(
      a.stream({
        model: "gpt-test",
        messages: [
          { role: "user", content: [{ type: "text", text: "run" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "call_9", content: "ok" }] },
          { role: "user", content: [{ type: "text", text: "thanks" }] },
        ],
      }),
    );
    const msgs = captured.messages;
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "run" }] });
    expect(msgs[1].tool_calls[0].function).toEqual({ name: "Bash", arguments: '{"command":"ls"}' });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "call_9", content: "ok" });
    expect(msgs[3]).toEqual({ role: "user", content: [{ type: "text", text: "thanks" }] });
  });

  it("方言 auto：reasoning_content 流内探测回显（DeepSeek 形状）", async () => {
    const a = adapter(async () =>
      sseResponse(
        `data: {"id":"d","model":"deepseek-test","choices":[{"index":0,"delta":{"reasoning_content":"想"},"finish_reason":null}]}\n\ndata: {"id":"d","model":"deepseek-test","choices":[{"index":0,"delta":{"content":"答"},"finish_reason":null}]}\n\ndata: {"id":"d","model":"deepseek-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      ),
    );
    const events = await collect(a.stream({ model: "deepseek-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events).toContainEqual({ type: "thinking_delta", thinking: "想" });
    expect(events).toContainEqual({ type: "text_delta", text: "答" });
  });

  it("流截断：有 start 无 finish_reason → finish{unknown}", async () => {
    const a = adapter(async () =>
      sseResponse(`data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{"content":"par"},"finish_reason":null}]}\n\n`),
    );
    const events = await collect(a.stream({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "unknown", raw: null });
  });

  it("回归（V 跑偏#1）：并行双工具增量只带 index 不带 id，按 index 各自归因", async () => {
    const a = adapter(async () =>
      sseResponse(
        `data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Bash","arguments":""}}]},"finish_reason":null}]}\n\ndata: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}\n\ndata: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"c\\":"}}]},"finish_reason":null}]}\n\ndata: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"f\\":"}}]},"finish_reason":null}]}\n\ndata: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
      ),
    );
    const events = await collect(a.stream({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events.filter((e) => e.type === "tool_input_delta")).toEqual([
      { type: "tool_input_delta", id: "call_a", jsonPartial: '{"c":' },
      { type: "tool_input_delta", id: "call_b", jsonPartial: '{"f":' },
    ]);
    expect(events.filter((e) => e.type === "tool_end")).toEqual([
      { type: "tool_end", id: "call_a" },
      { type: "tool_end", id: "call_b" },
    ]);
  });

  it("length/content_filter 映射", async () => {
    const run = async (fr: string) => {
      const a = adapter(async () =>
        sseResponse(`data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"${fr}"}]}\n\ndata: [DONE]\n\n`),
      );
      return (await collect(a.stream({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))).at(-1);
    };
    expect(await run("length")).toEqual({ type: "finish", reason: "truncated", raw: "length" });
    expect(await run("content_filter")).toEqual({ type: "finish", reason: "filtered", raw: "content_filter" });
  });
});
