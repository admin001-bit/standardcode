// L6 遥测 opt-in（v2.8 ENG-090 行 433 七事件 MUST 集合 + SEC-050 行 458 默认关/opt-in/可一键关 + §1.4 行 94 默认零上报；WP-06）。
// 架构位置（§5.4 行 282）：循环直至完成 → L2 计量 → L6 遥测——turn 界消费点在 repl（apps/cli），本模块只承载
// 事件契约 + opt-in 门 + 可注入 sink + SEC-030 脱敏桥（接缝⑮：遥测 × 转录 × 脱敏=SEC-030 同一单源函数三消费者）。
// 结构参考 kimi-code `packages/telemetry`（MIT，可复用级）：事件信封（eventId/sessionId/event/timestamp/properties
// 原语类型闸）+ transport/sink 分层 + 失败吞没（遥测绝不致会话失败）。差异 [自定]：kimi 缓冲+30s 定时 flush+
// 磁盘重试面首版省略（事件频率=每 turn 个位数，直写异步追加足矣；零定时器=关态与冷启动零挂载）。
// 事件名 = 自研前缀 `sc_` + ENG-090 条目名（[CC] `tengu_*` 体系仅口径注不抄名，ADR-0007 前缀族同源 [自定]）；
// 参数名对位行 433 原文枚举（snake_case 逐字）。无网络传输（真实上报端点无产品服务=卡边界；DoD⑥ grep 守卫）。

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./session-store.ts";

// —— 事件契约（行 433 原文枚举：turn_end（terminal_reason/turn_count/duration_ms）、query_error、
// tool_use_cancelled、auto_compact_circuit_breaker、max_tokens_reached、model_fallback_triggered、
// subagent_launch（outcome 枚举）；workflow/teams 事件 M6 不入）——

export const TELEMETRY_EVENT_PREFIX = "sc_";

export type TelemetryEventName =
  | "sc_turn_end"
  | "sc_query_error"
  | "sc_tool_use_cancelled"
  | "sc_auto_compact_circuit_breaker"
  | "sc_max_tokens_reached"
  | "sc_model_fallback_triggered"
  | "sc_subagent_launch";

/** 属性原语闸（kimi types.ts 同构）：遥测属性只收原语，拒绝嵌套对象入事件体。 */
export type TelemetryPrimitive = string | number | boolean;
export type TelemetryProps = Record<string, TelemetryPrimitive | undefined>;

export interface TelemetryEnvelope {
  eventId: string;
  sessionId: string;
  event: TelemetryEventName;
  /** epoch ms。 */
  timestamp: number;
  properties: TelemetryProps;
}

/** sink 注入面（卡边界：真实上报端点无产品服务——本地聚合/文件桩；服务对接=规格外不做）。 */
export interface TelemetrySink {
  write(events: readonly TelemetryEnvelope[]): void | Promise<void>;
}

// —— opt-in 门（SEC-050：默认关、opt-in、可一键关；键位 [自定] 走 ADR-0030 家族：env 逃逸舱 > settings > 默认关，
// 同 STANDARD_CODE_SANDBOX/sandbox.enabled 形制。非法值 fail-closed 不启用不猜）——

export const TELEMETRY_ENV_KEY = "STANDARD_CODE_TELEMETRY";
export const TELEMETRY_SETTINGS_KEY = "telemetry.enabled";

export interface TelemetryGateInput {
  env?: Record<string, string | undefined>;
  settingsEnabled?: unknown;
}

/**
 * 门序：env STANDARD_CODE_TELEMETRY（"1"/"0" 总闸，逃逸舱在位即凌驾 settings）> settings telemetry.enabled
 * （布尔字面 true 才启用）> 缺省关。env 其他值/非布尔 settings = fail-closed 不启用（不猜）。
 * 生效口径 [自定]：env 每 turn 重读（翻回即时，次 turn 生效）；settings 于会话装配//reload 解析（翻键次会话或
 * /reload 生效）——SEC-050 "可一键关"以 env 逃逸舱为即时通道。
 */
export function resolveTelemetryEnabled(input: TelemetryGateInput): boolean {
  const envVal = input.env?.[TELEMETRY_ENV_KEY];
  if (envVal !== undefined) return envVal === "1";
  if (input.settingsEnabled !== undefined) return input.settingsEnabled === true;
  return false;
}

// —— 门面（每会话一实例；关态=零 sink 构造、零定时器、零 fs、emit 纯布尔检查即返）——

export interface TelemetryFacade {
  isEnabled(): boolean;
  /** turn 界刷新（repl runPromptTurn 入口调用）：env 重读即时生效；settings 由调用方传现行合并值。 */
  refreshGate(input: TelemetryGateInput): void;
  /** turn_end（terminal_reason/turn_count/duration_ms）。turn_count=会话内已完成 turn 序数（1 起 [自定]）。 */
  turnEnd(p: { terminalReason: string; durationMs: number }): void;
  /** query_error（参数 [自定] {message}——脱敏经 SEC-030 单源后入事件体）。 */
  queryError(p: { message: string }): void;
  /** tool_use_cancelled（行 433 未列参数→空属性）。 */
  toolUseCancelled(): void;
  /** auto_compact_circuit_breaker（熔断器 trip 迁移即发；参数 [自定] {turn}）。 */
  autoCompactCircuitBreaker(p?: { turn?: number }): void;
  /** max_tokens_reached（产生口径 [自定]：恢复链③续写触发（recovery max_tokens_continue）每次即发；
   * 预算耗尽终态由 turn_end terminal_reason="truncated_gave_up" 承载，不双发）。 */
  maxTokensReached(p: { round: number }): void;
  /** model_fallback_triggered（契约+API 面：本仓无 model fallback 机制——B-03 不提前实现，
   * 产生点接线待机制落地（登记于结果页偏差）；参数 [自定] {from/to/reason}）。 */
  modelFallbackTriggered(p?: { from?: string; to?: string; reason?: string }): void;
  /** subagent_launch（outcome 枚举 [自定] {"launched","refused"}；refused 附 code）。 */
  subagentLaunch(p: { outcome: "launched" | "refused"; taskId?: string; agentId?: string; agentType?: string; refusedCode?: string }): void;
  /** 供测试/退出面等待在途写盘（文件桩）；无在途写即即返。 */
  flush(): Promise<void>;
}

export interface CreateTelemetryFacadeOptions {
  /** 会话 ID（懒取：session.id 于 repl 初始化时赋 UUID，传工厂）。 */
  sessionId?: string | (() => string);
  /** 初始门输入（env 缺省 process.env 由调用方显式传；settings 缺省关）。 */
  env?: Record<string, string | undefined>;
  settingsEnabled?: unknown;
  /** 测试注入 sink；缺席=默认文件桩。 */
  sink?: TelemetrySink;
  /** 文件桩基目录（缺省 ~/.standardcode；落 <base>/telemetry/events.ndjson）。 */
  baseDir?: string;
}

export function createTelemetryFacade(opts: CreateTelemetryFacadeOptions = {}): TelemetryFacade {
  let enabled = resolveTelemetryEnabled(opts);
  let sink: TelemetrySink | null = null; // 惰性构造：关态零构造（DoD② transport 零构造）
  let pending: Promise<void> | null = null;
  let turnCount = 0;

  const sessionIdOf = (): string => (typeof opts.sessionId === "function" ? opts.sessionId() : (opts.sessionId ?? ""));

  function sinkFor(): TelemetrySink {
    if (sink !== null) return sink;
    sink = opts.sink ?? defaultFileSink(opts.baseDir ?? join(homedir(), ".standardcode"), (p) => {
      pending = p;
    });
    return sink;
  }

  function emit(event: TelemetryEventName, properties: TelemetryProps): void {
    if (!enabled) return; // 关态：纯布尔检查即返（零构造/零队列/零网络/零写盘）
    try {
      const envelope: TelemetryEnvelope = {
        eventId: randomUUID(),
        sessionId: sessionIdOf(),
        event,
        timestamp: Date.now(),
        properties: sanitizeProps(properties),
      };
      const r = sinkFor().write([envelope]);
      if (r && typeof (r as Promise<void>).then === "function") {
        pending = Promise.resolve(r).catch(() => {});
      }
    } catch {
      // 遥测绝不致会话失败（kimi flushSync 同口径：telemetry must never make shutdown fail）
    }
  }

  return {
    isEnabled: () => enabled,
    refreshGate(input) {
      enabled = resolveTelemetryEnabled(input);
    },
    turnEnd(p) {
      turnCount++;
      emit("sc_turn_end", { terminal_reason: p.terminalReason, turn_count: turnCount, duration_ms: p.durationMs });
    },
    queryError(p) {
      emit("sc_query_error", { message: p.message });
    },
    toolUseCancelled() {
      emit("sc_tool_use_cancelled", {});
    },
    autoCompactCircuitBreaker(p) {
      emit("sc_auto_compact_circuit_breaker", p?.turn !== undefined ? { turn: p.turn } : {});
    },
    maxTokensReached(p) {
      emit("sc_max_tokens_reached", { round: p.round });
    },
    modelFallbackTriggered(p) {
      emit("sc_model_fallback_triggered", {
        ...(p?.from !== undefined ? { from: p.from } : {}),
        ...(p?.to !== undefined ? { to: p.to } : {}),
        ...(p?.reason !== undefined ? { reason: p.reason } : {}),
      });
    },
    subagentLaunch(p) {
      emit("sc_subagent_launch", {
        outcome: p.outcome,
        ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
        ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        ...(p.agentType !== undefined ? { agentType: p.agentType } : {}),
        ...(p.refusedCode !== undefined ? { refusedCode: p.refusedCode } : {}),
      });
    },
    async flush() {
      while (pending !== null) {
        const p = pending;
        try {
          await p;
        } catch {
          /* 吞没 */
        }
        if (pending === p) pending = null; // 写串行化下的简单排空（新写会在循环中重取）
        else break;
      }
    },
  };
}

/** SEC-030/接缝⑮：事件体字符串属性经 redactSecrets 同一单源（session-store 导出，非复制）；键名不脱敏（固定枚举）。 */
function sanitizeProps(props: TelemetryProps): TelemetryProps {
  const out: TelemetryProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

/** 默认文件桩：NDJSON 追加（异步 fire-and-forget、错误吞没、零定时器）。落点 [自定] <base>/telemetry/events.ndjson。 */
function defaultFileSink(baseDir: string, trackPending: (p: Promise<void>) => void): TelemetrySink {
  const dir = join(baseDir, "telemetry");
  const file = join(dir, "events.ndjson");
  return {
    write(events) {
      const line = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const p = mkdir(dir, { recursive: true })
        .then(() => appendFile(file, line, "utf8"))
        .catch(() => {}); // 遥测写盘失败静默（不致会话失败）
      trackPending(p);
      return p;
    },
  };
}
