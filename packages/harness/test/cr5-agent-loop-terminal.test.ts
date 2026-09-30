// S3-4/S3-6 回归（全仓审查 2026-10-01 批5）：
// S3-4＝stateRef.current 原仅中断/end 回填——context_exhausted/filtered/truncated_gave_up/
//       malformed_fail_closed/max_turns 五类终态不回填，subagent 回落初始 messages 恒兜底串；
// S3-6＝流 race 的 abort 监听器原 {once} 不随 it.next() 胜出摘除——单 turn 监听器数＝流事件数。
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { runAgentLoop } from "../src/agent-loop.ts";
import { runSubagent } from "../src/subagent.ts";
import type { TurnState, Tool } from "../src/types.ts";

const BASE = [{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] }];

function provider(pages: LLMEvent[][], capture?: { reqs: LLMRequest[] }): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(req: LLMRequest): AsyncGenerator<LLMEvent> {
      capture?.reqs.push(req);
      const page = pages[Math.min(i++, pages.length - 1)]!;
      for (const ev of page) yield ev;
    },
  };
}

async function collect(gen: AsyncGenerator<unknown>): Promise<{ done?: string }> {
  let done: string | undefined;
  for await (const ev of gen) {
    if ((ev as { type?: string }).type === "done") done = (ev as { reason: string }).reason;
  }
  return { done };
}

const TOOL_ROUND: LLMEvent[] = [
  { type: "tool_start", id: "t1", name: "echo" },
  { type: "tool_input_delta", id: "t1", jsonPartial: '{"text":"x"}' },
  { type: "tool_end", id: "t1" },
  { type: "finish", reason: "tool_calls", raw: "tool_use" },
];

describe("S3-4 五类终态 stateRef 回填", () => {
  it("max_turns 回填（修复前 undefined → subagent 回落初始 messages）", async () => {
    const stateRef: { current?: TurnState } = {};
    const { done } = await collect(
      runAgentLoop({ provider: provider([TOOL_ROUND]), model: "m", messages: BASE, stateRef, maxToolRounds: 0 }),
    );
    expect(done).toBe("max_turns");
    expect(stateRef.current).toBeDefined();
    expect(stateRef.current!.messages.length).toBeGreaterThan(BASE.length); // assistant+error result 已入
  });

  it("filtered 回填", async () => {
    const stateRef: { current?: TurnState } = {};
    const { done } = await collect(
      runAgentLoop({ provider: provider([[{ type: "finish", reason: "filtered", raw: null }]]), model: "m", messages: BASE, stateRef }),
    );
    expect(done).toBe("filtered");
    expect(stateRef.current).toBeDefined();
  });

  it("truncated_gave_up 回填（③预算耗尽）", async () => {
    const stateRef: { current?: TurnState } = {};
    const trunc: LLMEvent[] = [{ type: "finish", reason: "truncated", raw: "max_tokens" }];
    const { done } = await collect(
      runAgentLoop({ provider: provider([trunc]), model: "m", messages: BASE, stateRef, maxContinuations: 1 }),
    );
    expect(done).toBe("truncated_gave_up");
    expect(stateRef.current).toBeDefined();
  });

  it("malformed_fail_closed 回填（⑤预算耗尽）", async () => {
    const stateRef: { current?: TurnState } = {};
    const bad: LLMEvent[] = [
      { type: "tool_start", id: "t1", name: "echo" },
      { type: "tool_input_delta", id: "t1", jsonPartial: "{not json" },
      { type: "tool_end", id: "t1" },
      { type: "finish", reason: "tool_calls", raw: "tool_use" },
    ];
    const { done } = await collect(
      runAgentLoop({ provider: provider([bad]), model: "m", messages: BASE, stateRef, maxMalformedRounds: 1 }),
    );
    expect(done).toBe("malformed_fail_closed");
    expect(stateRef.current).toBeDefined();
  });

  it("context_exhausted 回填（catch 路径、无协调器）", async () => {
    const stateRef: { current?: TurnState } = {};
    const throwing: ProviderAdapter = {
      capabilities: () => {
        throw new Error("not used");
      },
      countTokens: async () => 0,
      async *stream(): AsyncGenerator<LLMEvent> {
        throw Object.assign(new Error("prompt is too long"), { kind: "context_length", status: 400 });
      },
    };
    const { done } = await collect(runAgentLoop({ provider: throwing, model: "m", messages: BASE, stateRef }));
    expect(done).toBe("context_exhausted");
    expect(stateRef.current).toBeDefined();
  });

  it("S3-4 端到端：subagent 跑满 max_turns 后报告=末条 assistant 文本（修复前恒兜底串）", async () => {
    const p = provider([
      [
        { type: "text_delta", text: "partial answer" },
        ...TOOL_ROUND,
      ],
    ]);
    const r = await runSubagent(
      { prompt: "p", description: "d", agentType: "general-purpose", definition: { name: "general-purpose", description: "x", maxTurns: 0 }, background: false },
      { provider: p, model: "m", tools: [{ name: "echo", description: "d", inputSchema: { type: "object" }, execute: async () => "ok" } satisfies Tool] },
    );
    expect(r.doneReason).toBe("max_turns");
    expect(r.content).toBe("partial answer"); // 修复前：stateRef.current undefined → "(Subagent completed but returned no output.)"
  });
});

describe("S3-6 abort 监听器成对收束", () => {
  it("多事件单 turn 结束后 signal 上零残留监听（修复前=每事件一个）", async () => {
    const ctl = new AbortController();
    const deltas: LLMEvent[] = Array.from({ length: 20 }, (_, i) => ({ type: "text_delta", text: `t${i}` }));
    const p = provider([[...deltas, { type: "finish", reason: "completed", raw: "end_turn" }]]);
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: BASE, signal: ctl.signal }));
    expect(done).toBe("end");
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0); // 修复前：20 个残留
  });
});
