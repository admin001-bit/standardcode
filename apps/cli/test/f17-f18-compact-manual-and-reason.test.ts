// F17/F18（2026-09-29 实测）修复回归（CLI 侧；另含 F16 的 repl→loop 接线用例）：
//  ①手动 /compact 须按 CTX-035 手动语义解除闸②/闸③（resetBreaker 原零生产调用方；且手动路径 recordCompactSuccess
//    的 refilledFast 判定恒真 → 计数不降反升，被 rapid-refill blocked 的会话靠 /compact 解不开）；
//  ②会话级 turnIndex 每轮自增（协调器 turn 基准，原传 harness toolRounds 每轮 0 起 → 跨轮重置判定失效）；
//  ③context_exhausted 的闸拒理由上屏（renderTurn；原仅 "start a new session" 文案）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UsageMeter } from "@standardcode/context";
import type { AgentEvent, TurnState } from "@standardcode/harness";
import { ProviderError, type LLMEvent, type LLMRequest, type ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
import { renderTurn } from "../src/render.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `sc-f16-${tag}-`));
  dirs.push(d);
  return d;
}

const REPLY: LLMEvent[] = [
  { type: "text_delta", text: "reply" } as LLMEvent,
  { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent,
];

function scriptedProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    // eslint-disable-next-line require-yield
    async *stream(_req: LLMRequest) {
      for (const ev of REPLY) yield ev;
    },
  };
}

/** 建会话 → prep（预置协调器状态）→ 跑命令行（/compact 需真实 provider 产摘要文本）。 */
async function runLines(lines: string[], prep?: (s: ReturnType<typeof createSession>) => void) {
  const repo = tmp("repo");
  const home = tmp("home");
  const baseDir = tmp("bd");
  mkdirSync(repo, { recursive: true });
  const provider = scriptedProvider();
  const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
  prep?.(session);
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir });
  return { out, session };
}

describe("手动 /compact 解除压缩闸（F16 修复）", () => {
  it("rapid-refill blocked 状态被 /compact 解除（resetBreaker 接线）", async () => {
    const { out, session } = await runLines(["/compact", "/exit"], (s) => {
      s.autocompact.recordCompactSuccess(1500, 1);
      s.autocompact.recordCompactSuccess(1500, 2); // 紧凑连发：refilledFast → streak=1
      s.autocompact.recordCompactSuccess(1500, 3); // 再连发 → streak=2
      const d = s.autocompact.evaluate(170_000, 4); // 距上次压缩 <3 turn 又满 → streak=3 → blocked
      expect(d.shouldCompact).toBe(false);
      expect(d.reason).toContain("rapid-refill");
    });
    expect(out).toContain("[compact]");
    expect(session.autocompact.state.rapidRefillStreak).toBe(0); // 修复前＝3（resetBreaker 未接线，且记账再 +1）
    expect(session.autocompact.state.tripped).toBe(false);
    // 下一轮（会话轮序 +1）达阈即应恢复自动压缩：修复前 streak 残留 ≥3 → 闸③ 直接 blocked=false
    expect(session.autocompact.evaluate(170_000, session.turnIndex + 1).shouldCompact).toBe(true);
  });

  it("熔断器（tripped）同样被 /compact 清除（非回归守卫）", async () => {
    const { session } = await runLines(["/compact", "/exit"], (s) => {
      s.autocompact.recordCompactFailure(1);
      s.autocompact.recordCompactFailure(2);
      s.autocompact.recordCompactFailure(3);
      expect(s.autocompact.state.tripped).toBe(true);
    });
    expect(session.autocompact.state.tripped).toBe(false);
    expect(session.autocompact.evaluate(170_000, session.turnIndex + 1).shouldCompact).toBe(true);
  });
});

describe("会话轮序 turnIndex（F16 修复）", () => {
  it("每条 prompt 轮自增；命令轮不计", async () => {
    const { session } = await runLines(["q1", "q2", "/compact", "/exit"]);
    expect(session.turnIndex).toBe(2); // 修复前该字段不存在（协调器 turn 恒为 harness toolRounds）
  });

  it("prompt 轮触发 context_length：协调器 evaluate 收到会话轮序（接线，非仅字段自增）", async () => {
    const repo = tmp("repo-wire");
    const home = tmp("home-wire");
    const baseDir = tmp("bd-wire");
    mkdirSync(repo, { recursive: true });
    let calls = 0;
    const provider: ProviderAdapter = {
      capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: [], explicitBreakpoints: false } }),
      countTokens: async () => 150_000,
      // eslint-disable-next-line require-yield
      async *stream() {
        calls++;
        throw new ProviderError("context_length", "prompt is too long: 200000 tokens > 128000 maximum");
      },
    };
    const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
    const seen: number[] = [];
    const orig = session.autocompact.evaluate.bind(session.autocompact);
    session.autocompact.evaluate = (used, turn) => {
      seen.push(turn);
      return orig(used, turn);
    };
    let out = "";
    const io: ReplIo = {
      lines: (async function* () {
        yield "q1";
        yield "/exit";
      })(),
      write: (s) => (out += s),
      close: () => {},
    };
    await runRepl({ session, io, baseDir });
    expect(calls).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(1); // 会话轮序（首轮）；修复前＝harness state.toolRounds＝0
  });
});

describe("context_exhausted 理由上屏（F16 修复）", () => {
  const END: TurnState = { messages: [], toolRounds: 0, continuations: 0, malformedRounds: 0, usage: null };
  async function render(ev: AgentEvent): Promise<string> {
    let out = "";
    const gen = (async function* () {
      yield ev;
      yield { type: "done", reason: "context_exhausted" } as AgentEvent;
      return END;
    })();
    await renderTurn(gen, (s) => (out += s), new UsageMeter());
    return out;
  }

  it("带 reason：闸拒指引（含手动 /compact）上屏", async () => {
    const out = await render({ type: "context_exhausted", reason: "circuit breaker tripped (consecutive failures); use /compact manually" });
    expect(out).toContain("use /compact manually");
    expect(out).not.toContain("start a new session"); // 修复前只有 CTX-101 文案（误导：手动压缩可解）
  });

  it("无 reason：原 CTX-101 文案不回归", async () => {
    const out = await render({ type: "context_exhausted" });
    expect(out).toContain("start a new session (CTX-101)");
  });
});
