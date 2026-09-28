// F11（2026-09-29 真机实测）修复回归：上下文超长时恢复链的 usedTokens 须为**可用值**（非 0）。
// 背景：回合首个模型调用即被 provider 以 context_length 拒绝时，state.usage 尚未产生（undefined → 0）：
// reactive_step 打印 gap=-window 噪声，且 autocompact.evaluate(0) 恒拒 → 直接 context_exhausted（不压缩、不重试）。
// 修复＝回退 provider.countTokens（本地估算）。本文件锁「evaluate 实收 usedTokens>0」与「回退链行为」。
import { describe, expect, it } from "vitest";
import { ProviderError, type LLMEvent, type ProviderAdapter } from "@standardcode/providers";
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

const MSGS = [{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] }];

/** 首个 stream 调用抛 context_length，其后成功；countTokens 回报固定估算值。 */
function recoveringProvider(estimate: number): ProviderAdapter & { streams: number } {
  const p = {
    streams: 0,
    capabilities: () => ({ contextWindow: 128_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none" as const, input: ["text"] as Array<"text" | "image" | "video" | "audio">, streaming: true, toolCalling: true, cache: { ttlLevels: [], explicitBreakpoints: false } }),
    countTokens: async () => estimate,
    async *stream() {
      p.streams++;
      if (p.streams === 1) throw new ProviderError("context_length", "prompt is too long: 200000 tokens > 128000 maximum");
      yield { type: "text_delta", text: "recovered" } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
  return p;
}

describe("上下文超长恢复链的 usedTokens（F11 修复）", () => {
  it("回合首调用即超长：evaluate 收到的 usedTokens = provider 估算（非 0），且压缩后恢复", async () => {
    const seen: number[] = [];
    const p = recoveringProvider(152_000);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: {
          modelWindow: 128_000,
          decide: () => ({ next: "auto-compact" as never, exhausted: true }),
          apply: () => null,
        },
        autocompact: {
          evaluate: (used) => {
            seen.push(used);
            return { shouldCompact: used >= 120_000, level: "compact" };
          },
          perform: async () => ({ ok: true, postCompactTokens: 1500 }),
        },
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(152_000); // 修复前＝0（state.usage 未产生）
    expect(p.streams).toBe(2); // 压缩后重试并成功
    expect(events.some((e) => e.type === "compact_decided")).toBe(true);
    expect(events.some((e) => e.type === "context_exhausted")).toBe(false);
    const gap = events.find((e) => e.type === "reactive_step") as { tokenGap: number };
    expect(gap.tokenGap).toBe(152_000 - 128_000); // 修复前＝-128000（噪声）
  });

  it("同回合已有 usage：优先用 usage（既有语义不回归）", async () => {
    const seen: number[] = [];
    const p = recoveringProvider(999_999);
    p.stream = async function* () {
      // 先上报 usage（模拟本回合首个调用已成功过半），再抛 context_length
      yield { type: "usage", usage: { inputTokens: 130_000, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as unknown as LLMEvent;
      throw new ProviderError("context_length", "prompt is too long");
    };
    await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: MSGS,
        reactive: { modelWindow: 128_000, decide: () => ({ next: "auto-compact" as never, exhausted: true }), apply: () => null },
        autocompact: {
          evaluate: (used) => {
            seen.push(used);
            return { shouldCompact: false, level: "warn" };
          },
          perform: async () => ({ ok: false, postCompactTokens: 0 }),
        },
      }),
    );
    expect(seen[0]).toBe(130_000); // usage 在场时不被估算(999999)覆盖
  });
});
