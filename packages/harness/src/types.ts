// L1 会话编排类型（v2.8 §5.2 harness 行、§5.4 请求生命周期）。
import type { ChildProcess } from "node:child_process";
import type { ContentBlock, LLMMessage, LLMRequest, ProviderAdapter, ProviderFinishReason, TokenUsage, ToolDef } from "@standardcode/providers";

export interface ToolContext {
  /** 用户中断信号：工具 MUST 观察此信号并及时退出（§8.4 中断不变量）。 */
  signal: AbortSignal;
  /** 工具若派生子进程，注册到此处——中断时由 harness 负责进程树终止。 */
  registerProcess(child: ChildProcess): void;
}

export interface Tool extends ToolDef {
  execute(input: unknown, ctx: ToolContext): Promise<string>;
  /** 并发安全：true 时与其他工具并行执行（[CC] isConcurrencySafe 同构）；缺省 false 串行。 */
  isConcurrencySafe?: boolean;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
}

export function createRegistry(tools: Tool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.name, t]));
}

/** 权限接口点（WP-08 落实体）。三值：allow 执行、deny 拒绝、ask=需确认（M1 无确认 UI→fail-closed 拒绝，B-13/SEC-020）。 */
export interface PermissionGate {
  check(toolName: string, input: unknown): Promise<"allow" | "deny" | "ask">;
}

export interface TurnState {
  messages: LLMMessage[];
  toolRounds: number;
  continuations: number;
  malformedRounds: number;
  usage: TokenUsage | null;
}

export type DoneReason =
  | "end"
  | "max_turns"
  | "interrupted"
  | "context_exhausted"
  | "truncated_gave_up"
  | "malformed_fail_closed"
  | "filtered"
  | "error";

/** WP-05（CTX-037）reactive 瀑布步名。口径唯一权威=packages/context reactive.ts ReactiveStep（同名字面，结构等价，无依赖引入）。 */
export type ReactiveStepName = "tool-result-cleanup" | "context-collapse" | "auto-compact";

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  /** WP-06（CTX-020 工程不变量①）：thinking 块收束（signature 原样回传；harness 已将其入历史）。 */
  | { type: "thinking_end"; thinking: string; thinkingSignature?: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: ProviderFinishReason; raw: string | null }
  | { type: "recovery"; chain: "max_tokens_continue" | "stream_resume" | "malformed_retry"; round: number }
  | { type: "interrupted"; phase: "stream" | "tool" }
  | { type: "context_exhausted" }
  /** WP-03（CTX-101 交接）：压缩协调器放行且执行体成功（摘要替换历史）。 */
  | { type: "compact_decided"; level: string; postCompactTokens: number }
  /** WP-05（CTX-037）：reactive 瀑布步升级（tokenGap=used−window，报告 `gap=${tokenGap}` 口径）。 */
  | { type: "reactive_step"; attempt: number; tokenGap: number; step: ReactiveStepName }
  | { type: "done"; reason: DoneReason };

export interface LoopOptions {
  provider: ProviderAdapter;
  model: string;
  system?: string;
  /** WP-06（CTX-020）：扩展思维请求配置；缺省不发。 */
  thinking?: { type: "adaptive" } | { type: "budget"; budgetTokens: number };
  messages: LLMMessage[];
  tools?: Tool[];
  /** 权限闸（WP-08）；缺省全放行。 */
  permission?: PermissionGate;
  /** guard-path 护栏（WP-09，platform 实现）：stop 硬停/confirm 强制确认（S-9 Auto 不豁免）。 */
  guard?: { check(toolName: string, input: unknown): { action: "stop" | "confirm" | "pass"; rule?: string; detail?: string } };
  /** file-history 快照钩子（WP-09，EXE-040）：每次工具写盘前触发。 */
  fileHistory?: { beforeTool(toolName: string, input: unknown): Promise<void> };
  /**
   * WP-03（CTX-101 交接）：恢复链②context_length 路由改接压缩协调器（阈值+四道闸，packages/context）。
   * evaluate=门判定（compact/blocked）；perform=压缩执行体（9 段摘要，WP-04 交付；未提供时直接
   * 维持 context_exhausted，不发 compact_decided——【勘误 2026-09-08】原注释"暴露事件后维持"失实）。
   */
  autocompact?: {
    evaluate(usedTokens: number, turn: number): { shouldCompact: boolean; level: string; reason?: string };
    /** WP-04：压缩执行体（9 段摘要）；返回新历史（缺省=清空，WP-04 前占位）。 */
    perform?(turn: number): Promise<{ ok: boolean; postCompactTokens: number; messages?: LLMMessage[] }>;
  };
  /**
   * WP-05（CTX-037）：reactive 兜底瀑布（prompt-too-long 触发；A 级报告 §2.4 锚点）。提供时先于
   * autocompact 路由执行：decide=步升级状态机（前一步未解决才升级，packages/context nextReactiveStep 同构）；
   * apply=步动作（返回收缩后的新历史；null=该步无事可做，视作未解决继续升级）。auto-compact 级
   * apply 必须返回 null（exhausted）——落下方既有 autocompact 路由，不在此处二次压缩。
   */
  reactive?: {
    /** 模型上下文窗口（tokenGap=used−window；无 usage 快照时 used 取 0，gap 为负=无计量哨兵）。 */
    modelWindow: number;
    decide(current: ReactiveStepName | null): { next: ReactiveStepName; exhausted: boolean };
    apply(step: ReactiveStepName, messages: LLMMessage[]): LLMMessage[] | null;
  };
  /** 恢复链⑧：单 turn 内工具轮数上限（默认 25，[自定]）。 */
  maxToolRounds?: number;
  /** 恢复链③/④：续写预算（默认 3，§5.4 ③限 3 次）。 */
  maxContinuations?: number;
  /** 恢复链⑤：畸形工具调用重试预算（默认 3）。 */
  maxMalformedRounds?: number;
  /** 协议不变量断言（§12.2），默认开。 */
  assertInvariants?: boolean;
  /** 观测点：done/return 时回填最终 turn 状态（测试与上层核验用，如中断后无悬空 tool_use）。 */
  stateRef?: { current?: TurnState };
  signal?: AbortSignal;
}

export type { ContentBlock, LLMMessage, LLMRequest, ProviderAdapter, TokenUsage };
