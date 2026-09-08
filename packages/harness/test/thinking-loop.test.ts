// WP-06（M2）harness 侧测试：thinking 块组装入历史+请求透传（判据自足：板 WP-06 DoD①②④）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

function queueProvider(pages: LLMEvent[][], capture: { reqs: LLMRequest[] }): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(req: LLMRequest) {
      capture.reqs.push(req);
      const page = pages[Math.min(i++, pages.length - 1)];
      for (const ev of page) yield ev;
    },
  };
}

const STOP: LLMEvent[] = [{ type: "finish", reason: "completed", raw: "end_turn" }];

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    out.push(r.value);
    r = await gen.next();
  }
  return out;
}

describe("WP-06 harness thinking 组装", () => {
  it("DoD① thinking_end→thinking 块入 assistant 历史（signature 原样）+事件透传", async () => {
    const capture = { reqs: [] as LLMRequest[] };
    const p = queueProvider(
      [
        [
          { type: "thinking_delta", thinking: "deep " },
          { type: "thinking_delta", thinking: "thought." },
          { type: "thinking_end", thinking: "deep thought.", thinkingSignature: "SIG==" },
          { type: "text_delta", text: "answer" },
          ...STOP,
        ],
      ],
      capture,
    );
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        stateRef: (globalThis as any).__wp06sr ?? ((globalThis as any).__wp06sr = {}),
      }),
    );
    expect(events.some((e) => e.type === "thinking_end" && (e as any).thinkingSignature === "SIG==")).toBe(true);
    const final = capture.reqs.length >= 1;
    expect(final).toBe(true);
    // 块入历史经 stateRef 验证
    const state = (globalThis as any).__wp06sr.current;
    expect(state).toBeDefined();
    const assistant = state.messages.find((m: any) => m.role === "assistant");
    const thinking = assistant.content.find((b: any) => b.type === "thinking");
    expect(thinking).toEqual({ type: "thinking", thinking: "deep thought.", signature: "SIG==" });
  });

  it("DoD② 会话 thinking 配置进请求（每 turn）；缺省不发", async () => {
    const capture = { reqs: [] as LLMRequest[] };
    const p = queueProvider([[...STOP]], capture);
    await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        thinking: { type: "budget", budgetTokens: 2048 },
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      }),
    );
    expect(capture.reqs[0].thinking).toEqual({ type: "budget", budgetTokens: 2048 });
    const capture2 = { reqs: [] as LLMRequest[] };
    const p2 = queueProvider([[...STOP]], capture2);
    await collect(
      runAgentLoop({ provider: p2, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }),
    );
    expect(capture2.reqs[0].thinking).toBeUndefined();
  });

  it("DoD④ 无缓冲透传结构断言：thinking_delta 逐条 yield 且顺序与 adapter 输出一致", async () => {
    const capture = { reqs: [] as LLMRequest[] };
    const p = queueProvider(
      [
        [
          { type: "thinking_delta", thinking: "a" },
          { type: "thinking_delta", thinking: "b" },
          { type: "thinking_delta", thinking: "c" },
          ...STOP,
        ],
      ],
      capture,
    );
    const events = await collect(
      runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }),
    );
    const seq = events.filter((e) => e.type === "thinking_delta").map((e: any) => e.thinking);
    expect(seq).toEqual(["a", "b", "c"]); // 逐条转发、无缓冲合并
  });
});
