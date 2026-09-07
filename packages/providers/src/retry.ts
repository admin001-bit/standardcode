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

export async function withRetry<T>(
  op: () => Promise<T>,
  judge: (err: unknown) => RetryJudgement,
  policy: Partial<RetryPolicy> = {},
  hooks?: { sleep?: (ms: number) => Promise<void>; rng?: () => number },
): Promise<T> {
  const pol: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const sleep = hooks?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = hooks?.rng ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= pol.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const j = judge(err);
      if (!j.retryable || attempt === pol.maxAttempts) throw err;
      const delay = j.retryAfterMs ?? backoffDelay(pol, attempt, rng);
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable
}
