// WP-05（M2）：reactive 兜底 + /context 对账（v2.8 §7.2 CTX-037/CTX-038；§2 行 M2"/context 与真实 usage 对账"）。
// CTX-037 原文：reactive 兜底（prompt-too-long 触发，tokenGap 指标）；多级瀑布：tool result 清理 → context collapse → auto-compact。
// 锚点（A 级报告 §2.4 一手）：reactive=依赖 API prompt-too-long 错误再压（`hit prompt-too-long (gap=${tokenGap} → mode step)`），
//   tokenGap 指标+多级 step 升级；context collapse=压缩头空间被系统占用时不再倒计时。
// context collapse 无独立 [CC] 锚点细节 → §12.6 未覆盖级：设计裁决已补登 docs/adr/0036-context-collapse.md
//   （2026-09-09 V 退回 R2：原"mini-ADR 式注记"不满足先 ADR 后代码义务）。
// CTX-038：/context schema 对齐 `_670.js`；附录 A 网格要点：Autocompact buffer 33k 与 CTX-033 常量 13000+20000 互证；
//   分类占用 System prompt/System tools/Custom agents/Memory files/Skills/Messages/Free space（M2 无 agents/skills → 该两类=0 占位）。
// 对账：/context 输出与 usage meter 四列对账（复用 M1 WP-05 ADR-0027 口径：API usage 对账为准）。

import type { LLMMessage, TokenUsage as TU } from "@standardcode/providers";
import type { UsageTotals } from "../metering/usage-meter.ts";
import { AUTOCOMPACT_BUFFER, AUTOCOMPACT_WARN_MARGIN } from "./autocompact.ts";

// —— reactive（CTX-037）——

export type ReactiveStep = "tool-result-cleanup" | "context-collapse" | "auto-compact";

export interface ReactiveEvent {
  attempt: number;
  /** tokenGap = 触发时 used − 当前窗口（报告 `gap=${tokenGap}` 口径）。 */
  tokenGap: number;
  step: ReactiveStep;
}

export interface ReactiveState {
  attempts: ReactiveEvent[];
  /** 当前 step 升级水位（多级 step：每级前一步未解决才升级）。 */
  step: ReactiveStep;
}

/** 清理触发阈值与占位保留头长 [自定]（无 [CC] 锚点；ADR-0036 相邻机制节登记）。 */
export const CLEANUP_THRESHOLD_CHARS = 10_000;
export const CLEANUP_KEEP_CHARS = 200;

export interface ToolResultCleanupResult {
  messages: LLMMessage[];
  /** 被清理（替换为占位）的 tool_result 数。 */
  cleaned: number;
  /** 释放字符数（字符口径非 token 估算——V 观察 O3 勘误，原字段名 freedTokens 名实不符）。 */
  freedChars: number;
}

/**
 * 瀑布① tool result 清理：把最旧的 tool_result 大块（>threshold 字符）替换为截断占位（追加式纪律不破——
 * 历史不可改写 [B-14]，此处为压缩路径上的显式收缩操作，[自定] 与 CTX-005 关系登记于结果页）。
 */
export function cleanupToolResults(messages: LLMMessage[], thresholdChars = CLEANUP_THRESHOLD_CHARS, keepChars = CLEANUP_KEEP_CHARS): ToolResultCleanupResult {
  let cleaned = 0;
  let freed = 0;
  const out = messages.map((m) => {
    if (m.role !== "user") return m;
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type === "tool_result" && b.content.length > thresholdChars) {
        cleaned++;
        freed += b.content.length - keepChars;
        touched = true;
        return { ...b, content: `[tool_result truncated: original ${b.content.length} chars]${b.content.slice(0, keepChars)}` };
      }
      return b;
    });
    return touched ? { ...m, content } : m;
  });
  return { messages: out, cleaned, freedChars: freed };
}

/**
 * 瀑布② context collapse（§12.6 未覆盖级——设计裁决=ADR-0036）：丢弃"可再生物质"——
 * 当前实现仅 thinking 块（CTX-020①的压缩路径例外；登记 M5 复验一致性）；[REDACTED]/truncated
 * 占位内容为 ADR-0036 保留扩展位，当前未启用。
 * 与 CTX-020②不冲突：压缩请求继承 thinking 配置是请求构造层；此处是历史收缩层。
 */
export function contextCollapse(messages: LLMMessage[]): { messages: LLMMessage[]; dropped: number; freedChars: number } {
  let dropped = 0;
  let freed = 0;
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m;
    let touched = false;
    const content = m.content
      .map((b) => {
        if (b.type === "thinking") {
          dropped++;
          freed += b.thinking.length;
          touched = true;
          return null;
        }
        return b;
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
    return touched ? { ...m, content } : m;
  });
  return { messages: out, dropped, freedChars: freed };
}

export interface ReactiveDecision {
  /** 瀑布下一步。 */
  next: ReactiveStep;
  /** 无步可走（瀑布耗尽）→ 交还用户。 */
  exhausted: boolean;
}

/** 多级 step 升级：前一步未解决才升级（报告 `→ mode step` 口径）。 */
export function nextReactiveStep(current: ReactiveStep | null): ReactiveDecision {
  if (current === null) return { next: "tool-result-cleanup", exhausted: false };
  if (current === "tool-result-cleanup") return { next: "context-collapse", exhausted: false };
  if (current === "context-collapse") return { next: "auto-compact", exhausted: false };
  return { next: "auto-compact", exhausted: true };
}

// —— /context 对账（CTX-038）——

export interface ContextGridSection {
  name: string;
  tokens: number;
}

export interface ContextGrid {
  sections: ContextGridSection[];
  /** free space = 窗口 − 已知占用合计 − autocompact buffer（33k=13000+20000，附录 A 互证）。 */
  freeSpace: number;
  autocompactBuffer: number;
  window: number;
  /** 真实 usage（API 上报累计）——对账列。 */
  usage: TU | null;
}

export interface BuildContextGridInput {
  window: number;
  /** system prompt 字符数（layout identity+memory 段）。 */
  systemChars: number;
  /** 工具定义字符数。 */
  toolsChars: number;
  /** 记忆文件字符数（memory-loader sources 累计）。 */
  memoryChars: number;
  messages: LLMMessage[];
  /** 真实 usage（UsageMeter totals）。 */
  usage: UsageTotals | null;
  /** 字符→token 估算（缺省 /4，ADR-0027 标注误差）。 */
  estimate?: (chars: number) => number;
}

const estimateDefault = (chars: number) => Math.ceil(chars / 4);

/** /context 网格（CTX-038+附录 A 分类；M2 无 agents/skills → 占位 0）。 */
export function buildContextGrid(input: BuildContextGridInput): ContextGrid {
  const est = input.estimate ?? estimateDefault;
  const autocompactBuffer = AUTOCOMPACT_BUFFER + AUTOCOMPACT_WARN_MARGIN; // 33k（附录 A 互证）
  const sections: ContextGridSection[] = [
    { name: "System prompt", tokens: est(input.systemChars) },
    { name: "System tools", tokens: est(input.toolsChars) },
    { name: "Custom agents", tokens: 0 }, // M2 无（M3 起有值）
    { name: "Memory files", tokens: est(input.memoryChars) },
    { name: "Skills", tokens: 0 }, // M4
    { name: "Messages", tokens: input.messages.reduce((acc, m) => acc + est(JSON.stringify(m).length), 0) },
  ];
  const used = sections.reduce((acc, s) => acc + s.tokens, 0);
  return {
    sections,
    freeSpace: Math.max(0, input.window - used - autocompactBuffer),
    autocompactBuffer,
    window: input.window,
    usage: input.usage,
  };
}

/** /context 渲染（附录 A 网格形态 [自定]；四列 usage 对账行+误差标注尾行=ADR-0027 决策 3 MUST）。 */
export function renderContextGrid(g: ContextGrid): string {
  const lines: string[] = ["context:", ...g.sections.map((s) => `  ${s.name.padEnd(16)} ${String(s.tokens).padStart(8)}`)];
  lines.push(`  ${"Autocompact buffer".padEnd(16)} ${String(g.autocompactBuffer).padStart(8)}`);
  lines.push(`  ${"Free space".padEnd(16)} ${String(g.freeSpace).padStart(8)}`);
  if (g.usage) {
    const total = g.usage.inputTokens + g.usage.outputTokens + g.usage.cacheCreationTokens + g.usage.cacheReadTokens;
    lines.push(`  usage(api): in=${g.usage.inputTokens} out=${g.usage.outputTokens} cache_w=${g.usage.cacheCreationTokens} cache_r=${g.usage.cacheReadTokens} total=${total}`);
    // ADR-0027 决策 3：本地估算展示 MUST 携带误差标注（API usage 为权威）
    const rec = reconcileGrid(g);
    if (rec.errorRatio !== null) {
      const pct = Math.round(rec.errorRatio * 10000) / 100;
      lines.push(`  estimate vs api: ${rec.estimatedInput} vs ${rec.actualInput} (Δ ${pct}% — local estimate; API usage is authoritative, ADR-0027)`);
    }
  }
  return lines.join("\n");
}

/**
 * 对账断言（§2 行 M2）：网格 Messages+System 各段估算合计 vs 真实 usage.inputTokens——
 * ADR-0027 口径：API usage 为准，本地估算标注误差；误差率返回供 /context 尾行展示。
 */
export function reconcileGrid(g: ContextGrid): { estimatedInput: number; actualInput: number | null; errorRatio: number | null } {
  const estimatedInput = g.sections.reduce((acc, s) => acc + s.tokens, 0);
  if (!g.usage) return { estimatedInput, actualInput: null, errorRatio: null };
  const actualInput = g.usage.inputTokens;
  return { estimatedInput, actualInput, errorRatio: actualInput > 0 ? Math.abs(estimatedInput - actualInput) / actualInput : null };
}
