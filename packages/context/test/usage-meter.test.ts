// WP-05 测试：四列累计单调/快照语义/原始打印/对账标注。
import { describe, expect, it } from "vitest";
import { formatRawUsage, reconcileEstimate, UsageMeter } from "../src/metering/usage-meter.ts";

describe("UsageMeter（CTX-102 四列）", () => {
  it("observe 跨轮累计单调递增", () => {
    const m = new UsageMeter();
    const t1 = m.observe({ inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 30 });
    const t2 = m.observe({ inputTokens: 80, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 60 });
    expect(t1).toEqual({ inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 30 });
    expect(t2).toEqual({ inputTokens: 180, outputTokens: 70, cacheCreationTokens: 5, cacheReadTokens: 90 });
    expect(m.turns).toBe(2);
    expect(m.snapshot()).toEqual(t2);
  });

  it("快照语义：同一轮内同值重复 observe 不适用于单轮（轮=一次 observe，ADR-0027 决策 2）", () => {
    // 单轮内 Anthropic message_start + message_delta 两次上报由主循环合并为"最后一条"后再 observe——
    // 主循环 WP-02 事件流转发的是合并快照；此处验证 meter 对"整轮快照"恰好加一次。
    const m = new UsageMeter();
    m.observe({ inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 });
    const s = m.snapshot();
    expect(s).toEqual({ inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 });
  });

  it("零值/缺列健壮", () => {
    const m = new UsageMeter();
    const t = m.observe({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(t).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });
});

describe("formatRawUsage（CTX-102 M1 打印原始 usage）", () => {
  it("单轮形态", () => {
    expect(formatRawUsage({ inputTokens: 10, outputTokens: 2, cacheCreationTokens: 1, cacheReadTokens: 3 })).toBe(
      "usage: input=10 output=2 cache_creation=1 cache_read=3",
    );
  });
  it("带会话累计形态", () => {
    const s = formatRawUsage(
      { inputTokens: 10, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );
    expect(s).toContain("| session: input=100");
  });
});

describe("reconcileEstimate（§13 行 1：API usage 对账为准、本地估算标注误差）", () => {
  it("误差以百分比标注且 note 固定指向 ADR-0027", () => {
    const r = reconcileEstimate(1100, 1000);
    expect(r.deltaTokens).toBe(100);
    expect(r.deltaPct).toBe(10);
    expect(r.note).toContain("API usage is authoritative");
  });
  it("actual=0 时百分比 null（不除零）", () => {
    expect(reconcileEstimate(50, 0).deltaPct).toBeNull();
  });
  it("负误差（低估）同样标注", () => {
    expect(reconcileEstimate(900, 1000).deltaPct).toBe(-10);
  });
});
