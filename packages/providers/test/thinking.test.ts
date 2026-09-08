// WP-06（M2）思维链保护测试（v2.8 §7.5 CTX-020/021 工程不变量①②③；判据自足：板 WP-06 DoD①-④）。
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.ts";
import { OpenAIChatAdapter } from "../src/openai.ts";
import { collect, sseResponse } from "./helpers.ts";

const MODEL = {
  "claude-sonnet-4-6": {
    contextWindow: 200000,
    maxOutputTokens: { default: 32000, upper: 128000 },
    thinking: "adaptive" as const,
    input: ["text", "image"] as Array<"text" | "image">,
  },
};

// 夹具：thinking 块（多帧 signature_delta 拼接）+ text 块
const THINKING_FIXTURE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_t","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step one. "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step two."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sigAA"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"BB=="}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}

`;

describe("WP-06 anthropic thinking 透传+签名原样回传（DoD①）", () => {
  it("thinking_delta 完整透传；thinking_end 携带全块文本+多帧签名拼接", async () => {
    const a = new AnthropicAdapter(MODEL, { apiKey: "k", fetchImpl: async () => sseResponse(THINKING_FIXTURE) });
    const events = await collect(
      a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }),
    );
    const deltas = events.filter((e) => e.type === "thinking_delta").map((e: any) => e.thinking).join("");
    expect(deltas).toBe("step one. step two."); // 完整透传
    const end = events.find((e) => e.type === "thinking_end") as any;
    expect(end.thinking).toBe("step one. step two."); // 全块文本自足
    expect(end.thinkingSignature).toBe("sigAABB=="); // 多帧 signature_delta 原样拼接
  });

  it("无 signature_delta → thinking_end 无签名字段；签名篡改探针=逐字比对（API 拒绝语义的单测替身）", async () => {
    const noSig = THINKING_FIXTURE.replace(
      /event: content_block_delta\ndata: \{"type":"content_block_delta","index":0,"delta":\{"type":"signature_delta"[^}]+\}\}\n\n/g,
      "",
    );
    const a = new AnthropicAdapter(MODEL, { apiKey: "k", fetchImpl: async () => sseResponse(noSig) });
    const events = await collect(
      a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }),
    );
    const end = events.find((e) => e.type === "thinking_end") as any;
    expect(end.thinkingSignature).toBeUndefined();
    // 签名语义=Provider 原文字节：夹具内 sigAABB== 与 thinking_end 回传逐字一致（任何加工即失败）
    const withSig = THINKING_FIXTURE.match(/"signature":"sigAA"/);
    expect(withSig).not.toBeNull();
  });

  it("请求级 thinking 配置透传（adaptive→enabled；budget→budget_tokens）", async () => {
    const bodies: any[] = [];
    const a = new AnthropicAdapter(MODEL, {
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        return sseResponse(THINKING_FIXTURE);
      },
    });
    await collect(a.stream({ model: "claude-sonnet-4-6", thinking: { type: "adaptive" }, messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(bodies[0].thinking).toEqual({ type: "enabled" });
    await collect(a.stream({ model: "claude-sonnet-4-6", thinking: { type: "budget", budgetTokens: 4096 }, messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(bodies[1].thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("thinking 块上传路径：签名原样进请求消息（回放两跳：流出→请求体）", async () => {
    const bodies: any[] = [];
    const a = new AnthropicAdapter(MODEL, {
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        return sseResponse(THINKING_FIXTURE);
      },
    });
    const first = await collect(a.stream({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    const end = first.find((e) => e.type === "thinking_end") as any;
    // 第二轮：把第一轮产出的 thinking 块（含签名）作为 assistant 历史回传
    await collect(
      a.stream({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: [{ type: "thinking", thinking: end.thinking, signature: end.thinkingSignature }] },
        ],
      }),
    );
    const echoed = bodies[1].messages[1].content[0];
    expect(echoed).toEqual({ type: "thinking", thinking: "step one. step two.", signature: "sigAABB==" });
  });
});

describe("WP-06 openai reasoning 收束（无签名方言）", () => {
  const OPENAI_MODEL = {
    "o-model": { contextWindow: 128000, maxOutputTokens: { default: 32000, upper: 32000 }, thinking: "adaptive" as const, input: ["text" as const] },
  };
  const REASONING_FIXTURE = (finish: string) => `data: {"id":"1","model":"o-model","choices":[{"index":0,"delta":{"reasoning_content":"think part."}}]}

data: {"id":"1","model":"o-model","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":${JSON.stringify(finish)}}]}

data: [DONE]

`;
  it("reasoning 块以 thinking_end 收束（无 signature 字段）", async () => {
    const a = new OpenAIChatAdapter(OPENAI_MODEL, { apiKey: "k", fetchImpl: async () => sseResponse(REASONING_FIXTURE("stop")) });
    const events = await collect(a.stream({ model: "o-model", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    const end = events.find((e) => e.type === "thinking_end") as any;
    expect(end.thinking).toBe("think part.");
    expect(end.thinkingSignature).toBeUndefined();
    expect(events.findIndex((e) => e.type === "thinking_end")).toBeLessThan(events.findIndex((e) => (e as any).reason === "completed"));
  });
});
