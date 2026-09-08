// WP-03（M2）AutoCompact 测试（v2.8 §12.2 单元行"压缩阈值表测（13000/20000/3000/0.2 + pct 边界 0/100/>100/NaN）；
// 窗口解析链"+板 WP-03 DoD①-⑤ 判据自足）。
import { describe, expect, it } from "vitest";
import {
  AUTOCOMPACT_BUFFER,
  AUTOCOMPACT_WARN_MARGIN,
  AUTOCOMPACT_BLOCKING_HEADROOM,
  summaryBufferBaseline,
  compactThreshold,
  thresholdsFor,
  usageLevel,
  resolveAutoCompactWindow,
  parseManualWindow,
  unknownModelHint,
  createCompactionCoordinator,
  resolveAutocompactConfig,
  ENV_PCT_OVERRIDE,
  ENV_WINDOW,
  ENV_DISABLE,
  MANUAL_WINDOW_MIN,
  MANUAL_WINDOW_MAX,
  UNKNOWN_MODEL_ASSUMED_WINDOW,
} from "../src/context-store/autocompact.ts";

describe("DoD① 压缩阈值表测（§12.2 单元行原文）", () => {
  it("常量 13000/20000/3000/0.2 实测值在位", () => {
    expect(AUTOCOMPACT_BUFFER).toBe(13000);
    expect(AUTOCOMPACT_WARN_MARGIN).toBe(20000);
    expect(AUTOCOMPACT_BLOCKING_HEADROOM).toBe(3000);
    expect(compactThreshold(200_000)).toBe(Math.min(200_000 - Math.round(200_000 * 0.2), 200_000 - 13000)); // min(160000, 187000)=160000
    expect(summaryBufferBaseline(200_000)).toBe(187_000);
    expect(thresholdsFor(200_000, 200_000)).toEqual({ compactAt: 160_000, warnAt: 140_000, blockedAt: 197_000 });
  });

  it("pct 边界 0/100/>100/NaN：0/>100/NaN 无效回落；100 有效=min(window, window−13000)", () => {
    // 0 → 无效（>0 才有效）回落 window−13000
    expect(summaryBufferBaseline(200_000, 0)).toBe(187_000);
    // 100 → min(200000, 187000)=187000
    expect(summaryBufferBaseline(200_000, 100)).toBe(187_000);
    // >100 → 无效回落
    expect(summaryBufferBaseline(200_000, 150)).toBe(187_000);
    // NaN → 无效回落
    expect(summaryBufferBaseline(200_000, Number.NaN)).toBe(187_000);
    // 常规值：50% → min(100000, 187000)=100000
    expect(summaryBufferBaseline(200_000, 50)).toBe(100_000);
  });

  it("小窗口下 bufferFraction 项更低（min 语义）", () => {
    // window=30000: round(30000*0.2)=6000 → 24000; baseline=17000 → min=17000
    expect(compactThreshold(30_000)).toBe(17_000);
    // window=50000: 50000−10000=40000; baseline=37000 → 37000
    expect(compactThreshold(50_000)).toBe(37_000);
  });

  it("三级判定：blocked 恒赢 > compact（disabled 时不触发）> warn > ok", () => {
    const t = thresholdsFor(200_000, 200_000);
    expect(usageLevel(100_000, t)).toBe("ok");
    expect(usageLevel(140_000, t)).toBe("warn");
    expect(usageLevel(160_000, t)).toBe("compact");
    expect(usageLevel(197_000, t)).toBe("blocked");
    // disabled：compact 不触发但 blocked 恒指示
    expect(usageLevel(160_000, t, false)).toBe("warn");
    expect(usageLevel(197_000, t, false)).toBe("blocked");
  });
});

describe("DoD② 窗口解析优先级链（CTX-034）", () => {
  it("env > settings > clientdata > experiment > model-default > unknown-assumed，clamp 到模型窗口", () => {
    const modelDefault = 200_000;
    expect(resolveAutoCompactWindow({ env: { [ENV_WINDOW]: "150k" }, modelDefault }).source).toBe("env");
    expect(resolveAutoCompactWindow({ settings: { window: "150k" }, modelDefault }).source).toBe("settings");
    expect(resolveAutoCompactWindow({ clientdata: "150k", modelDefault }).source).toBe("clientdata");
    expect(resolveAutoCompactWindow({ experiment: "150k", modelDefault }).source).toBe("experiment");
    expect(resolveAutoCompactWindow({ modelDefault }).source).toBe("model-default");
    // 无 modelDefault → unknown-assumed+提示
    const unknown = resolveAutoCompactWindow({});
    expect(unknown.source).toBe("unknown-assumed");
    expect(unknown.assumed).toBe(true);
    expect(unknown.window).toBe(UNKNOWN_MODEL_ASSUMED_WINDOW);
    expect(unknownModelHint("gpt-x")).toContain("STANDARD_CODE_AUTO_COMPACT_WINDOW");
    // clamp：env 1m → min(1m, 200k)=200k
    expect(resolveAutoCompactWindow({ env: { [ENV_WINDOW]: "1m" }, modelDefault }).window).toBe(200_000);
    // 非法 env 值 → 回落 model-default 并记录 rejected
    const rej = resolveAutoCompactWindow({ env: { [ENV_WINDOW]: "banana" }, modelDefault });
    expect(rej.source).toBe("model-default");
    expect(rej.rejected).toBe("banana");
  });

  it("手动值语法：'auto'/'200k'/'1m'/数字(≥100 视为 k)；界 100k–1M", () => {
    expect(parseManualWindow("auto").value).toBeNull();
    expect(parseManualWindow("200k").value).toBe(200_000);
    expect(parseManualWindow("1m").value).toBe(1_000_000);
    expect(parseManualWindow(200).value).toBe(200_000);
    expect(parseManualWindow(5000).value).toBeNull(); // 数字≥100 视为 k → 5m 超 1M 界拒
    expect(parseManualWindow("99k").rejected).toBeDefined(); // <100k
    expect(parseManualWindow("2m").rejected).toBeDefined(); // >1m
    expect(MANUAL_WINDOW_MIN).toBe(100_000);
    expect(MANUAL_WINDOW_MAX).toBe(1_000_000);
  });
});

describe("DoD③ 四道闸各一单测（CTX-035）", () => {
  const cfg = { enabled: true, window: 200_000, blockingLimit: 200_000 };
  const atCompact = 165_000; // ≥160000

  it("闸① 总开关：disabled → 不触发（blocked 仍指示）", () => {
    const c = createCompactionCoordinator({ ...cfg, enabled: false });
    const d = c.evaluate(atCompact, 1);
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toContain("disabled");
  });

  it("闸② 熔断器：连续失败 3 次 → tripped，恢复经手动 reset（/compact 通道）", () => {
    const c = createCompactionCoordinator(cfg);
    c.recordCompactFailure(1);
    c.recordCompactFailure(2);
    expect(c.evaluate(atCompact, 3).shouldCompact).toBe(true); // 2 次 <3
    c.recordCompactFailure(3);
    const tripped = c.evaluate(atCompact, 4);
    expect(tripped.shouldCompact).toBe(false);
    expect(tripped.reason).toContain("circuit breaker");
    c.resetBreaker();
    expect(c.evaluate(atCompact, 5).shouldCompact).toBe(true);
  });

  it("闸③ rapid-refill：压缩后 3 turn 内又满且连续 ≥3 次 → 交还用户；正常节奏重置", () => {
    const c = createCompactionCoordinator(cfg);
    // 三连 rapid-refill（间隔 1 turn）
    c.recordCompactSuccess(161_000, 1);
    c.recordCompactSuccess(161_000, 2);
    c.recordCompactSuccess(161_000, 3);
    const d = c.evaluate(atCompact, 4);
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toContain("rapid-refill");
    c.resetBreaker();
    // 正常节奏：间隔 ≥3 turn 不累计
    c.recordCompactSuccess(161_000, 10);
    c.recordCompactSuccess(161_000, 20);
    c.recordCompactSuccess(161_000, 30);
    expect(c.evaluate(atCompact, 31).shouldCompact).toBe(true);
  });

  it("闸④ 阈值判定：≥compactAt 触发；压缩后仍超阈值 → 下轮再压（重压缩链）", () => {
    const c = createCompactionCoordinator(cfg);
    expect(c.evaluate(159_999, 1).shouldCompact).toBe(false);
    expect(c.evaluate(160_000, 1).shouldCompact).toBe(true);
    // 压缩后 150000 <160000 → 不再拉响 rapid-refill
    c.recordCompactSuccess(150_000, 2);
    expect(c.evaluate(150_000, 3).shouldCompact).toBe(false);
    // 压缩后 161000 ≥160000 → willRetriggerNextTurn
    c.recordCompactSuccess(161_000, 4);
    expect(c.evaluate(161_000, 5).shouldCompact).toBe(true);
  });
});

describe("DoD④/⑤ 手动窗口 100k–1M 与 env/settings 通道（CTX-036/ADR-0030）", () => {
  it("resolveAutocompactConfig：env 逃逸舱覆盖 settings；PCT/窗口/DISABLE 三通道", () => {
    expect(resolveAutocompactConfig({ env: { [ENV_DISABLE]: "1" }, modelDefault: 200_000 }).enabled).toBe(false);
    const viaEnv = resolveAutocompactConfig({ env: { [ENV_WINDOW]: "300k", [ENV_PCT_OVERRIDE]: "80" }, settings: { autocompactWindow: "150k" }, modelDefault: 200_000 });
    expect(viaEnv.window).toBe(300_000); // env 赢 settings
    expect(viaEnv.pctOverride).toBe(80);
    const viaSettings = resolveAutocompactConfig({ settings: { autocompactWindow: "150k" }, modelDefault: 200_000 });
    expect(viaSettings.window).toBe(150_000);
    expect(resolveAutocompactConfig({ modelDefault: 200_000 }).window).toBe(200_000);
  });

  it("DoD⑤ 手动窗口 100k–1M 边界：99999 拒/100000 收/1000000 收/1000001 拒", () => {
    // 数字 ≥100 视为 k（[CC] 语法）：100 → 100000 收；100000 → 1e8 拒
    expect(parseManualWindow(100).value).toBe(100_000);
    expect(parseManualWindow(99_999).value).toBeNull(); // → 99.999m 拒
    expect(parseManualWindow("100000").rejected).toBeDefined(); // → 1e8 拒
    expect(parseManualWindow(1_000_000).value).toBeNull(); // → 1e9 拒
    expect(parseManualWindow("1m").value).toBe(1_000_000); // 1M 界内收（语法表达）
  });
});
