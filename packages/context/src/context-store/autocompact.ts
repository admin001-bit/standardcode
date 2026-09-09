// AutoCompact 触发判定与协调器（v2.8 §7.2 CTX-033/034/035、CTX-101 交接；§12.2 单元行阈值表测；§2 行 M2 DoD①）。
// 机制级锚点：claude-code-context-control.md §2（一手核验报告；_440.js L132212-132440 逐行一致声明）：
//   常量 MYn=13000(summary buffer)/OYn=3000(blocking headroom)/kHe=0.2(默认 buffer fraction)/WYn=20000(warn margin)
//   预压缩阈值 cCt = min(window − round(window·bufferFraction), vHe)
//   vHe = window − 13000；PCT_OVERRIDE(0<pct≤100) → min(⌊window·pct/100⌋, window−13000)
//   警告线 = compactThreshold − 20000；阻断线 = blockingLimit − 3000
//   三级判定：used≥blockedAt→blocked；enabled&&used≥threshold→compact；used≥warnAt→warn；else ok
// 窗口解析（CTX-034）：env > settings > clientdata > experiment > model-default > unknown > auto，clamp 到模型窗口；
//   手动窗口界 100k–1M（THe=1e5/fCt=1e6）；"200k"/"1m"/数字（≥100k 绝对值；[100,100k) 视为 k）/"auto"。
// 四道闸（CTX-035）：总开关→熔断器(连续失败≥3)→rapid-refill 防抖(压缩后 3 turn 内又填满且连续≥3 次→blocked)→阈值判定。
// 重压缩链：willRetriggerNextTurn = postCompactTokens ≥ threshold；turnsSincePreviousCompact 追踪。
// 环境名映射 [自定]：STANDARD_CODE_AUTOCOMPACT_PCT_OVERRIDE（v2.8 原文名）/STANDARD_CODE_AUTO_COMPACT_WINDOW/
//   STANDARD_CODE_DISABLE_AUTO_COMPACT（对应 [CC] CLAUDE_* 三键）；settings 键 autocompact.window/enabled（ADR-0030 增补）。

export const AUTOCOMPACT_BUFFER = 13000; // MYn
export const AUTOCOMPACT_BLOCKING_HEADROOM = 3000; // OYn
export const AUTOCOMPACT_DEFAULT_BUFFER_FRACTION = 0.2; // kHe
export const AUTOCOMPACT_WARN_MARGIN = 20000; // WYn
export const MANUAL_WINDOW_MIN = 100_000; // THe
export const MANUAL_WINDOW_MAX = 1_000_000; // fCt
export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const RAPID_REFILL_TURN_WINDOW = 3;
export const RAPID_REFILL_TRIP_COUNT = 3;
export const UNKNOWN_MODEL_ASSUMED_WINDOW = 200_000; // [自定] 未知模型假定窗口（附提示，CTX-034）

export const ENV_PCT_OVERRIDE = "STANDARD_CODE_AUTOCOMPACT_PCT_OVERRIDE";
export const ENV_WINDOW = "STANDARD_CODE_AUTO_COMPACT_WINDOW";
export const ENV_DISABLE = "STANDARD_CODE_DISABLE_AUTO_COMPACT";

/** 阈值三元组 + 三级判定（uCt 同构）。 */
export interface CompactThresholds {
  /** 预压缩触发点（cCt）。 */
  compactAt: number;
  /** 警告线 = compactAt − 20000。 */
  warnAt: number;
  /** 阻断线 = blockingLimit − 3000。 */
  blockedAt: number;
}

/** vHe：summary-buffer 触发基线；PCT_OVERRIDE(0<pct≤100) → min(⌊window·pct/100⌋, window−13000)。 */
export function summaryBufferBaseline(windowTokens: number, pctOverride?: number): number {
  const base = windowTokens - AUTOCOMPACT_BUFFER;
  if (pctOverride !== undefined && Number.isFinite(pctOverride) && pctOverride > 0 && pctOverride <= 100) {
    return Math.min(Math.floor((windowTokens * pctOverride) / 100), base);
  }
  return base; // pct 边界 0/>100/NaN → 无效回落（§12.2 pct 边界）
}

/** cCt：预压缩阈值 = min(window − round(window·bufferFraction), vHe)。 */
export function compactThreshold(windowTokens: number, pctOverride?: number, bufferFraction = AUTOCOMPACT_DEFAULT_BUFFER_FRACTION): number {
  const buffered = windowTokens - Math.round(windowTokens * bufferFraction);
  return Math.min(buffered, summaryBufferBaseline(windowTokens, pctOverride));
}

export function thresholdsFor(windowTokens: number, blockingLimit: number, pctOverride?: number): CompactThresholds {
  const compactAt = compactThreshold(windowTokens, pctOverride);
  return {
    compactAt,
    warnAt: compactAt - AUTOCOMPACT_WARN_MARGIN,
    blockedAt: blockingLimit - AUTOCOMPACT_BLOCKING_HEADROOM,
  };
}

export type UsageLevel = "ok" | "warn" | "compact" | "blocked";

/** 三级指示（uCt 同构）：blocked 恒赢 > compact（enabled 才生效）> warn > ok。 */
export function usageLevel(used: number, t: CompactThresholds, enabled = true): UsageLevel {
  if (used >= t.blockedAt) return "blocked";
  if (enabled && used >= t.compactAt) return "compact";
  if (used >= t.warnAt) return "warn";
  return "ok";
}

// —— 窗口解析（CTX-034）——

export interface WindowSourceInput {
  env?: Record<string, string | undefined>;
  settings?: { window?: unknown };
  /** clientdata/experiment 来源 M2 无载体——留接口位（登记偏差）。 */
  clientdata?: unknown;
  experiment?: unknown;
  /** 模型目录窗口（model-default）。 */
  modelDefault?: number;
}

export interface ResolvedWindow {
  window: number;
  /** 命中的来源（高→低第一个有效值）。 */
  source: "env" | "settings" | "clientdata" | "experiment" | "model-default" | "unknown-assumed";
  /** 未知模型假定（须提示用户，CTX-034）。 */
  assumed: boolean;
  /** 非法手动值被拒记录（提示文案素材）。 */
  rejected?: string;
}

/** 无后缀裸数解释：≥100k 视为绝对 token 数（×1000 必越 1M 上界，k 解释恒拒）；[100,100k) 视为 k（"150"=150k）；<100 原值交界校验。 */
function bareWindowValue(n: number): number {
  if (n >= MANUAL_WINDOW_MIN) return n;
  if (n >= 100) return n * 1000;
  return n;
}

/** 手动窗口值解析："auto"/"200k"/"1m"/数字（≥100k 视为绝对值；[100,100k) 视为 k）；界 100k–1M（CTX-036）。 */
export function parseManualWindow(raw: unknown): { value: number | null; rejected?: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (raw === "auto") return { value: null }; // auto=交回 model-default/自动
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return validateManual(bareWindowValue(raw), String(raw));
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    const m = /^([0-9.]+)\s*(k|m)?$/.exec(s);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        const v = m[2] === "m" ? n * 1_000_000 : m[2] === "k" ? n * 1000 : bareWindowValue(n);
        return validateManual(v, raw);
      }
    }
    return { value: null, rejected: raw };
  }
  return { value: null, rejected: String(raw) };
}

function validateManual(v: number, raw: string): { value: number | null; rejected?: string } {
  if (!Number.isFinite(v) || v < MANUAL_WINDOW_MIN || v > MANUAL_WINDOW_MAX) return { value: null, rejected: raw };
  return { value: v };
}

/**
 * 窗口解析链（CTX-034）：env > settings > clientdata > experiment > model-default > unknown-assumed。
 * clientdata/experiment M2 无载体（传 undefined 即跳过）。最终 clamp 到模型窗口（已知时）。
 */
export function resolveAutoCompactWindow(input: WindowSourceInput): ResolvedWindow {
  const clamp = (v: number): number => (input.modelDefault !== undefined ? Math.min(v, input.modelDefault) : v);
  const env = input.env ?? {};
  const envRaw = env[ENV_WINDOW];
  if (envRaw !== undefined) {
    const { value, rejected } = parseManualWindow(envRaw);
    if (value !== null) return { window: clamp(value), source: "env", assumed: false };
    return { window: input.modelDefault ?? UNKNOWN_MODEL_ASSUMED_WINDOW, source: input.modelDefault !== undefined ? "model-default" : "unknown-assumed", assumed: input.modelDefault === undefined, rejected: rejected ?? envRaw };
  }
  if (input.settings?.window !== undefined) {
    const { value, rejected } = parseManualWindow(input.settings.window);
    if (value !== null) return { window: clamp(value), source: "settings", assumed: false };
    return { window: input.modelDefault ?? UNKNOWN_MODEL_ASSUMED_WINDOW, source: input.modelDefault !== undefined ? "model-default" : "unknown-assumed", assumed: input.modelDefault === undefined, rejected: rejected ?? String(input.settings.window) };
  }
  if (input.clientdata !== undefined) {
    const { value } = parseManualWindow(input.clientdata);
    if (value !== null) return { window: clamp(value), source: "clientdata", assumed: false };
  }
  if (input.experiment !== undefined) {
    const { value } = parseManualWindow(input.experiment);
    if (value !== null) return { window: clamp(value), source: "experiment", assumed: false };
  }
  if (input.modelDefault !== undefined) {
    return { window: input.modelDefault, source: "model-default", assumed: false };
  }
  // 未知模型：假定窗口 + 提示（CTX-034）
  return { window: UNKNOWN_MODEL_ASSUMED_WINDOW, source: "unknown-assumed", assumed: true };
}

/** 未知模型提示（[CC] 同构文案要点：[1m] 后缀/env 覆盖/settings 映射——自研键位）。 */
export function unknownModelHint(model: string): string {
  return `unknown model window: ${model} assumed ${UNKNOWN_MODEL_ASSUMED_WINDOW} tokens. Set STANDARD_CODE_AUTO_COMPACT_WINDOW, or map the model in settings (autocompact.window).`;
}

// —— 协调器（CTX-035 四道闸 + 重压缩链）——

export interface CompactionCoordinatorConfig {
  enabled: boolean;
  pctOverride?: number;
  window: number;
  blockingLimit: number;
}

export interface CompactDecision {
  level: UsageLevel;
  /** level=compact 且四道闸全开 → true（触发压缩；执行体=WP-04）。 */
  shouldCompact: boolean;
  /** rapid-refill trip 或熔断后的阻断说明（交还用户）。 */
  reason?: string;
}

export interface CoordinatorState {
  /** 熔断器：连续压缩失败计数；≥3 → tripped（仅手动 /compact 或 reset 解除）。 */
  consecutiveFailures: number;
  tripped: boolean;
  /** rapid-refill：压缩后 3 turn 内又达阈值 → 计数；连续 ≥3 次 → blocked（交还用户）。 */
  rapidRefillStreak: number;
  /** 上次压缩时的 turn 序号（重压缩链追踪）。 */
  previousCompactTurn: number | null;
  compactCount: number;
  /** 上一轮压缩后的 token（willRetriggerNextTurn 判定）。 */
  postCompactTokens: number | null;
}

export interface CompactionCoordinator {
  readonly state: CoordinatorState;
  /** 每 turn 入口：四道闸依次判定（CTX-035 原文顺序：总开关→熔断器→rapid-refill→阈值判定）。 */
  evaluate(used: number, turn: number): CompactDecision;
  /** 压缩执行成功回填（WP-04 调用）：重压缩链追踪 + rapid-refill 观察窗口开启。 */
  recordCompactSuccess(postCompactTokens: number, turn: number): void;
  recordCompactFailure(turn: number): void;
  /** 手动 /compact：解除熔断与 rapid-refill blocked（CTX-035 手动通道）。 */
  resetBreaker(): void;
  /** 手动窗口校验（CTX-036 100k–1M；/compact 手动窗口用）。 */
  validateManualWindow(raw: unknown): { value: number | null; rejected?: string };
}

export function createCompactionCoordinator(config: CompactionCoordinatorConfig): CompactionCoordinator {
  const state: CoordinatorState = {
    consecutiveFailures: 0,
    tripped: false,
    rapidRefillStreak: 0,
    previousCompactTurn: null,
    compactCount: 0,
    postCompactTokens: null,
  };
  const thresholds = (): CompactThresholds => thresholdsFor(config.window, config.blockingLimit, config.pctOverride);

  return {
    state,
    validateManualWindow: (raw) => parseManualWindow(raw),
    evaluate(used: number, turn: number): CompactDecision {
      // 闸① 总开关（CTX-033 不用百分比默认；总开关关闭 → 仅 blocked 指示，不触发）
      if (!config.enabled) {
        return { level: usageLevel(used, thresholds(), false), shouldCompact: false, reason: "autocompact disabled" };
      }
      const t = thresholds();
      // 闸② 熔断器（连续失败 ≥3 → 停止自动压缩）
      if (state.tripped) {
        return { level: usageLevel(used, t), shouldCompact: false, reason: "circuit breaker tripped (consecutive failures); use /compact manually" };
      }
      // 闸③ rapid-refill 防抖（[CC] compacted && turnCounter<3 && consecutiveRapidRefills>=3）：
      // 距上次压缩 <3 turn 且又达阈值 → 计一次 refill；累计 ≥3 次 → blocked（交还用户，不再自动压缩）
      if (state.previousCompactTurn !== null && turn - state.previousCompactTurn < RAPID_REFILL_TURN_WINDOW && used >= t.compactAt) {
        state.rapidRefillStreak++;
        if (state.rapidRefillStreak >= RAPID_REFILL_TRIP_COUNT) {
          return { level: usageLevel(used, t), shouldCompact: false, reason: "rapid-refill trip: context refilled within 3 turns after compaction (>=3 consecutive); handle manually" };
        }
      } else if (state.previousCompactTurn === null || turn - state.previousCompactTurn >= RAPID_REFILL_TURN_WINDOW) {
        state.rapidRefillStreak = 0; // 正常节奏（间隔 ≥3 turn）重置
      }
      // 闸④ 阈值判定（uCt 三级）
      const level = usageLevel(used, t);
      const shouldCompact = level === "compact" || level === "blocked";
      return { level, shouldCompact };
    },
    recordCompactSuccess(postCompactTokens: number, turn: number): void {
      // 重压缩链（DoD④）：willRetriggerNextTurn = postCompactTokens ≥ threshold（CTX-036）。
      // refill 计数=「紧凑连发的压缩」（本处）∪「evaluate 时距上次压缩 <3 turn 又满」（闸③）——
      // 两处合计 ≥3 → 闸③ blocked。
      state.compactCount++;
      state.postCompactTokens = postCompactTokens;
      const refilledFast = state.previousCompactTurn !== null && turn - state.previousCompactTurn < RAPID_REFILL_TURN_WINDOW;
      if (refilledFast) state.rapidRefillStreak++;
      else if (state.previousCompactTurn === null || turn - state.previousCompactTurn >= RAPID_REFILL_TURN_WINDOW) state.rapidRefillStreak = 0;
      state.previousCompactTurn = turn;
      state.consecutiveFailures = 0;
      state.tripped = false;
    },
    recordCompactFailure(_turn: number): void {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) state.tripped = true;
    },
    resetBreaker(): void {
      state.consecutiveFailures = 0;
      state.tripped = false;
      state.rapidRefillStreak = 0;
    },
  };
}

// —— env/settings 通道解析（WP-01 settings 来源接入；[自定] 键位映射，ADR-0030）——

export interface AutocompactChannelInput {
  env?: Record<string, string | undefined>;
  settings?: { autocompactEnabled?: boolean; autocompactWindow?: unknown; autocompactPct?: unknown };
  modelDefault?: number;
}

/** 汇总 env 逃逸舱与 settings 来源 → 协调器配置（未提供的字段取默认）。 */
export function resolveAutocompactConfig(input: AutocompactChannelInput): CompactionCoordinatorConfig {
  const env = input.env ?? {};
  const enabled = !(env[ENV_DISABLE] === "1" || env[ENV_DISABLE]?.toLowerCase() === "true") && (input.settings?.autocompactEnabled ?? true);
  const pctRaw = env[ENV_PCT_OVERRIDE] ?? input.settings?.autocompactPct;
  let pctOverride: number | undefined;
  if (pctRaw !== undefined) {
    const n = typeof pctRaw === "number" ? pctRaw : Number(pctRaw);
    if (Number.isFinite(n) && n > 0 && n <= 100) pctOverride = n; // 边界 0/100/>100/NaN：0/>100/NaN 无效，100 有效
  }
  const envWin = env[ENV_WINDOW];
  const manual = envWin !== undefined ? parseManualWindow(envWin) : parseManualWindow(input.settings?.autocompactWindow);
  const window = manual.value ?? input.modelDefault ?? UNKNOWN_MODEL_ASSUMED_WINDOW;
  return {
    enabled,
    ...(pctOverride !== undefined ? { pctOverride } : {}),
    window,
    blockingLimit: window, // M2 无独立 blockingLimit 来源——取窗口（blockingLimit=模型 FYn 的自研位留 M3+，登记偏差）
  };
}
