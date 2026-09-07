import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.ts";
import { collect, sseResponse } from "./helpers.ts";

const MODELS = {
  "claude-sonnet-4-6": {
    contextWindow: 200000,
    maxOutputTokens: { default: 32000, upper: 128000 },
    thinking: "adaptive" as const,
    input: ["text", "image"] as Array<"text" | "image">,
  },
};

function adapter(fetchImpl: typeof fetch) {
  return new AnthropicAdapter(MODELS, { apiKey: "test-key", fetchImpl });
}

// 回放夹具①：文本 + 工具调用 + usage + stop_reason 全链（形状按官方流式协议）
const TOOL_FIXTURE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-6","usage":{"input_tokens":120,"output_tokens":1,"cache_creation_input_tokens":53,"cache_read_input_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"看一"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"下文件"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"Read","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}

`;

describe("AnthropicAdapter SSE 回放", () => {
  it("夹具①：文本+工具+usage+finish 全链事件序", async () => {
    const calls: string[] = [];
    const a = adapter(async (url, init) => {
      calls.push(String(url));
      return sseResponse(TOOL_FIXTURE);
    });
    const events = await collect(
      a.stream({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );

    expect(events[0]).toMatchObject({ type: "message_start", id: "msg_01", model: "claude-sonnet-4-6" });
    expect(events[1]).toMatchObject({ type: "usage", usage: { inputTokens: 120, outputTokens: 1, cacheCreationTokens: 53, cacheReadTokens: 0 } });
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("看一下文件");
    expect(events).toContainEqual({ type: "tool_start", id: "toolu_01", name: "Read" });
    // input_json_delta 按 index 关联 tool id
    expect(events.filter((e) => e.type === "tool_input_delta").every((e: any) => e.id === "toolu_01")).toBe(true);
    expect(events.filter((e) => e.type === "tool_input_delta").map((e: any) => e.jsonPartial).join("")).toBe('{"file_path":"a.txt"}');
    expect(events).toContainEqual({ type: "tool_end", id: "toolu_01" });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls", raw: "tool_use" });
    // message_delta 的 usage 合并（input 保留、output 更新）
    const lastUsage = events.filter((e) => e.type === "usage").at(-1) as any;
    expect(lastUsage.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 });
    // 请求打点：端点/头/体
    expect(calls[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("显式缓存打点：末条 user 消息末块挂 cache_control（CTX-004 true 路径）", async () => {
    let captured: any;
    const a = adapter(async (_url, init) => {
      captured = JSON.parse(init!.body as string);
      return sseResponse(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
      );
    });
    await collect(
      a.stream({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: [{ type: "text", text: "q1" }] },
          { role: "assistant", content: [{ type: "text", text: "a1" }] },
          { role: "user", content: [{ type: "text", text: "q2" }] },
        ],
      }),
    );
    const msgs = captured.messages;
    expect(msgs[0].content[0]).not.toHaveProperty("cache_control");
    expect(msgs[2].content[0]).toHaveProperty("cache_control");
  });

  it("stop_reason=end_turn → completed；max_tokens → truncated", async () => {
    const mk = (stop: string) =>
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stop}"},"usage":{"output_tokens":2}}\n\n`;
    const run = async (stop: string) => {
      const a = adapter(async () => sseResponse(mk(stop)));
      return (await collect(a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))).at(-1);
    };
    expect(await run("end_turn")).toEqual({ type: "finish", reason: "completed", raw: "end_turn" });
    expect(await run("max_tokens")).toEqual({ type: "finish", reason: "truncated", raw: "max_tokens" });
  });

  it("流截断（无 message_start）→ error 事件（恢复链④输入）", async () => {
    const a = adapter(async () => sseResponse(`event: ping\ndata: {"type":"ping"}\n\n`));
    const events = await collect(a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events.at(-1)?.type).toBe("error");
  });

  it("多工具并行：两 tool_use 块各得 start/delta(id 关联)/end", async () => {
    const fixture = `event: message_start
data: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t2","name":"Glob","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}

`;
    const a = adapter(async () => sseResponse(fixture));
    const events = await collect(a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }));
    expect(events.filter((e) => e.type === "tool_start")).toEqual([
      { type: "tool_start", id: "t1", name: "Read" },
      { type: "tool_start", id: "t2", name: "Glob" },
    ]);
    expect(events.filter((e) => e.type === "tool_end")).toEqual([
      { type: "tool_end", id: "t1" },
      { type: "tool_end", id: "t2" },
    ]);
  });
});
