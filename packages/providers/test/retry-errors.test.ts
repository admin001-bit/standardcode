import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.ts";
import { OpenAIChatAdapter } from "../src/openai.ts";
import { ProviderError } from "../src/errors.ts";
import { backoffDelay, DEFAULT_RETRY_POLICY, withRetry } from "../src/retry.ts";
import { errorResponse, sseResponse } from "./helpers.ts";
import type { LLMEvent } from "../src/events.ts";
import type { LLMRequest } from "../src/types.ts";

const MODELS = {
  m: {
    contextWindow: 1000,
    maxOutputTokens: { default: 100, upper: 200 },
    thinking: "none" as const,
    input: ["text"] as Array<"text" | "image">,
  },
};
const REQ: LLMRequest = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
};

// 各协议一条最小完成流（收尾夹具）
const ANTHROPIC_FINISH = `event: message_start
data: {"type":"message_start","message":{"id":"m","model":"m","usage":{"input_tokens":1,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

`;
const OPENAI_FINISH = `data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`;

function flakyAdapter(
  responses: Array<Response | ProviderError>,
  anthropic: boolean,
  hooks?: { sleep?: (ms: number) => Promise<void>; rng?: () => number },
) {
  const queue = [...responses];
  const fetchImpl = async () => {
    const next = queue.shift();
    if (!next) throw new Error("no more queued responses");
    if (next instanceof ProviderError) throw next;
    return next;
  };
  const opts = { apiKey: "k", fetchImpl, maxRetryAttempts: 3, ...hooks };
  return anthropic ? new AnthropicAdapter(MODELS, opts) : new OpenAIChatAdapter(MODELS, opts);
}

async function collectStream(a: { stream(req: LLMRequest): AsyncIterable<LLMEvent> }): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of a.stream(REQ)) out.push(e);
  return out;
}

describe("HTTP 错误分类与重试", () => {
  it("429 → retryable，Retry-After 头被解析并优先于退避", async () => {
    const sleeps: number[] = [];
    const a = flakyAdapter([errorResponse(429, "rate limited", { "retry-after": "2" }), sseResponse(ANTHROPIC_FINISH)], true, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const events = await collectStream(a);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed", raw: "end_turn" });
    expect(sleeps).toEqual([2000]);
  });

  it("529/500 可重试后成功；401 auth 不可重试直接抛", async () => {
    const a529 = flakyAdapter([errorResponse(529, "overloaded"), sseResponse(ANTHROPIC_FINISH)], true, { sleep: async () => {} });
    expect((await collectStream(a529)).at(-1)?.type).toBe("finish");
    const a500 = flakyAdapter([errorResponse(500, "boom"), sseResponse(OPENAI_FINISH)], false, { sleep: async () => {} });
    expect((await collectStream(a500)).at(-1)?.type).toBe("finish");
    const a401 = flakyAdapter([errorResponse(401, "bad key")], true, { sleep: async () => {} });
    await expect(collectStream(a401)).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("重试预算耗尽（maxAttempts=3）后抛最后一错", async () => {
    const a = flakyAdapter(
      [errorResponse(429, "r1"), errorResponse(429, "r2"), errorResponse(429, "r3"), errorResponse(429, "r4")],
      true,
      { sleep: async () => {} },
    );
    await expect(collectStream(a)).rejects.toMatchObject({ status: 429 });
  });

  it("400 非上下文错误 → invalid_request 不可重试", async () => {
    const a = flakyAdapter([errorResponse(400, "bad param")], true, { sleep: async () => {} });
    await expect(collectStream(a)).rejects.toMatchObject({ kind: "invalid_request", retryable: false });
  });

  it("400 prompt too long → context_length（恢复链②识别）", async () => {
    const a = flakyAdapter([errorResponse(400, "your prompt is too long: 999999 tokens > 200000")], true);
    await expect(collectStream(a)).rejects.toMatchObject({ kind: "context_length" });
  });
});

describe("退避曲线（kimi retry.ts:16-25 锚点参数）", () => {
  it("默认策略=10 次/0.5s 基/32s 上限/×2/25% jitter", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxAttempts: 10, baseDelayMs: 500, maxDelayMs: 32000, factor: 2, jitterFactor: 0.25 });
  });
  it("指数爬升封顶 32s，rng=0 无 jitter、rng=1 时 +25%", () => {
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 1, () => 0)).toBe(500);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 2, () => 0)).toBe(1000);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 3, () => 0)).toBe(2000);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 7, () => 0)).toBe(32000);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 1, () => 1)).toBe(625);
  });
  it("withRetry：按 judge 重试直到成功", async () => {
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error("transient");
        return "ok";
      },
      () => ({ retryable: true, retryAfterMs: 0 }),
      { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, baseDelayMs: 1 },
      { sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(n).toBe(3);
  });
});
