// F8（2026-09-28 真机实测）修复回归：重试通知（UI 可见化）＋可中断退避。
// 背景：默认 10 次指数退避（0.5s→32s，最长约 2 分钟）原为全静默；实测 Ctrl+C 亦无效（F7），用户无路可走。
import { describe, expect, it } from "vitest";
import { withRetry, type RetryNotice } from "../src/retry.ts";
import { ProviderError } from "../src/errors.ts";

const retryableJudge = () => ({ retryable: true, retryAfterMs: null as number | null });

describe("withRetry 通知与中断（F8 修复）", () => {
  it("每次重试前发出 onRetry（次数/上限/延迟/原因），退避曲线进通知", async () => {
    const notices: RetryNotice[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderError("http", "boom");
        return "ok";
      },
      retryableJudge,
      { maxAttempts: 5, baseDelayMs: 100, factor: 2, jitterFactor: 0 },
      { onRetry: (n) => notices.push(n), sleep: async (ms) => { sleeps.push(ms); }, rng: () => 0 },
    );
    expect(out).toBe("ok");
    expect(notices.map((n) => n.attempt)).toEqual([1, 2]);
    expect(notices[0]).toMatchObject({ maxAttempts: 5, delayMs: 100, reason: "boom" });
    expect(notices[1].delayMs).toBe(200);
    expect(sleeps).toEqual([100, 200]);
  });

  it("signal 已中止：不再发起后续尝试（原样抛最后一次错误）", async () => {
    const ac = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          ac.abort(); // 首试内中断（模拟 Ctrl+C 落在请求期）
          throw new ProviderError("http", "boom");
        },
        retryableJudge,
        { maxAttempts: 10, baseDelayMs: 60_000, factor: 2, jitterFactor: 0 },
        { signal: ac.signal, rng: () => 0 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("退避窗口内中断：等待被立即唤醒（不等满 60s），且不再尝试", async () => {
    const ac = new AbortController();
    let calls = 0;
    const t0 = Date.now();
    const timer = setTimeout(() => ac.abort(), 50); // 请求已失败、正在退避时中断
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("http", "boom");
        },
        retryableJudge,
        { maxAttempts: 10, baseDelayMs: 60_000, factor: 2, jitterFactor: 0 },
        { signal: ac.signal, rng: () => 0 },
      ),
    ).rejects.toThrow("boom");
    clearTimeout(timer);
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("无 signal/无 onRetry：旧形行为不变（注入 sleep 仍被调用）", async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new ProviderError("http", "boom");
        return 7;
      },
      retryableJudge,
      { maxAttempts: 3, baseDelayMs: 5, factor: 2, jitterFactor: 0 },
      { sleep: async (ms) => { slept.push(ms); }, rng: () => 0 },
    );
    expect(out).toBe(7);
    expect(slept).toEqual([5]);
  });
});
