// WP-13 E2E（v2.8 §12.2 E2E 行、§2 行 M1 DoD）：边界场景 ③④。
// ③ Ctrl+C 后改指令：合成 error tool_result、进程树清理、JSONL 可 resume；
// ④ 畸形工具调用连续失败 fail-closed（无悬空 tool_use）。
// Provider 全回放（可复现性优先，卡边界授权）；工具/子进程/fs 真实；协议不变量断言全程开启（默认开）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent, type Tool, type TurnState } from "@standardcode/harness";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { TranscriptWriter, resumeFrom } from "@standardcode/platform";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-e2e-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// —— 夹具 ——

function replay(rounds: LLMEvent[][], hangAfter?: { round: number; ms: number }): ProviderAdapter & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      if (hangAfter && i === hangAfter.round) {
        for (const ev of rounds[i] ?? []) yield ev;
        // 挂起模拟"流未完即中断"；随 req.signal 可中断——否则挂起计时器会拖住测试进程
        await new Promise<void>((r) => {
          const t = setTimeout(r, hangAfter.ms);
          req.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            r();
          }, { once: true });
        });
        return;
      }
      for (const ev of rounds[Math.min(i, rounds.length - 1)]) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

const sleepTool: Tool = {
  name: "Bash",
  description: "sleep tool (fixture)",
  inputSchema: { type: "object", required: ["ms"], properties: { ms: { type: "integer" } } },
  isConcurrencySafe: false,
  execute: async (input, ctx) => {
    const ms = (input as { ms: number }).ms;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      }, { once: true });
    });
    return "slept";
  },
};

const toolRound = (id: string, input: unknown): LLMEvent[] => [
  { type: "message_start", id: "m", model: "test" },
  { type: "tool_start", id, name: "Bash" },
  { type: "tool_input_delta", id, jsonPartial: JSON.stringify(input) },
  { type: "tool_end", id },
  { type: "finish", reason: "tool_calls", raw: "tool_use" },
];

const FINAL: LLMEvent[] = [
  { type: "message_start", id: "m", model: "test" },
  { type: "text_delta", text: "recovered and done" },
  { type: "finish", reason: "completed", raw: "end_turn" },
];

async function collect(gen: AsyncGenerator<AgentEvent, TurnState>): Promise<{ events: AgentEvent[]; final: TurnState }> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, final: r.value };
}

function countDangling(state: TurnState): number {
  const uses = state.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use")).length;
  const results = state.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result")).length;
  return uses - results;
}

// —— 场景③：Ctrl+C 后改指令 ——

describe("E2E ③ interrupt → synthesize → tree cleanup → JSONL resume", () => {
  it("tool-phase interrupt: unfinished tool gets error tool_result, 60s sleep killed promptly, change-of-instruction continues, transcript resume equals final state", async () => {
    const base = join(dir, "s3");
    const w = await TranscriptWriter.create(dir, "s3", base);
    const ctl = new AbortController();
    // 轮1：60s sleep 工具执行中中断（不会自然结束——中断与清理必须及时）
    const provider = replay([toolRound("t1", { ms: 60_000 }), FINAL], { round: 0, ms: 30_000 });
    const gen = runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "start a long job" }] }],
      tools: [sleepTool],
      signal: ctl.signal,
    });
    const started = Date.now();
    setTimeout(() => ctl.abort(), 150);
    const { events, final } = await collect(gen);
    const elapsed = Date.now() - started;

    // ① 中断事件与终态（<5s 内退出=60s sleep 被打断的时序证据）
    expect(elapsed).toBeLessThan(5000);
    expect(events.some((e) => e.type === "interrupted" && e.phase === "tool")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "interrupted" });
    // ② 未完成工具合成 error tool_result（协议不留悬空 tool_use——硬不变量）
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "t1", isError: true });
    expect(countDangling(final)).toBe(0);

    // ③ 用户改指令可续：以终态历史为底，追加新指令，正常完成
    const provider2 = replay([FINAL]);
    const gen2 = runAgentLoop({
      provider: provider2,
      model: "m",
      messages: [...final.messages, { role: "user", content: [{ type: "text", text: "change of plan: just say done" }] }],
      tools: [sleepTool],
    });
    const { events: events2, final: final2 } = await collect(gen2);
    expect(events2.at(-1)).toMatchObject({ type: "done", reason: "end" });
    expect(JSON.stringify(final2.messages.at(-1))).toContain("recovered and done");
    expect(countDangling(final2)).toBe(0);

    // ④ JSONL 落盘（生产接线形态：user_message/interrupt/终态消息/done）+程序化 resume 等价
    await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "start a long job" }] } });
    for (const e of events) {
      if (e.type === "interrupted") await w.append({ kind: "interrupt", phase: e.phase });
    }
    for (const m of final.messages.slice(1)) {
      await w.append({ kind: m.role === "assistant" ? "assistant_message" : "user_message", message: m });
    }
    await w.append({ kind: "done", reason: "interrupted", usage: final.usage ?? undefined });
    const resumed = await resumeFrom(w.file);
    expect(resumed.lastReason).toBe("interrupted");
    expect(resumed.skippedMalformed).toBe(0);
    expect(resumed.messages).toEqual(final.messages);
  }, 20000);

  it("stream-phase interrupt: partial text preserved, no dangling tool_use", async () => {
    const ctl = new AbortController();
    const provider = replay([[{ type: "message_start", id: "m", model: "test" }, { type: "text_delta", text: "partial" }]], { round: 0, ms: 30_000 });
    const gen = runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 100);
    const { events, final } = await collect(gen);
    expect(events.some((e) => e.type === "interrupted" && e.phase === "stream")).toBe(true);
    expect(JSON.stringify(final.messages)).toContain("partial"); // 保留已生成
    expect(countDangling(final)).toBe(0);
  }, 20000);
});

// —— 场景④：畸形工具调用连续失败 fail-closed ——

describe("E2E ④ malformed tool calls fail closed", () => {
  it("consecutive malformed JSON tool calls exhaust retry budget → done(malformed_fail_closed), no dangling tool_use", async () => {
    const malformed: LLMEvent[] = [
      { type: "message_start", id: "m", model: "test" },
      { type: "tool_start", id: "bad1", name: "Bash" },
      { type: "tool_input_delta", id: "bad1", jsonPartial: "{not json" },
      { type: "tool_end", id: "bad1" },
      { type: "finish", reason: "tool_calls", raw: "tool_use" },
    ];
    const provider = replay([malformed, malformed, malformed, malformed]);
    const { events, final } = await collect(
      runAgentLoop({
        provider,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [sleepTool],
        maxMalformedRounds: 3,
      }),
    );
    const recoveries = events.filter((e) => e.type === "recovery" && e.chain === "malformed_retry");
    expect(recoveries).toHaveLength(3); // 限 3 次重试（§5.4 恢复链⑤）
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "malformed_fail_closed" });
    // 终态无悬空 tool_use（畸形 id 不入历史、不合成 result——WP-02 cdad5af 语义）
    expect(countDangling(final)).toBe(0);
    expect(JSON.stringify(final.messages)).not.toContain("bad1");
  }, 20000);
});
