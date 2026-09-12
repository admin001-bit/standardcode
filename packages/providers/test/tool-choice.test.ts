// WP-11（M3）generateObject 强制合成工具调用（v2.8 §2 行 M3 吸收清单 :111；落点由本卡 X 定=
// LLMRequest.toolChoice 协议无关 IR+三 adapter wire 映射）。判据面：wire 形状逐协议钉死+缺省不发
// （M1/M2 行为兼容）+generateObject 端到端形态（单工具 schema+强制调用→tool_use input JSON=合成对象）。
import { describe, expect, it } from "vitest";
import type { LLMRequest } from "../src/types.ts";
import { AnthropicAdapter } from "../src/anthropic.ts";
import { OpenAIChatAdapter } from "../src/openai.ts";
import { ResponsesAdapter } from "../src/responses.ts";
import { collect, sseResponse } from "./helpers.ts";

const ANTH_MODEL = {
  "claude-test-1": { contextWindow: 200000, maxOutputTokens: { default: 8192, upper: 32000 }, thinking: "none" as const, input: ["text"] as Array<"text" | "image"> },
};
const OPENAI_MODEL = {
  "gpt-test": { contextWindow: 128000, maxOutputTokens: { default: 4096, upper: 16384 }, thinking: "none" as const, input: ["text"] as Array<"text" | "image"> },
};

const OBJ_TOOL = { name: "generate_object", description: "Emit the requested structured object as tool input.", inputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } };

const ANTH_OK = `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"claude-test-1","usage":{"input_tokens":5,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"generate_object","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"answer\\":\\"42\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}

`;

function captureBody(): { bodies: Record<string, unknown>[]; fetchImpl: typeof globalThis.fetch } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(ANTH_OK);
    }) as typeof globalThis.fetch,
  };
}

async function runAnthropic(req: Partial<LLMRequest>) {
  const cap = captureBody();
  const a = new AnthropicAdapter(ANTH_MODEL, { apiKey: "k", fetchImpl: cap.fetchImpl });
  const events = await collect(a.stream({ model: "claude-test-1", messages: [{ role: "user", content: [{ type: "text", text: "answer?" }] }], ...req } as LLMRequest));
  return { body: cap.bodies[0]!, events };
}

describe("toolChoice IR→Anthropic wire", () => {
  it("auto/required/具名三型映射（auto→{type:auto}/required→{type:any}/tool→{type:tool,name}）；缺省不发", async () => {
    expect((await runAnthropic({ toolChoice: "auto" })).body.tool_choice).toEqual({ type: "auto" });
    expect((await runAnthropic({ toolChoice: "required" })).body.tool_choice).toEqual({ type: "any" });
    expect((await runAnthropic({ toolChoice: { type: "tool", name: "generate_object" } })).body.tool_choice).toEqual({ type: "tool", name: "generate_object" });
    expect((await runAnthropic({})).body.tool_choice).toBeUndefined(); // 缺省不发（M1 行为兼容）
  });

  it("generateObject 端到端形态：单工具+强制具名→请求含形状+回复 tool_use input 即合成对象", async () => {
    const { body, events } = await runAnthropic({ tools: [OBJ_TOOL], toolChoice: { type: "tool", name: "generate_object" } });
    expect(body.tools).toBeDefined();
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.tool_choice).toEqual({ type: "tool", name: "generate_object" });
    const toolUse = events.find((e) => e.type === "tool_start");
    expect(toolUse).toMatchObject({ type: "tool_start", name: "generate_object" });
    const json = events.filter((e) => e.type === "tool_input_delta").map((e: { jsonPartial?: string }) => e.jsonPartial ?? "").join("");
    expect(JSON.parse(json)).toEqual({ answer: "42" }); // 合成对象=强制工具调用 input 的 JSON
  });
});

describe("toolChoice IR→OpenAI Chat / Responses wire", () => {
  it("Chat：auto/required 字符串直传；具名→{type:function,function:{name}}；缺省不发", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(`data: {"id":"c","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    }) as typeof globalThis.fetch;
    const a = new OpenAIChatAdapter(OPENAI_MODEL, { apiKey: "k", fetchImpl });
    for (const tc of ["auto", "required", { type: "tool", name: "generate_object" }] as const) {
      await collect(a.stream({ model: "gpt-test", messages: [], toolChoice: tc } as LLMRequest));
    }
    await collect(a.stream({ model: "gpt-test", messages: [] } as LLMRequest));
    expect(bodies[0]!.tool_choice).toBe("auto");
    expect(bodies[1]!.tool_choice).toBe("required");
    expect(bodies[2]!.tool_choice).toEqual({ type: "function", function: { name: "generate_object" } });
    expect(bodies[3]!.tool_choice).toBeUndefined();
  });

  it("Responses：auto/required 字符串；具名→{type:function,name}（无 function 嵌套）；缺省不发", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(`data: {"type":"response.created","response":{"id":"r"}}\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n`);
    }) as typeof globalThis.fetch;
    const a = new ResponsesAdapter(OPENAI_MODEL, { apiKey: "k", fetchImpl });
    for (const tc of ["auto", "required", { type: "tool", name: "generate_object" }] as const) {
      await collect(a.stream({ model: "gpt-test", messages: [], toolChoice: tc } as LLMRequest));
    }
    await collect(a.stream({ model: "gpt-test", messages: [] } as LLMRequest));
    expect(bodies[0]!.tool_choice).toBe("auto");
    expect(bodies[1]!.tool_choice).toBe("required");
    expect(bodies[2]!.tool_choice).toEqual({ type: "function", name: "generate_object" });
    expect(bodies[3]!.tool_choice).toBeUndefined();
  });
});
