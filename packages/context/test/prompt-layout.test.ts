// WP-04 测试：M1 四分段惰性求值 / cacheScope / 追加式注入 / 能力退化两协议打点 / 单测快照（Golden 代位）。
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "@standardcode/providers";
import { OpenAIChatAdapter } from "@standardcode/providers";
import { buildSegments, materializeLayout, type BuildLayoutInput } from "../src/prompt-layout/layout.ts";

const CAPS_ANTHROPIC = {
  contextWindow: 200000,
  maxOutputTokens: { default: 32000, upper: 128000 },
  thinking: "adaptive" as const,
  input: ["text" as const],
  streaming: true,
  toolCalling: true,
  cache: { ttlLevels: ["5m", "1h"] as Array<"5m" | "1h">, explicitBreakpoints: true },
};
const CAPS_OPENAI = {
  ...CAPS_ANTHROPIC,
  thinking: "none" as const,
  cache: { ttlLevels: [] as Array<"5m" | "1h">, explicitBreakpoints: false },
};

function makeInput(overrides?: Partial<BuildLayoutInput>): BuildLayoutInput {
  return {
    identity: "You are StandardCode.",
    tools: [
      { name: "Read", description: "read a file" },
      { name: "Bash", description: "run a command" },
    ],
    dynamic: [{ text: "disk almost full" }],
    history: [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ],
    capabilities: CAPS_ANTHROPIC,
    ...overrides,
  };
}

describe("CTX-100 M1 四分段", () => {
  it("分段名与顺序：identity → tools → dynamic → history", () => {
    const segs = buildSegments(makeInput());
    expect(segs.map((s) => s.name)).toEqual(["identity", "tools", "dynamic", "history"]);
  });

  it("cacheScope 映射：org/global/dynamic/dynamic（CTX-004 枚举内）", () => {
    const segs = buildSegments(makeInput());
    expect(segs.map((s) => s.cacheScope)).toEqual(["org", "global", "dynamic", "dynamic"]);
  });

  it("惰性求值：segments() 不触发 compute；materialize 恰好各调一次且按序", () => {
    const calls: string[] = [];
    const segs = buildSegments(makeInput()).map((s) => ({
      ...s,
      compute: () => {
        calls.push(s.name);
        return s.compute();
      },
    }));
    expect(calls).toEqual([]); // 未物化，零求值
    materializeLayout(segs, makeInput());
    expect(calls).toEqual(["identity", "tools", "dynamic", "history"]); // 按序各一次
  });

  it("materialize：system=identity 段；动态注入以 <system-reminder> isMeta user 前插", () => {
    const out = materializeLayout(buildSegments(makeInput()), makeInput());
    expect(out.system).toBe("You are StandardCode.");
    expect(out.messages[0]).toMatchObject({ role: "user", isMeta: true });
    expect(JSON.stringify(out.messages[0])).toContain("<system-reminder>disk almost full</system-reminder>");
    // 历史在前插之后保持原序
    expect((out.messages[1].content as Array<{ text: string }>)[0].text).toBe("q1");
    expect(out.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("CTX-005 追加不改写：原数组与消息对象引用原样保留", () => {
    const input = makeInput();
    const originalMessages = input.history;
    const originalUserMsg = input.history[2];
    const out = materializeLayout(buildSegments(input), input);
    expect(out.messages.length).toBe(originalMessages.length + 1); // 新数组
    expect(Object.is(out.messages.at(-1), originalUserMsg)).toBe(true); // 引用未变
    expect(JSON.stringify(originalMessages)).not.toContain("system-reminder"); // 原内容未被改写
  });

  it("单测快照（WP-10 Golden 建立前的代位，卡边界）", () => {
    const out = materializeLayout(buildSegments(makeInput()), makeInput());
    expect(out.system).toMatchSnapshot();
    expect(out.segments).toMatchSnapshot();
  });
});

describe("CTX-004 能力退化：两协议打点断言（DoD③）", () => {
  const sse = `event: message_start
data: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

`;
  const sseOpenAI = `data: {"id":"c","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`;

  it("explicitBreakpoints=true（Anthropic）：请求体末条 user 末块带 cache_control", async () => {
    let captured: any;
    const models = { "claude-sonnet-4-6": { contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none" as const, input: ["text"] as Array<"text"> } };
    const a = new AnthropicAdapter(models, {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        captured = JSON.parse(init!.body as string);
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200 });
      },
    });
    const layout = materializeLayout(buildSegments(makeInput()), makeInput());
    const history = layout.messages;
    await (async () => {
      for await (const _ of a.stream({ model: "claude-sonnet-4-6", system: layout.system, messages: history as never })) void _;
    })();
    const lastUser = captured.messages.filter((m: any) => m.role === "user").at(-1);
    expect(lastUser.content.at(-1)).toHaveProperty("cache_control");
  });

  it("explicitBreakpoints=false（OpenAI 兼容）：请求体零 cache_control", async () => {
    let captured: any;
    const models = { "gpt-test": { contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none" as const, input: ["text"] as Array<"text"> } };
    const a = new OpenAIChatAdapter(models, {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        captured = JSON.parse(init!.body as string);
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sseOpenAI)); c.close(); } }), { status: 200 });
      },
    });
    const layout = materializeLayout(buildSegments(makeInput()), makeInput());
    await (async () => {
      for await (const _ of a.stream({ model: "gpt-test", system: layout.system, messages: layout.messages as never })) void _;
    })();
    expect(JSON.stringify(captured)).not.toContain("cache_control");
    // 动态注入以 system-reminder 文本随消息进入请求（isMeta 为内部记账字段，不上 API——由编码侧剥离）
    expect(JSON.stringify(captured.messages)).toContain("system-reminder");
  });
});
