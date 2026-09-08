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
