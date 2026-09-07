// 计量：token usage 四列累计（v2.8 §7.2 CTX-102[自定]、§13 行 1 处置）。
// 语义（ADR-0027）：单条 usage 事件 = 该轮的快照（最后一条为准，Anthropic message_start/message_delta
// 的合并式上报与 OpenAI 的末条全量同构）；跨轮累计由本模块 observe() 完成（单调递增）。
// M1 打印原始 usage；/usage 命令与价格表收口在 M3（CTX-102）。

import type { TokenUsage } from "@standardcode/providers";

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

export type UsageTotals = TokenUsage;

export class UsageMeter {
  private totals: TokenUsage = { ...ZERO };
  private turnCount = 0;

  /** 记入一轮的 usage 快照；返回累计后的四列。 */
  observe(turnSnapshot: TokenUsage): UsageTotals {
    this.totals = {
      inputTokens: this.totals.inputTokens + (turnSnapshot.inputTokens ?? 0),
      outputTokens: this.totals.outputTokens + (turnSnapshot.outputTokens ?? 0),
      cacheCreationTokens: this.totals.cacheCreationTokens + (turnSnapshot.cacheCreationTokens ?? 0),
      cacheReadTokens: this.totals.cacheReadTokens + (turnSnapshot.cacheReadTokens ?? 0),
    };
    this.turnCount++;
    return { ...this.totals };
  }

  snapshot(): UsageTotals {
    return { ...this.totals };
  }

  get turns(): number {
    return this.turnCount;
  }
}

/** M1 原始 usage 打印（CTX-102：M1 打印原始 usage；M3 /usage 与价格表收口）。 */
export function formatRawUsage(turn: TokenUsage, sessionTotals?: UsageTotals): string {
  const t = `usage: input=${turn.inputTokens ?? 0} output=${turn.outputTokens ?? 0} cache_creation=${turn.cacheCreationTokens ?? 0} cache_read=${turn.cacheReadTokens ?? 0}`;
  if (!sessionTotals) return t;
  return `${t} | session: input=${sessionTotals.inputTokens} output=${sessionTotals.outputTokens} cache_creation=${sessionTotals.cacheCreationTokens} cache_read=${sessionTotals.cacheReadTokens}`;
}

export interface ReconcileResult {
  deltaTokens: number;
  /** 误差百分比（相对 API usage），actual 为 0 时 null。 */
  deltaPct: number | null;
  note: string;
}

/** 本地估算与 API usage 对账（§13 行 1 处置：API usage 对账为准、本地估算标注误差——ADR-0027）。 */
export function reconcileEstimate(estimated: number, actualApiUsage: number): ReconcileResult {
  const deltaTokens = estimated - actualApiUsage;
  const deltaPct = actualApiUsage > 0 ? Math.round((deltaTokens / actualApiUsage) * 10000) / 100 : null;
  return {
    deltaTokens,
    deltaPct,
    note: "local estimate; API usage is authoritative (ADR-0027, v2.8 §13 row-1)",
  };
}
