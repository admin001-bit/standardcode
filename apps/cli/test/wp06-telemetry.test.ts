// WP-06（M5）遥测 opt-in 集成测试（判据自足：板 WP-06 DoD①②③⑤ 之 repl/产生点接线面）。
// 七产生点接线落位：turn_end/query_error=runPromptTurn 终态双路（repl.ts）；tool_use_cancelled/max_tokens_reached=
// renderTurn 事件流观察面（render.ts onEvent）；auto_compact_circuit_breaker=autocompact.perform 失败登记+trip 迁移
// （repl.ts performAutoCompactWithTelemetry）；subagent_launch=/subtask spawn 双分支（repl.ts）；model_fallback_triggered
// =契约+API 面（机制缺位=B-03 不提前实现，platform 单测覆盖）。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, ProviderAdapter } from "@standardcode/providers";
import type { TelemetryEnvelope } from "@standardcode/platform";
import { createSession } from "../src/session.ts";
import { createCommandContext, runRepl, type ReplDeps } from "../src/repl.ts";
import { renderTurn } from "../src/render.ts";
import type { AgentEvent, TurnState } from "@standardcode/harness";
import { UsageMeter } from "@standardcode/context";
import { createTelemetryFacade, TELEMETRY_ENV_KEY, type TelemetrySink } from "@standardcode/platform";

function memorySink(): TelemetrySink & { events: TelemetryEnvelope[] } {
  const events: TelemetryEnvelope[] = [];
  return { events, write: (es) => { events.push(...es); } };
}

const REPLY: LLMEvent[] = [
  { type: "text_delta", text: "reply" } as LLMEvent,
  { type: "usage", usage: { inputTokens: 11, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent,
  { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent,
];

function scriptedProvider(turns: LLMEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      for (const ev of turns[Math.min(i, turns.length - 1)]) yield ev;
      i++;
    },
  };
}

function fixture(provider: ProviderAdapter, sink: TelemetrySink, home?: string): { session: ReturnType<typeof createSession>; deps: ReplDeps; home: string; cleanup: () => void } {
  const h = home ?? mkdtempSync(join(tmpdir(), "sc-wp06-home-"));
  const root = mkdtempSync(join(tmpdir(), "sc-wp06-cwd-"));
  const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: root, projectRoot: root, home: h, trusted: true, telemetrySink: sink });
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: h };
  return { session, deps, home: h, cleanup: () => { rmSync(h, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

async function runLines(deps: ReplDeps, lines: string[]): Promise<void> {
  await runRepl({ ...deps, io: { ...deps.io, lines: (async function* () { for (const l of lines) yield l; })() } });
}

/** DoD① tool_use_cancelled 确定性形态：turn1 流内发完整 tool_use 后挂起 → 测试侧 abort →
 * agent-loop 停流路径（pending tools → interrupted phase:"tool"）。 */
function abortDuringStreamProvider(): ProviderAdapter & { toolEmitted: Promise<void> } {
  let release!: () => void;
  const toolEmitted = new Promise<void>((r) => (release = r));
  let i = 0;
  return {
    toolEmitted,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      if (i++ === 0) {
        yield { type: "tool_start", id: "t1", name: "Bash" } as LLMEvent;
        yield { type: "tool_input_delta", id: "t1", jsonPartial: '{"command":"echo hi"' } as LLMEvent;
        yield { type: "tool_input_delta", id: "t1", jsonPartial: "}" } as LLMEvent;
        yield { type: "tool_end", id: "t1" } as LLMEvent;
        release();
        await new Promise(() => {}); // 挂起：abort 竞速胜出 → 停流（pending tool_use 被取消）
      }
      for (const ev of REPLY) yield ev;
    },
  };
}

beforeEach(() => {
  process.env[TELEMETRY_ENV_KEY] = "1"; // 本文件内开态基线（vitest 文件隔离，afterEach 清理）
});
afterEach(() => {
  delete process.env[TELEMETRY_ENV_KEY];
});

describe("DoD① turn_end（terminal_reason/turn_count/duration_ms）", () => {
  it("正常完成轮：terminal_reason=end、turn_count=1、duration_ms 为数值", async () => {
    const sink = memorySink();
    const { deps, cleanup } = fixture(scriptedProvider([REPLY, REPLY]), sink);
    try {
      await runLines(deps, ["hello"]);
      const te = sink.events.filter((e) => e.event === "sc_turn_end");
      expect(te).toHaveLength(1);
      expect(te[0]!.properties.terminal_reason).toBe("end");
      expect(te[0]!.properties.turn_count).toBe(1);
      expect(typeof te[0]!.properties.duration_ms).toBe("number");
    } finally {
      cleanup();
    }
  });
});

describe("DoD① query_error（catch 路径；错误消息经 SEC-030 单源脱敏）", () => {
  it("provider 抛错 → sc_query_error（含 [REDACTED]）+ sc_turn_end(terminal_reason=error)", async () => {
    const sink = memorySink();
    const boom: ProviderAdapter = {
      ...scriptedProvider([REPLY]),
      async *stream(): AsyncGenerator<LLMEvent> {
        throw new Error("provider down: key sk-abc123def456ghijk leaked");
      },
    };
    const { deps, cleanup } = fixture(boom, sink);
    try {
      await runLines(deps, ["hello"]);
      const qe = sink.events.find((e) => e.event === "sc_query_error");
      expect(qe).toBeDefined();
      expect(String(qe!.properties.message)).toContain("[REDACTED]");
      expect(String(qe!.properties.message)).not.toContain("sk-abc123def456ghijk");
      const te = sink.events.filter((e) => e.event === "sc_turn_end");
      expect(te).toHaveLength(1);
      expect(te[0]!.properties.terminal_reason).toBe("error");
      expect(te[0]!.properties.turn_count).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("DoD① max_tokens_reached（恢复链③续写触发口径 [自定]）", () => {
  it("finish=truncated → recovery max_tokens_continue → sc_max_tokens_reached(round=1)，终轮 end", async () => {
    const sink = memorySink();
    const truncatedTurn: LLMEvent[] = [
      { type: "text_delta", text: "partial" } as LLMEvent,
      { type: "finish", reason: "truncated", raw: "max_tokens" } as LLMEvent,
    ];
    const { deps, cleanup } = fixture(scriptedProvider([truncatedTurn, REPLY]), sink);
    try {
      await runLines(deps, ["hello"]);
      const mt = sink.events.find((e) => e.event === "sc_max_tokens_reached");
      expect(mt).toBeDefined();
      expect(mt!.properties.round).toBe(1);
      const te = sink.events.filter((e) => e.event === "sc_turn_end");
      expect(te).toHaveLength(1);
      expect(te[0]!.properties.terminal_reason).toBe("end");
    } finally {
      cleanup();
    }
  });
});

describe("DoD① tool_use_cancelled（停流路径 pending tool_use；renderTurn onEvent 观察面）", () => {
  it("流中 abort → interrupted phase:tool → sc_tool_use_cancelled + turn_end(interrupted)", async () => {
    const sink = memorySink();
    const provider = abortDuringStreamProvider();
    const { session, deps, cleanup } = fixture(provider, sink);
    try {
      const running = runLines(deps, ["hello"]);
      await provider.toolEmitted; // 流已发出完整 tool_use 并挂起
      session.activeAbort!.abort(); // 确定性中断（§8.4）
      await running;
      const tc = sink.events.find((e) => e.event === "sc_tool_use_cancelled");
      expect(tc).toBeDefined();
      const te = sink.events.filter((e) => e.event === "sc_turn_end");
      expect(te).toHaveLength(1);
      expect(te[0]!.properties.terminal_reason).toBe("interrupted");
    } finally {
      cleanup();
    }
  });
});

describe("DoD① auto_compact_circuit_breaker（perform 失败登记+trip 迁移；CTX-035 闸② 生产接线 [偏差]）", () => {
  it("预置 2 次失败 → 本轮压缩失败=第 3 次 → trip 迁移发事件，turn 以 error 终止（重抛语义零变）", async () => {
    const sink = memorySink();
    let round = 0;
    const compactFail: ProviderAdapter = {
      capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
      countTokens: async () => 0,
      async *stream(): AsyncGenerator<LLMEvent> {
        round++;
        if (round === 1) {
          yield { type: "usage", usage: { inputTokens: 190_000, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
          const { ProviderError } = await import("@standardcode/providers");
          throw new ProviderError("context_length", "prompt is too long: 250000 tokens > 200000 maximum");
        }
        throw new Error("compaction exploded"); // round2=runCompaction 摘要请求（perform 失败源）
      },
    };
    const { session, deps, cleanup } = fixture(compactFail, sink);
    try {
      session.autocompact.recordCompactFailure(0); // 预置连续失败 ×2（协调器公开 API=合法状态装填）
      session.autocompact.recordCompactFailure(1);
      expect(session.autocompact.state.tripped).toBe(false);
      await runLines(deps, ["hello"]);
      const cb = sink.events.find((e) => e.event === "sc_auto_compact_circuit_breaker");
      expect(cb).toBeDefined();
      expect(session.autocompact.state.tripped).toBe(true);
      const qe = sink.events.find((e) => e.event === "sc_query_error");
      expect(qe).toBeDefined(); // 重抛语义零变：turn 仍以 query_error 终止
      const te = sink.events.find((e) => e.event === "sc_turn_end");
      expect(te!.properties.terminal_reason).toBe("error");
    } finally {
      cleanup();
    }
  });
});

describe("DoD① subagent_launch（/subtask 唯一生产 spawn 面；outcome 枚举 [自定]）", () => {
  function commandFixture(provider: ProviderAdapter, sink: TelemetrySink) {
    const { session, deps, cleanup } = fixture(provider, sink);
    const ctx = createCommandContext(deps);
    return { session, ctx, cleanup };
  }
  it("launched：同步 /subtask 成功 → outcome=launched + taskId", async () => {
    const sink = memorySink();
    const { session, ctx, cleanup } = commandFixture(scriptedProvider([REPLY, REPLY]), sink);
    try {
      session.messages.push({ role: "user", content: [{ type: "text", text: "parent turn" }] });
      await ctx.subtask("check the files");
      const sl = sink.events.find((e) => e.event === "sc_subagent_launch");
      expect(sl).toBeDefined();
      expect(sl!.properties.outcome).toBe("launched");
      expect(typeof sl!.properties.taskId).toBe("string");
    } finally {
      cleanup();
    }
  });
  it("refused：并发槽满（20）→ outcome=refused + refusedCode=concurrency_limit", async () => {
    const sink = memorySink();
    const { session, ctx, cleanup } = commandFixture(scriptedProvider([REPLY, REPLY]), sink);
    try {
      session.messages.push({ role: "user", content: [{ type: "text", text: "parent turn" }] });
      for (let i = 0; i < 20; i++) {
        const t = session.taskRegistry.register({ agentId: `seed-${i}`, agentType: "general-purpose", description: "seed", isBackgrounded: true });
        session.taskRegistry.takeConcurrencySlot(t.taskId);
      }
      await ctx.subtask("check the files");
      const sl = sink.events.find((e) => e.event === "sc_subagent_launch");
      expect(sl).toBeDefined();
      expect(sl!.properties.outcome).toBe("refused");
      expect(sl!.properties.refusedCode).toBe("concurrency_limit");
    } finally {
      cleanup();
    }
  });
});

describe("DoD② 关态集成：缺省关=全程零事件、零写盘（行 94/458 默认零上报）", () => {
  it("无 env 无 settings：会话+完整 turn 零事件；文件桩目录不存在", async () => {
    delete process.env[TELEMETRY_ENV_KEY];
    const sink = memorySink();
    const home = mkdtempSync(join(tmpdir(), "sc-wp06-off-"));
    const { deps, cleanup } = fixture(scriptedProvider([REPLY, REPLY]), sink, home);
    try {
      expect(deps.session.telemetry.isEnabled()).toBe(false);
      await runLines(deps, ["hello"]);
      expect(sink.events).toHaveLength(0);
      expect(existsSync(join(home, ".standardcode", "telemetry"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("DoD③ 开态落点：env/settings 门序（settings 布尔 true 开；非法 fail-closed 同 sandbox 家族）", () => {
  it("settings telemetry.enabled=true（无 env）→ 门开；settings 非布尔 → fail-closed 不启用", () => {
    delete process.env[TELEMETRY_ENV_KEY];
    const sink = memorySink();
    const root = mkdtempSync(join(tmpdir(), "sc-wp06-set-"));
    try {
      const s1 = createSession({ provider: scriptedProvider([REPLY]), catalog: ["m-a"], model: "m-a", cwd: root, projectRoot: root, trusted: true, telemetrySink: sink, flagOverrides: { telemetry: { enabled: true } } });
      expect(s1.telemetry.isEnabled()).toBe(true);
      const s2 = createSession({ provider: scriptedProvider([REPLY]), catalog: ["m-a"], model: "m-a", cwd: root, projectRoot: root, trusted: true, telemetrySink: sink, flagOverrides: { telemetry: { enabled: "yes" } } });
      expect(s2.telemetry.isEnabled()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("DoD⑤ 冷启动不挂：关态下 renderTurn/门刷新零开销路径（观察面缺席零调用）", () => {
  it("renderTurn 不传 onEvent（既有消费形制零变化）+门面 turn 刷新在关态即返", async () => {
    const sink = memorySink();
    const facade = createTelemetryFacade({ env: {}, sink });
    async function* gen(): AsyncGenerator<AgentEvent, TurnState, unknown> {
      yield { type: "text_delta", text: "x" } as AgentEvent;
      const empty: TurnState = { messages: [], toolRounds: 0, continuations: 0, malformedRounds: 0, usage: null };
      return empty;
    }
    const final = await renderTurn(gen(), () => {}, new UsageMeter(), { onDone: () => {} });
    expect(final.toolRounds).toBe(0);
    facade.refreshGate({ env: {} });
    expect(sink.events).toHaveLength(0);
  });
});
