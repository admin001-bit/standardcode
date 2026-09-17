// WP-06（M5）遥测 opt-in 单元测试（判据自足：板 WP-06 DoD①②④⑥ 之 platform 面）。
// DoD① 七事件逐枚产生=独立用例（名与参数对位 ENG-090 行 433 原文枚举，前缀 sc_ [自定]）；
// DoD② 关态：sink 零构造、零写盘（本文件以 sinkFactory 未调用+零事件断言；集成零写盘见 wp06-telemetry.test.ts）；
// DoD④ 脱敏：事件体字符串值经 SEC-030 同一单源 redactSecrets（session-store 导入=接缝⑮ 单源非复制）；
// DoD⑥ 非目标合规：grep 型守卫=遥测模块源码零网络原语、零定时器（默认上报路径不存在）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryFacade, resolveTelemetryEnabled, TELEMETRY_ENV_KEY, TELEMETRY_SETTINGS_KEY, type TelemetryEnvelope, type TelemetrySink } from "../src/telemetry.ts";
import { SECRET_PLACEHOLDER } from "../src/session-store.ts";

const TELEMETRY_SRC = readFileSync(fileURLToPath(new URL("../src/telemetry.ts", import.meta.url)), "utf8");

function memorySink(): TelemetrySink & { events: TelemetryEnvelope[] } {
  const events: TelemetryEnvelope[] = [];
  return { events, write: (es) => { events.push(...es); } };
}

const ENV_ON = { [TELEMETRY_ENV_KEY]: "1" };
const ENV_OFF = { [TELEMETRY_ENV_KEY]: "0" };

describe("DoD⑥ 门矩阵（SEC-050 默认关/opt-in；env 逃逸舱 > settings > 缺省关，非法 fail-closed 不猜）", () => {
  it("缺省（无 env 无 settings）=关", () => {
    expect(resolveTelemetryEnabled({})).toBe(false);
  });
  it("env=1 开；env=0 凌驾 settings true；env 非法值 fail-closed", () => {
    expect(resolveTelemetryEnabled({ env: ENV_ON })).toBe(true);
    expect(resolveTelemetryEnabled({ env: ENV_OFF, settingsEnabled: true })).toBe(false);
    expect(resolveTelemetryEnabled({ env: { [TELEMETRY_ENV_KEY]: "true" }, settingsEnabled: true })).toBe(false);
    expect(resolveTelemetryEnabled({ env: { [TELEMETRY_ENV_KEY]: "yes" } })).toBe(false);
  });
  it("settings telemetry.enabled：布尔 true 开；非布尔（字符串/数字）fail-closed；false 关", () => {
    expect(resolveTelemetryEnabled({ settingsEnabled: true })).toBe(true);
    expect(resolveTelemetryEnabled({ settingsEnabled: "true" })).toBe(false);
    expect(resolveTelemetryEnabled({ settingsEnabled: 1 })).toBe(false);
    expect(resolveTelemetryEnabled({ settingsEnabled: false })).toBe(false);
  });
});

describe("DoD② 关态：零构造、零事件、零写盘", () => {
  afterEach(() => {
    delete process.env[TELEMETRY_ENV_KEY];
  });
  it("关态 emit 纯布尔即返：注入 sink 零事件、isEnabled=false（transport 零构造的语义面）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: {}, sink });
    f.turnEnd({ terminalReason: "end", durationMs: 1 });
    f.queryError({ message: "x" });
    expect(sink.events).toHaveLength(0);
    expect(f.isEnabled()).toBe(false);
  });
  it("关态默认文件桩零触盘（baseDir 下无 telemetry 目录）", async () => {
    const base = mkdtempSync(join(tmpdir(), "sc-tel-off-"));
    const facade = createTelemetryFacade({ env: {}, baseDir: base });
    facade.turnEnd({ terminalReason: "end", durationMs: 1 });
    await facade.flush();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(base, "telemetry"))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("DoD① 七事件逐枚产生（名与参数对位行 433 原文；前缀 sc_ [自定]）", () => {
  it("turn_end：terminal_reason/turn_count/duration_ms（turn_count=会话序数 1 起 [自定]）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink, sessionId: "s1" });
    f.turnEnd({ terminalReason: "end", durationMs: 1234 });
    f.turnEnd({ terminalReason: "max_turns", durationMs: 20 });
    expect(sink.events.map((e) => e.event)).toEqual(["sc_turn_end", "sc_turn_end"]);
    expect(sink.events[0]!.properties).toEqual({ terminal_reason: "end", turn_count: 1, duration_ms: 1234 });
    expect(sink.events[1]!.properties).toEqual({ terminal_reason: "max_turns", turn_count: 2, duration_ms: 20 });
    expect(sink.events[0]!.sessionId).toBe("s1");
    expect(typeof sink.events[0]!.eventId).toBe("string");
    expect(typeof sink.events[0]!.timestamp).toBe("number");
  });
  it("query_error：message 属性（脱敏见 DoD④ 用例）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.queryError({ message: "stream failed" });
    expect(sink.events[0]!.event).toBe("sc_query_error");
    expect(sink.events[0]!.properties.message).toBe("stream failed");
  });
  it("tool_use_cancelled：空属性（行 433 未列参数）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.toolUseCancelled();
    expect(sink.events[0]!.event).toBe("sc_tool_use_cancelled");
    expect(sink.events[0]!.properties).toEqual({});
  });
  it("auto_compact_circuit_breaker：turn 属性 [自定]", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.autoCompactCircuitBreaker({ turn: 3 });
    expect(sink.events[0]!.event).toBe("sc_auto_compact_circuit_breaker");
    expect(sink.events[0]!.properties).toEqual({ turn: 3 });
  });
  it("max_tokens_reached：round 属性（恢复链③续写口径 [自定]）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.maxTokensReached({ round: 2 });
    expect(sink.events[0]!.event).toBe("sc_max_tokens_reached");
    expect(sink.events[0]!.properties).toEqual({ round: 2 });
  });
  it("model_fallback_triggered：契约+API 面（本仓无 fallback 机制=B-03 不提前实现，接线登记偏差）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.modelFallbackTriggered({ from: "m-a", to: "m-b", reason: "context_length" });
    f.modelFallbackTriggered();
    expect(sink.events[0]!.event).toBe("sc_model_fallback_triggered");
    expect(sink.events[0]!.properties).toEqual({ from: "m-a", to: "m-b", reason: "context_length" });
    expect(sink.events[1]!.properties).toEqual({});
  });
  it("subagent_launch：outcome 枚举 launched/refused + refusedCode [自定]", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.subagentLaunch({ outcome: "launched", taskId: "t1", agentId: "a1", agentType: "general-purpose" });
    f.subagentLaunch({ outcome: "refused", refusedCode: "concurrency_limit" });
    expect(sink.events[0]!.event).toBe("sc_subagent_launch");
    expect(sink.events[0]!.properties.outcome).toBe("launched");
    expect(sink.events[1]!.properties.outcome).toBe("refused");
    expect(sink.events[1]!.properties.refusedCode).toBe("concurrency_limit");
  });
});

describe("DoD④ 脱敏=SEC-030 同一单源（接缝⑮）", () => {
  it("事件体字符串值经 redactSecrets（sk- 形状→SECRET_PLACEHOLDER）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.queryError({ message: "provider down: key sk-abc123def456ghijk leaked" });
    expect(sink.events[0]!.properties.message).toBe(`provider down: key ${SECRET_PLACEHOLDER} leaked`);
  });
  it("结构证据：telemetry.ts 自 session-store.ts 导入 redactSecrets（单源非复制）", () => {
    const src = readFileSync(join(import.meta.dirname ?? ".", "../src/telemetry.ts"), "utf8");
    expect(src).toContain('import { redactSecrets } from "./session-store.ts"');
  });
});

describe("门刷新（SEC-050 一键关：env 每 turn 重读即时生效 [自定]）", () => {
  it("关→开：刷新后下一 emit 才写（sink 惰性构造）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: {}, sink });
    f.toolUseCancelled();
    f.refreshGate({ env: ENV_ON });
    f.toolUseCancelled();
    expect(sink.events).toHaveLength(1);
  });
  it("开→关：翻回即时停发（不抛）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.toolUseCancelled();
    f.refreshGate({ env: ENV_OFF });
    f.toolUseCancelled();
    expect(sink.events).toHaveLength(1);
  });
});

describe("默认文件桩：NDJSON 落盘（opt-in 态；落点 [自定] <base>/telemetry/events.ndjson）", () => {
  it("写入可解析 NDJSON 且 flush 可等待", async () => {
    const base = mkdtempSync(join(tmpdir(), "sc-tel-on-"));
    const f = createTelemetryFacade({ env: ENV_ON, baseDir: base, sessionId: () => "sid-42" });
    f.turnEnd({ terminalReason: "end", durationMs: 5 });
    await f.flush();
    const lines = readFileSync(join(base, "telemetry", "events.ndjson"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as TelemetryEnvelope;
    expect(parsed.event).toBe("sc_turn_end");
    expect(parsed.sessionId).toBe("sid-42");
    expect(parsed.properties.terminal_reason).toBe("end");
    rmSync(base, { recursive: true, force: true });
  });
});

describe("DoD⑥ grep 型守卫：遥测模块零网络原语、零定时器（默认上报路径不存在）", () => {
  const src = TELEMETRY_SRC;
  it("无 fetch/XHR/http(s).request/net.connect/dgram/WebSocket/http(s) 模块导入", () => {
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("XMLHttpRequest");
    expect(src).not.toMatch(/https?\.request/);
    expect(src).not.toMatch(/\bnet\.(connect|Socket)/);
    expect(src).not.toContain("dgram");
    expect(src).not.toContain("WebSocket");
    expect(src).not.toMatch(/from "node:https?"/);
    expect(src).not.toMatch(/require\("https?"\)/);
  });
  it("零定时器（setInterval/setTimeout/setImmediate 不存在=关态与开态均零挂载）", () => {
    expect(src).not.toMatch(/setInterval|setTimeout|setImmediate/);
  });
});
