// F6（2026-09-28 真机实测）修复回归：usage 尾块序结算。
// 背景：OpenAI `stream_options.include_usage` 规范把 usage 放在 finish_reason **之后**的空 choices 尾块；
// 原实现只在 finish 结算 pendingUsage → 该轮 usage 既不上屏也不入 meter（真机实证：单调用轮 /usage 恒 0；
// 工具环两调用只计 1 次 1234 而非 2468）。修复=流末兜底结算（仅当 finish 之后又到达过 usage 才触发）。
import { describe, expect, it } from "vitest";
import { UsageMeter } from "@standardcode/context";
import type { TokenUsage } from "@standardcode/providers";
import type { AgentEvent, TurnState } from "@standardcode/harness";
import { renderTurn } from "../src/render.ts";

const USAGE: TokenUsage = { inputTokens: 1234, outputTokens: 56, cacheCreationTokens: 0, cacheReadTokens: 1000 };

async function* feed(events: AgentEvent[]): AsyncGenerator<AgentEvent, TurnState, unknown> {
  for (const e of events) yield e;
  return { messages: [] } as unknown as TurnState;
}

async function run(events: AgentEvent[]): Promise<{ out: string; meter: UsageMeter }> {
  const out: string[] = [];
  const meter = new UsageMeter();
  await renderTurn(feed(events), (s) => out.push(s), meter, undefined, "plain");
  return { out: out.join(""), meter };
}

describe("renderTurn usage 结算（F6 修复）", () => {
  it("OpenAI 尾块序（usage 在 finish 之后）：仍上屏且计入 meter", async () => {
    const { out, meter } = await run([
      { type: "text_delta", text: "hi" },
      { type: "finish", reason: "completed", raw: null },
      { type: "usage", usage: USAGE },
    ]);
    expect(meter.snapshot()).toMatchObject(USAGE);
    expect(out).toContain("input=1234");
    expect(out).toContain("cache_read=1000");
  });

  it("Anthropic 序（usage 在 finish 之前）：结算一次，流末不双计", async () => {
    const { out, meter } = await run([
      { type: "text_delta", text: "hi" },
      { type: "usage", usage: USAGE },
      { type: "finish", reason: "completed", raw: null },
    ]);
    expect(meter.snapshot()).toMatchObject(USAGE);
    expect((out.match(/usage: input=1234/g) ?? []).length).toBe(1);
  });

  it("同轮两次模型调用（工具环）：各结算一次，会话合计=两次之和", async () => {
    const { meter } = await run([
      { type: "tool_start", id: "t1", name: "Write" },
      { type: "tool_result", id: "t1", name: "Write", content: "ok", isError: false },
      { type: "finish", reason: "tool_calls", raw: null }, // 调用①的 finish（usage 尾块尚未到）
      { type: "usage", usage: USAGE }, // 调用①的尾块 usage
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "completed", raw: null }, // 调用②的 finish
      { type: "usage", usage: USAGE }, // 调用②的尾块 usage（流末兜底）
    ]);
    expect(meter.snapshot().inputTokens).toBe(2468);
    expect(meter.turns).toBe(2);
  });

  it("无 usage 事件（纯文本流）：不动 meter、不打印 usage 行", async () => {
    const { out, meter } = await run([
      { type: "text_delta", text: "hi" },
      { type: "finish", reason: "completed", raw: null },
    ]);
    expect(meter.snapshot().inputTokens).toBe(0);
    expect(meter.turns).toBe(0);
    expect(out).not.toContain("usage: input=");
  });
});
