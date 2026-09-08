// WP-03（M2）恢复链②路由接缝测试（CTX-101 交接；判据自足：板 WP-03 边界"恢复链②路由改接压缩"）。
import { describe, expect, it } from "vitest";
import { ProviderError, type LLMEvent, type LLMRequest, type ProviderAdapter } from "@standardcode/providers";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

function contextErrorProvider(): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    // 恒抛 context_length（恢复链②触发面；isContextLength 判据=ProviderError.kind）
    async *stream() {
      throw new ProviderError("context_length", "prompt is too long: 250000 tokens > 200000 maximum");
    },
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    out.push(r.value);
    r = await gen.next();
  }
  return out;
}

const MSGS = [{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] }];

describe("WP-03 恢复链② 路由改接（CTX-101 交接）", () => {
  it("闸放行+perform 成功 → compact_decided 且历史替换后下轮重试", async () => {
    let performed = 0;
    const p: ProviderAdapter = {
      ...contextErrorProvider(),
      // 首轮恒错；压缩成功后的下一轮直接完成（模拟压缩后重试）
    };
    let rounds = 0;
    p.stream = async function* () {
      rounds++;
      if (rounds === 1) {
        throw new ProviderError("context_length", "prompt is too long");
      }
      yield { type: "text_delta", text: "after compact" } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    };
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        autocompact: {
          evaluate: () => ({ shouldCompact: true, level: "compact" }),
          perform: async (turn) => {
            performed++;
            return { ok: true, postCompactTokens: 1500 + turn };
          },
        },
      }),
    );
    expect(performed).toBe(1);
    const decided = events.find((e) => e.type === "compact_decided") as any;
    expect(decided).toMatchObject({ level: "compact", postCompactTokens: 1500 });
    expect(events.some((e) => e.type === "finish" && (e as any).reason === "completed")).toBe(true);
  });

  it("WP-04：perform 返回新历史 → state.messages 被替换（摘要非清空）", async () => {
    const NEW_HISTORY = [{ role: "user" as const, content: [{ type: "text" as const, text: "summary-of-before" }] }];
    let rounds = 0;
    const p: ProviderAdapter = {
      capabilities: () => {
        throw new Error("not used");
      },
      countTokens: async () => 0,
      async *stream() {
        rounds++;
        if (rounds === 1) throw new ProviderError("context_length", "prompt is too long");
        yield { type: "text_delta", text: "ok" } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      },
    };
    const sr: { current?: import("../src/types.ts").TurnState } = {};
    await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        stateRef: sr,
        autocompact: {
          evaluate: () => ({ shouldCompact: true, level: "compact" }),
          perform: async () => ({ ok: true, postCompactTokens: 900, messages: NEW_HISTORY }),
        },
      }),
    );
    expect(sr.current!.messages).toEqual(NEW_HISTORY); // 摘要替换（非清空占位）
  });

  it("闸拒（shouldCompact=false）→ 维持 context_exhausted（WP-04 前行为不变）", async () => {
    const events = await collect(
      runAgentLoop({
        provider: contextErrorProvider(),
        model: "m",
        messages: MSGS,
        autocompact: { evaluate: () => ({ shouldCompact: false, level: "ok" }) },
      }),
    );
    expect(events).toContainEqual({ type: "context_exhausted" });
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "context_exhausted" });
  });

  it("闸放行但未提供 perform（WP-04 前）→ 维持 context_exhausted", async () => {
    const events = await collect(
      runAgentLoop({
        provider: contextErrorProvider(),
        model: "m",
        messages: MSGS,
        autocompact: { evaluate: () => ({ shouldCompact: true, level: "compact" }) },
      }),
    );
    expect(events).toContainEqual({ type: "context_exhausted" });
  });

  it("未配置 autocompact → 原行为（context_exhausted）不变", async () => {
    const events = await collect(runAgentLoop({ provider: contextErrorProvider(), model: "m", messages: MSGS }));
    expect(events).toContainEqual({ type: "context_exhausted" });
  });
});
