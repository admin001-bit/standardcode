// L5 Provider Adapter 统一类型（v2.8 §5.3(1)）。
// 请求 IR 取 Anthropic 形状（表达最全），OpenAI 侧在适配器内转换；
// 协议分支只允许存在于本包内（DP-1 / ARCH-007）。

import type { LLMEvent } from "./events.ts";

export type ModelId = string;

// §5.3(1) ModelCapabilities 原文同构
export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: { default: number; upper: number };
  thinking: "none" | "adaptive" | "budget";
  input: Array<"text" | "image" | "video" | "audio">;
  streaming: boolean;
  toolCalling: boolean;
  cache: { ttlLevels: Array<"5m" | "1h">; explicitBreakpoints: boolean };
}

export interface ProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** 注入 fetch/sleep/rng 供测试；生产缺省用全局实现。 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  /** 含首试的最大尝试次数（§5.3(1)：kimi 默认 10，loop/retry.ts:16 锚点）。 */
  maxRetryAttempts?: number;
}

export type ToolInputSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "thinking"; thinking: string; signature?: string };

export interface LLMMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface LLMRequest {
  model: string;
  /** M1 为单段 system 字符串；分区化（cacheScope 分段）在 prompt-layout（WP-04）。 */
  system?: string;
  messages: LLMMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

// §5.3(1) ProviderAdapter 接口三方法
export interface ProviderAdapter {
  capabilities(model: ModelId): ModelCapabilities;
  stream(req: LLMRequest): AsyncIterable<LLMEvent>;
  countTokens(req: LLMRequest): Promise<number>;
}
