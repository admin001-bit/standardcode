// Prompt Layout 类型（v2.8 §5.3(2)、§7.1）。
// §5.3(2)：{name, compute, cacheScope, cacheBreak?} 惰性分段列表。
// cacheScope 枚举（CTX-004）：null / org / global / dynamic。

import type { LLMMessage } from "@standardcode/providers";

export type CacheScope = "null" | "org" | "global" | "dynamic";

export interface PromptSegment {
  name: string;
  /** 惰性求值：仅在被物化（materialize）时调用；segments() 本身不触发。 */
  compute: () => string | LLMMessage[];
  cacheScope: CacheScope;
}

/** isMeta 标记（[CC] 同构）：非用户撰写、由系统动态前插的消息——编码时仅作内部记账，不上 API。 */
export interface MetaMessage extends LLMMessage {
  isMeta?: true;
}

export interface DynamicInjection {
  /** 注入内容（将包进 <system-reminder> 标签）。 */
  text: string;
}

export interface LayoutResult {
  /** M1：system 为单串（identity 段）；分段化随 Golden/计量里程碑演进。 */
  system: string;
  /** 动态注入以 <system-reminder> isMeta user 消息前插（追加式，不改写原消息，CTX-005）。 */
  messages: Array<LLMMessage | MetaMessage>;
  /** 分区清单（供计量/Golden 对账）。 */
  segments: Array<{ name: string; cacheScope: CacheScope; size: number }>;
}
