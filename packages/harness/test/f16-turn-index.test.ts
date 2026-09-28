// F16（2026-09-29 实测）修复回归（harness 侧）：压缩协调器的 turn 基准须可用 L0 会话轮序（LoopOptions.turnIndex）
// ——原实现只传 state.toolRounds（每轮从 0 起）→ 协调器闸③ "压缩后 3 turn 内又填满"的跨轮距离恒 <3，
// "正常节奏（间隔 ≥3 turn）重置"永不触发、计数单调累积（慢节奏也会被 blocked）；且闸拒理由（gate.reason，
// 含 "use /compact manually" 指引）原被丢弃 → 用户只见 "start a new session"。
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

/** 首个 stream 调用抛 context_length（触发恢复链②），其后成功。 */
function ctxErrProvider(): ProviderAdapter {
  let n = 0;
  return {
    capabilities: () => ({ contextWindow: 128_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none" as const, input: ["text"] as Array<"text" | "image" | "video" | "audio">, streaming: true, toolCalling: true, cache: { ttlLevels: [], explicitBreakpoints: false } }),
    countTokens: async () => 150_000,
    async *stream() {
      n++;
      if (n === 1) throw new ProviderError("context_length", "prompt is too long: 200000 tokens > 128000 maximum");
      yield { type: "text_delta", text: "ok" } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

const REACTIVE = {
  modelWindow: 128_000,
  decide: () => ({ next: "auto-compact" as never, exhausted: true }),
  apply: () => null,
};

describe("压缩协调器 turn 基准＝会话轮序（F16 修复）", () => {
  it("turnIndex 透传：evaluate 收到会话轮序（7），非 toolRounds（0）", async () => {
    const seen: number[] = [];
    await collect(
      runAgentLoop({
        provider: ctxErrProvider(),
        model: "m",
        messages: MSGS,
        turnIndex: 7,
        reactive: REACTIVE,
        autocompact: {
          evaluate: (_used, turn) => {
            seen.push(turn);
            return { shouldCompact: false, level: "warn", reason: "rapid-refill trip: test" };
          },
        },
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(7); // 修复前＝state.toolRounds＝0（跨轮恒 0 → 闸③ 重置分支永不触发）
  });

  it("对照：未传 turnIndex 回落 toolRounds（既有调用方零改动）", async () => {
    const seen: number[] = [];
    await collect(
      runAgentLoop({
        provider: ctxErrProvider(),
        model: "m",
        messages: MSGS,
        reactive: REACTIVE,
        autocompact: { evaluate: (_used, turn) => (seen.push(turn), { shouldCompact: false, level: "warn" }) },
      }),
    );
    expect(seen[0]).toBe(0);
  });

  it("闸拒理由随 context_exhausted 事件上抛（原被丢弃）", async () => {
    const events = await collect(
      runAgentLoop({
        provider: ctxErrProvider(),
        model: "m",
        messages: MSGS,
        turnIndex: 3,
        reactive: REACTIVE,
        autocompact: { evaluate: () => ({ shouldCompact: false, level: "blocked", reason: "circuit breaker tripped (consecutive failures); use /compact manually" }) },
      }),
    );
    const ev = events.find((e) => e.type === "context_exhausted") as { type: string; reason?: string };
    expect(ev).toBeDefined();
    expect(ev.reason).toContain("use /compact manually");
    expect(events.some((e) => e.type === "done" && e.reason === "context_exhausted")).toBe(true);
  });

  it("闸放行：perform 同样收到会话轮序，压缩后重试成功", async () => {
    const performed: number[] = [];
    const events = await collect(
      runAgentLoop({
        provider: ctxErrProvider(),
        model: "m",
        messages: MSGS,
        turnIndex: 12,
        reactive: REACTIVE,
        autocompact: {
          evaluate: () => ({ shouldCompact: true, level: "compact" }),
          perform: async (turn) => {
            performed.push(turn);
            return { ok: true, postCompactTokens: 1500 };
          },
        },
      }),
    );
    expect(performed).toEqual([12]);
    expect(events.some((e) => e.type === "compact_decided")).toBe(true);
    expect(events.some((e) => e.type === "context_exhausted")).toBe(false);
  });
});
