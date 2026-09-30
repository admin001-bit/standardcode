// 重试与回退（v2.8 §5.3(1)：指数退避 + jitter + Retry-After）。
// 参数同构 kimi agent-core loop/retry.ts:16-25 锚点：默认 10 次、0.5s→32s（×2）、25% jitter。
// M1 仅重试单通道（无多 Provider 回退路由，卡边界）；Retry-After 显式给出时优先于退避曲线。

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  factor: 2,
  jitterFactor: 0.25,
};

export interface RetryJudgement {
  retryable: boolean;
  retryAfterMs: number | null;
}

/** 第 attempt 次尝试失败后的等待时长（attempt 从 1 计）。 */
export function backoffDelay(policy: RetryPolicy, attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(policy.baseDelayMs * policy.factor ** (attempt - 1), policy.maxDelayMs);
  const jitter = exp * policy.jitterFactor * rng();
  return Math.min(exp + jitter, policy.maxDelayMs * (1 + policy.jitterFactor));
}

/** F8（2026-09-28 真机实测）：重试通知注入面——重试期间 UI 可见（原实现全静默：默认 10 次/0.5s→32s 退避，
 * 实测最长约 2 分钟零反馈且 Ctrl+C 无效，用户无路可走）。 */
export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export async function withRetry<T>(
  op: () => Promise<T>,
  judge: (err: unknown) => RetryJudgement,
  policy: Partial<RetryPolicy> = {},
  hooks?: { sleep?: (ms: number) => Promise<void>; rng?: () => number; onRetry?: (notice: RetryNotice) => void; signal?: AbortSignal },
): Promise<T> {
  const pol: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const sleep = hooks?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = hooks?.rng ?? Math.random;
  const signal = hooks?.signal;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= pol.maxAttempts; attempt++) {
    // 中断硬化（随批4 深挖）：已 abort 的 signal 不再发起任何尝试（含首个）——避免被中断的 turn 内后续调用
    // 带已 abort 的 signal 进入重试循环（语义兜底；非缺陷修复，见 classifyNetworkError 头注）。
    if (signal?.aborted) throw lastErr ?? new Error("request aborted (interrupted)");
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const j = judge(err);
      if (!j.retryable || attempt === pol.maxAttempts) throw err;
      const delay = j.retryAfterMs ?? backoffDelay(pol, attempt, rng);
      hooks?.onRetry?.({ attempt, maxAttempts: pol.maxAttempts, delayMs: Math.round(delay), reason: err instanceof Error ? err.message : String(err) });
      // F8b：中断（Ctrl+C → activeAbort.abort()）在退避窗口内立即生效——等待可被打断，醒来后不再发起下一次尝试。
      await sleepAbortable(delay, signal, sleep);
      if (signal?.aborted) throw err;
    }
  }
  throw lastErr; // unreachable
}

/** F8b：可中断退避（signal 在场时以计时器实现；abort 立即唤醒，调用方凭 signal.aborted 决定是否续跑）。
 *  S4-7（全仓审查 2026-10-01）：两路收束均成对摘监听——原正常到点只 resolve 不摘（{once} 只在 abort
 *  触发时自回收），429 风暴下同一 signal 监听器堆积至 MaxListenersExceededWarning（mcp/client 同款成对形）。 */
function sleepAbortable(ms: number, signal: AbortSignal | undefined, customSleep: (ms: number) => Promise<void>): Promise<void> {
  if (!signal) return customSleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
