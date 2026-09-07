// Prompt 布局 M1 最小分区（v2.8 §7.1 CTX-100：M1 只做 identity + 工具说明 + 动态注入 + 消息历史）。
// 布局顺序（§7.1）：identity(system) → 工具 schema 紧随 system 注入（经请求 tools 字段，作为独立分段记账）
// → 动态上下文以 <system-reminder> isMeta user 消息前插 → 消息历史。
// cacheScope 映射 [自定，CTX-004 枚举内]：identity=org / tools=global / dynamic=dynamic / history=dynamic。
// 打点纪律（CTX-004）：显式 cache_control 仅当 capabilities.cache.explicitBreakpoints=true（Anthropic 语义，
// 由 @standardcode/providers 适配层执行）；OpenAI 兼容端点零打点——本模块只产出分段与 scope，不发协议字段。
// CTX-005：动态注入追加不改写（新数组前插，原消息对象原样保留）。

import type { LLMMessage, ModelCapabilities } from "@standardcode/providers";
import type { CacheScope, DynamicInjection, LayoutResult, MetaMessage, PromptSegment } from "./types.ts";

export interface BuildLayoutInput {
  identity: string;
  tools: Array<{ name: string; description: string }>;
  dynamic?: DynamicInjection[];
  history: LLMMessage[];
  capabilities: ModelCapabilities;
}

/** M1 四分段（惰性：compute 仅在 materialize 时调用）。 */
export function buildSegments(input: BuildLayoutInput): PromptSegment[] {
  return [
    {
      name: "identity",
      cacheScope: "org",
      compute: () => input.identity,
    },
    {
      name: "tools",
      cacheScope: "global",
      compute: () => input.tools.map((t) => `${t.name}: ${t.description}`).join("\n"),
    },
    {
      name: "dynamic",
      cacheScope: "dynamic",
      compute: () => (input.dynamic ?? []).map((d) => d.text).join("\n"),
    },
    {
      name: "history",
      cacheScope: "dynamic",
      compute: () => input.history,
    },
  ];
}

/** 物化：按序求值并组装 system + 前插动态注入后的消息（追加式，CTX-005）。 */
export function materializeLayout(segments: PromptSegment[], input: BuildLayoutInput): LayoutResult {
  let system = "";
  const result: LayoutResult = { system: "", messages: [], segments: [] };
  const evaluated: Array<{ name: string; cacheScope: CacheScope; value: string | LLMMessage[] }> = [];
  for (const seg of segments) {
    const value = seg.compute();
    evaluated.push({ name: seg.name, cacheScope: seg.cacheScope, value });
  }
  for (const e of evaluated) {
    result.segments.push({ name: e.name, cacheScope: e.cacheScope, size: typeof e.value === "string" ? e.value.length : e.value.length });
    if (e.name === "identity") system = e.value as string;
  }
  result.system = system;

  // 动态注入：<system-reminder> isMeta user 前插（新数组，不改写原消息——CTX-005）
  const injections: MetaMessage[] = (input.dynamic ?? []).map((d) => ({
    role: "user" as const,
    isMeta: true as const,
    content: [{ type: "text" as const, text: `<system-reminder>${d.text}</system-reminder>` }],
  }));
  result.messages = [...injections, ...input.history];
  return result;
}

export function isExplicitBreakpointCapable(caps: ModelCapabilities): boolean {
  return caps.cache.explicitBreakpoints;
}
