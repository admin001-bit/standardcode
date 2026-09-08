// WP-05 R1 修复（2026-09-09 V 退回）reactive 兜底生产接线测试（CTX-037；判据自足：DoD① prompt-too-long
// 触发+tokenGap 指标记录+瀑布升级序在真实 agent-loop 触发面上）。
import { describe, expect, it } from "vitest";
import { ProviderError, type LLMEvent, type LLMMessage, type LLMRequest, type ProviderAdapter } from "@standardcode/providers";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    out.push(r.value);
    r = await gen.next();
  }
  return out;
}

const MSGS: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "q" }] }];

/** 首轮先发 usage 再抛 context_length（tokenGap=used−window 的记录面），calls 次后转正常完成。 */
function tooLongThenOkProvider(calls: number): ProviderAdapter & { rounds: number } {
  let rounds = 0;
  return {
    get rounds() {
      return rounds;
    },
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream() {
      rounds++;
      if (rounds <= calls) {
        yield { type: "usage", usage: { inputTokens: 250_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
        throw new ProviderError("context_length", "prompt is too long: 250000 tokens > 200000 maximum");
      }
      yield { type: "text_delta", text: "ok" } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

const reactiveSteps = (events: AgentEvent[]) => events.filter((e) => e.type === "reactive_step");

describe("WP-05 R1 reactive 兜底生产接线（CTX-037）", () => {
  it("DoD① prompt-too-long 触发 reactive：cleanup 生效→重试成功；tokenGap=250000−200000=50000 记录在事件", async () => {
    const p = tooLongThenOkProvider(1);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: (current) => (current === null ? { next: "tool-result-cleanup", exhausted: false } : { next: "auto-compact", exhausted: true }),
          apply: (step, messages) => {
            expect(step).toBe("tool-result-cleanup");
            return messages; // 原样返回（收缩动作由实现方保证，此处只验证接线与重试）
          },
        },
      }),
    );
    const steps = reactiveSteps(events);
    expect(steps).toEqual([{ type: "reactive_step", attempt: 1, tokenGap: 50_000, step: "tool-result-cleanup" }]);
    expect(events.some((e) => e.type === "finish" && (e as any).reason === "completed")).toBe(true);
    expect(p.rounds).toBe(2); // 收缩后重试
  });

  it("DoD② 瀑布升级序（跨触发）：cleanup 已收缩但重试仍超长→下一触发升 collapse；事件保序（前者未解决才走后者）", async () => {
    const p = tooLongThenOkProvider(2);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: (current) =>
            current === null
              ? { next: "tool-result-cleanup", exhausted: false }
              : current === "tool-result-cleanup"
                ? { next: "context-collapse", exhausted: false }
                : { next: "auto-compact", exhausted: true },
          apply: (step) => (step === "context-collapse" ? MSGS : MSGS), // 两级均"收缩生效"（由重试结果裁决）
        },
      }),
    );
    expect(reactiveSteps(events).map((e: any) => e.step)).toEqual(["tool-result-cleanup", "context-collapse"]);
    expect(events.some((e) => e.type === "finish" && (e as any).reason === "completed")).toBe(true);
    expect(p.rounds).toBe(3);
  });

  it("瀑布耗尽（auto-compact 级 exhausted）→ 落既有 autocompact 路由（compact_decided）；未配 autocompact → context_exhausted", async () => {
    const p = tooLongThenOkProvider(1);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: () => ({ next: "auto-compact", exhausted: true }),
          apply: () => null,
        },
        autocompact: {
          evaluate: () => ({ shouldCompact: true, level: "compact" }),
          perform: async () => ({ ok: true, postCompactTokens: 1_500 }),
        },
      }),
    );
    expect(reactiveSteps(events)).toEqual([{ type: "reactive_step", attempt: 1, tokenGap: 50_000, step: "auto-compact" }]);
    expect(events.some((e) => e.type === "compact_decided")).toBe(true);
  });

  it("CTX-037 瀑布序：cleanup 先于 auto-compact（闸+perform 在位也不跳级，瀑布解决即不压缩）", async () => {
    let attempts = 0;
    const p = tooLongThenOkProvider(1);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: (current) => (current === null ? { next: "tool-result-cleanup", exhausted: false } : { next: "auto-compact", exhausted: true }),
          apply: (step, messages) => {
            attempts++;
            expect(step).toBe("tool-result-cleanup");
            return messages; // 收缩生效
          },
        },
        autocompact: {
          evaluate: () => ({ shouldCompact: true, level: "compact" }),
          perform: async () => {
            throw new Error("waterfall resolved first — auto-compact must not run");
          },
        },
      }),
    );
    expect(attempts).toBe(1);
    expect(events.some((e) => e.type === "compact_decided")).toBe(false);
    expect(reactiveSteps(events).map((e: any) => e.step)).toEqual(["tool-result-cleanup"]);
  });

  it("未配置 reactive/autocompact → context_exhausted（原行为不变）", async () => {
    const p = tooLongThenOkProvider(3);
    const events = await collect(runAgentLoop({ provider: p, model: "m", messages: MSGS }));
    expect(events).toContainEqual({ type: "context_exhausted" });
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "context_exhausted" });
  });
});

// 复验建议补例（2026-09-09 原核验员临时探针验证的三条边界分支，落为正式回归）。
describe("reactive 边界分支（复验补例）", () => {
  it("apply 返回 null → 同一触发内继续升级（不重试），直到有步生效或耗尽", async () => {
    const p = tooLongThenOkProvider(1);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: (current) =>
            current === null ? { next: "tool-result-cleanup", exhausted: false } : { next: "context-collapse", exhausted: true },
          apply: () => null, // cleanup 无事可做
        },
      }),
    );
    expect(reactiveSteps(events).map((e: any) => e.step)).toEqual(["tool-result-cleanup", "context-collapse"]);
    expect(p.rounds).toBe(1); // 升级全程在同触发内完成，未重试；collapse exhausted 且无 autocompact → 立即 context_exhausted
    expect(events.some((e) => e.type === "context_exhausted")).toBe(true);
  });

  it("apply 返回值真实替换请求历史：重试请求收到收缩后消息", async () => {
    const SHRUNK: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "shrunken-history" }] }];
    const seen: LLMRequest["messages"][] = [];
    let rounds = 0;
    const p: ProviderAdapter = {
      capabilities: () => {
        throw new Error("not used");
      },
      countTokens: async () => 0,
      async *stream(req: LLMRequest) {
        seen.push(structuredClone(req.messages));
        rounds++;
        if (rounds === 1) throw new ProviderError("context_length", "prompt is too long");
        yield { type: "text_delta", text: "ok" } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      },
    };
    await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "original-long-history" }] }],
        reactive: {
          modelWindow: 200_000,
          decide: () => ({ next: "tool-result-cleanup", exhausted: false }),
          apply: () => structuredClone(SHRUNK), // 交给 loop 的数组会被收尾 push（快照语义），克隆隔离
        },
      }),
    );
    expect(seen[0]![0]).toMatchObject({ content: [{ type: "text", text: "original-long-history" }] });
    expect(seen[1]).toEqual(SHRUNK); // 收缩后历史进请求
  });

  it("reactive exhausted 且未配 autocompact → context_exhausted（不误压、不误走）", async () => {
    const p = tooLongThenOkProvider(5);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 200_000,
          decide: () => ({ next: "auto-compact", exhausted: true }),
          apply: () => null,
        },
      }),
    );
    expect(events).toContainEqual({ type: "context_exhausted" });
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "context_exhausted" });
  });
});
