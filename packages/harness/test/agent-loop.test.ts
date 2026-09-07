// WP-02 测试：主循环/状态对象/协议不变量/工具回路/恢复链 ③⑤⑧⑨/中断。
// L5 以内存桩流供给（形状与 @standardcode/providers 的 LLMEvent 一致）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { assertProtocolInvariants, HarnessInvariantError } from "../src/invariant.ts";
import { runTools, validateToolInput } from "../src/tools.ts";
import type { AgentEvent, DoneReason, Tool } from "../src/types.ts";
import { runAgentLoop } from "../src/agent-loop.ts";

// ---- 桩 ----

function queueProvider(pages: LLMEvent[][], capture?: { reqs: LLMRequest[] }): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(req: LLMRequest) {
      capture?.reqs.push(req);
      const page = pages[Math.min(i++, pages.length - 1)];
      for (const ev of page) yield ev;
    },
  };
}

const STOP: LLMEvent[] = [{ type: "finish", reason: "completed", raw: "end_turn" }];

function baseMessages() {
  return [{ role: "user" as const, content: [{ type: "text" as const, text: "q" }] }];
}
const sr1: { current?: import("../src/types.ts").TurnState } = {};
const sr2: { current?: import("../src/types.ts").TurnState } = {};
const sr3: { current?: import("../src/types.ts").TurnState } = {};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<{ events: AgentEvent[]; done?: DoneReason }> {
  const events: AgentEvent[] = [];
  let done: DoneReason | undefined;
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    if (r.value.type === "done") done = r.value.reason;
    r = await gen.next();
  }
  return { events, done };
}

function echoTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "echo",
    description: "echo input",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(input) {
      return `echo:${(input as { text: string }).text}`;
    },
    ...overrides,
  };
}

// ---- 协议不变量 ----

describe("协议不变量断言（§12.2）", () => {
  it("tool_use 无 tool_result → 抛", () => {
    expect(() =>
      assertProtocolInvariants([
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      ]),
    ).toThrow(HarnessInvariantError);
  });
  it("tool_result 先于 tool_use → 抛", () => {
    expect(() =>
      assertProtocolInvariants([{ role: "user", content: [{ type: "tool_result", toolUseId: "t9", content: "x" }] }]),
    ).toThrow(HarnessInvariantError);
  });
  it("重复 tool_use id → 抛", () => {
    expect(() =>
      assertProtocolInvariants([
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }, { type: "tool_use", id: "t1", name: "echo", input: {} }] },
      ]),
    ).toThrow(HarnessInvariantError);
  });
  it("一一配对 → 通过", () => {
    expect(() =>
      assertProtocolInvariants([
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
      ]),
    ).not.toThrow();
  });
});

// ---- schema 校验 ----

describe("工具输入 schema 校验（fail-closed）", () => {
  const schema = { type: "object", properties: { text: { type: "string" }, n: { type: "integer" } }, required: ["text"] };
  it("缺 required → 拒", () => expect(validateToolInput(schema, {})).toContain("missing required property"));
  it("类型不符 → 拒", () => expect(validateToolInput(schema, { text: 1 })).toContain("expected string"));
  it("integer 收到 float → 拒", () => expect(validateToolInput(schema, { text: "a", n: 1.5 })).toContain("expected integer"));
  it("合法 → 通过", () => expect(validateToolInput(schema, { text: "a", n: 2 })).toBeNull());
  it("非 object → 拒", () => expect(validateToolInput(schema, "x")).toContain("must be an object"));
});

// ---- 工具回路 ----

describe("runTools", () => {
  it("回灌顺序=block index（并行 safe 工具乱序完成也不乱）", async () => {
    const slow: Tool = {
      name: "slow",
      description: "",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return "slow-done";
      },
    };
    const fast: Tool = {
      name: "fast",
      description: "",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async () => "fast-done",
    };
    const registry = { get: (n: string) => ({ slow, fast })[n] };
    const out = await runTools(
      [
        { id: "a", name: "slow", input: {} },
        { id: "b", name: "fast", input: {} },
      ],
      { registry },
    );
    expect(out.map((o) => o.id)).toEqual(["a", "b"]);
    expect(out.map((o) => o.content)).toEqual(["slow-done", "fast-done"]);
  });
  it("未知工具/权限拒绝/schema 拒绝 → error tool_result", async () => {
    const registry = { get: (n: string) => (n === "echo" ? echoTool() : undefined) };
    const out = await runTools(
      [
        { id: "1", name: "nope", input: {} },
        { id: "2", name: "echo", input: {} },
        { id: "3", name: "echo", input: { text: "hi" } },
      ],
      { registry, permission: { check: async (name, input) => ((input as { text?: string })?.text === "hi" ? "allow" : "deny") } },
    );
    expect(out[0].isError).toBe(true);
    expect(out[1].isError).toBe(true);
    expect(out[1].content).toContain("permission denied");
    expect(out[2]).toMatchObject({ isError: false, content: "echo:hi" });
  });
  it("中断：未完成的调用合成 error tool_result", async () => {
    const ctl = new AbortController();
    const hang: Tool = {
      name: "hang",
      description: "",
      inputSchema: { type: "object" },
      execute: async (_input, ctx) => {
        await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
        ctx.signal.throwIfAborted();
        return "never";
      },
    };
    const registry = { get: () => hang };
    setTimeout(() => ctl.abort(), 80);
    const out = await runTools(
      [
        { id: "h1", name: "hang", input: {} },
        { id: "h2", name: "hang", input: {} },
      ],
      { registry, signal: ctl.signal },
    );
    expect(out.map((o) => o.isError)).toEqual([true, true]);
    expect(out.every((o) => o.content === "interrupted" || o.content.startsWith("tool error"))).toBe(true);
  });
});

// ---- 主循环 ----

describe("runAgentLoop（ARCH-005 主循环）", () => {
  it("⑨ 正常完成：文本入历史、usage 四列累计", async () => {
    const reqs: LLMRequest[] = [];
    const p = queueProvider(
      [
        [
          { type: "message_start", id: "m1", model: "m" },
          { type: "text_delta", text: "你好" },
          { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheCreationTokens: 1, cacheReadTokens: 3 } },
          ...STOP,
        ],
      ],
      { reqs },
    );
    const { events, done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(done).toBe("end");
    const usage = events.find((e) => e.type === "usage") as { usage: { inputTokens: number } };
    expect(usage.usage.inputTokens).toBe(10);
  });

  it("工具轮：tool_use→执行→tool_result 回灌→二轮完成（消息历史形状正确）", async () => {
    const reqs: LLMRequest[] = [];
    const p = queueProvider(
      [
        [
          { type: "tool_start", id: "t1", name: "echo" },
          { type: "tool_input_delta", id: "t1", jsonPartial: '{"text":"hi"}' },
          { type: "tool_end", id: "t1" },
          { type: "finish", reason: "tool_calls", raw: "tool_use" },
        ],
        [{ type: "finish", reason: "completed", raw: "end_turn" }],
      ],
      { reqs },
    );
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [echoTool()] }));
    expect(done).toBe("end");
    expect(reqs[1].messages.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(reqs[1].messages.at(-1))).toContain('"toolUseId":"t1"');
    expect(JSON.stringify(reqs[1].messages.at(-1))).toContain("echo:hi");
  });

  it("③ max_tokens 续写：限 3 次，预算耗尽 truncated_gave_up", async () => {
    const trunc = [{ type: "finish", reason: "truncated", raw: "max_tokens" } as LLMEvent];
    const p = queueProvider([trunc, trunc, trunc, trunc]);
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(done).toBe("truncated_gave_up");
    const p2 = queueProvider([trunc, trunc, [{ type: "text_delta", text: "more" }, ...STOP]]);
    const { done: done2 } = await collect(runAgentLoop({ provider: p2, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(done2).toBe("end");
  });

  it("④ 流中断（finish{unknown}）走续写通道", async () => {
    const cut: LLMEvent[] = [{ type: "text_delta", text: "par" }, { type: "finish", reason: "unknown", raw: null }];
    const p = queueProvider([cut, [{ type: "finish", reason: "completed", raw: "end_turn" }]]);
    const { events, done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(done).toBe("end");
    expect(events.some((e) => e.type === "recovery" && e.chain === "stream_resume")).toBe(true);
  });

  it("⑤ 畸形工具调用：JSON 断 → 重试 → 预算耗尽 fail-closed", async () => {
    const bad = [
      { type: "tool_start", id: "t1", name: "echo" },
      { type: "tool_input_delta", id: "t1", jsonPartial: "{not json" },
      { type: "tool_end", id: "t1" },
      { type: "finish", reason: "tool_calls", raw: "tool_use" },
    ] as LLMEvent[];
    const p = queueProvider([bad, bad, bad, bad]);
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [echoTool()], maxMalformedRounds: 3 }));
    expect(done).toBe("malformed_fail_closed");
    const p2 = queueProvider([bad, [{ type: "finish", reason: "completed", raw: "end_turn" }]]);
    const { done: done2 } = await collect(runAgentLoop({ provider: p2, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [echoTool()] }));
    expect(done2).toBe("end");
  });

  it("⑧ max-turns：轮数超限即止", async () => {
    const toolRound: LLMEvent[] = [
      { type: "tool_start", id: "t", name: "echo" },
      { type: "tool_input_delta", id: "t", jsonPartial: '{"text":"x"}' },
      { type: "tool_end", id: "t" },
      { type: "finish", reason: "tool_calls", raw: "tool_use" },
    ];
    const p = queueProvider([toolRound]);
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [echoTool()], maxToolRounds: 2 }));
    expect(done).toBe("max_turns");
  });

  it("② context_length → context_exhausted（CTX-101：新会话，不压缩）", async () => {
    const p: ProviderAdapter = {
      capabilities: () => {
        throw new Error();
      },
      countTokens: async () => 0,
      async *stream() {
        throw Object.assign(new Error("prompt is too long"), { kind: "context_length", status: 400 });
      },
    };
    const { events, done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }));
    expect(done).toBe("context_exhausted");
    expect(events.some((e) => e.type === "context_exhausted")).toBe(true);
  });

  it("中断（工具执行中）：停流保留已生成 + 未完成工具合成 error tool_result + 无悬空 tool_use", async () => {
    const ctl = new AbortController();
    const hang: Tool = {
      name: "hang",
      description: "",
      inputSchema: { type: "object" },
      execute: async (_input, ctx) => {
        await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
        ctx.signal.throwIfAborted();
        return "never";
      },
    };
    const p = queueProvider([
      [
        { type: "text_delta", text: "thinking..." },
        { type: "tool_start", id: "t1", name: "hang" },
        { type: "tool_input_delta", id: "t1", jsonPartial: "{}" },
        { type: "tool_end", id: "t1" },
        { type: "finish", reason: "tool_calls", raw: "tool_use" },
      ],
    ]);
    const stateRef: { current?: import("../src/types.ts").TurnState } = {};
    const gen = runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [hang], signal: ctl.signal, stateRef });
    setTimeout(() => ctl.abort(), 150);
    const { events, done } = await collect(gen);
    expect(done).toBe("interrupted");
    const toolResults = events.filter((e) => e.type === "tool_result") as Array<{ content: string; isError?: boolean }>;
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].isError).toBe(true);
    // 协议不变量：中断后的消息序列仍无悬空 tool_use（终态经 stateRef 回填）
    expect(stateRef.current).toBeDefined();
    expect(() => assertProtocolInvariants(stateRef.current!.messages)).not.toThrow();
  });

  it("中断（生成中）：partial 文本保留进历史、phase=stream", async () => {
    const ctl = new AbortController();
    const p: ProviderAdapter = {
      capabilities: () => {
        throw new Error();
      },
      countTokens: async () => 0,
      async *stream() {
        yield { type: "text_delta", text: "par" };
        await new Promise((r) => setTimeout(r, 8000)); // 挂起的流
        yield { type: "text_delta", text: "tial" };
      },
    };
    const gen = runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], signal: ctl.signal });
    setTimeout(() => ctl.abort(), 120);
    const { events, done } = await collect(gen);
    expect(done).toBe("interrupted");
    expect(events.some((e) => e.type === "interrupted" && e.phase === "stream")).toBe(true);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("par");
  });

  it("回归（V 首验清单外-1）：截断发生于 tool_use 中途——③④与普通工具轮均不悬空、不崩", async () => {
    // 变体①：④ text+tool_start+完整 JSON 增量+finish{unknown}（无 tool_end）
    const v1 = queueProvider([
      [
        { type: "text_delta", text: "t" },
        { type: "tool_start", id: "tx", name: "echo" },
        { type: "tool_input_delta", id: "tx", jsonPartial: '{"text":"hi"}' },
        { type: "finish", reason: "unknown", raw: null },
      ],
      [{ type: "finish", reason: "completed", raw: "end_turn" }],
    ]);
    const r1 = await collect(runAgentLoop({ provider: v1, model: "m", messages: baseMessages(), tools: [echoTool()], stateRef: sr1 }));
    expect(r1.done).toBe("end");
    expect(() => assertProtocolInvariants(sr1.current!.messages)).not.toThrow();

    // 变体②：③ tool_start 后零输入即 truncated
    const v2 = queueProvider([
      [
        { type: "tool_start", id: "ta", name: "echo" },
        { type: "finish", reason: "truncated", raw: "max_tokens" },
      ],
      [{ type: "finish", reason: "completed", raw: "end_turn" }],
    ]);
    const r2 = await collect(runAgentLoop({ provider: v2, model: "m", messages: baseMessages(), tools: [echoTool()], stateRef: sr2 }));
    expect(r2.done).toBe("end");
    expect(() => assertProtocolInvariants(sr2.current!.messages)).not.toThrow();

    // 变体③：普通工具轮并行截断（t1 完整执行 + t2 未终止合成 error）——单条回灌保持 block 序
    const v3 = queueProvider([
      [
        { type: "tool_start", id: "t1", name: "echo" },
        { type: "tool_input_delta", id: "t1", jsonPartial: '{"text":"a"}' },
        { type: "tool_end", id: "t1" },
        { type: "tool_start", id: "t2", name: "echo" },
        { type: "finish", reason: "tool_calls", raw: "tool_use" },
      ],
      [{ type: "finish", reason: "completed", raw: "end_turn" }],
    ]);
    const r3 = await collect(runAgentLoop({ provider: v3, model: "m", messages: baseMessages(), tools: [echoTool()], stateRef: sr3 }));
    expect(r3.done).toBe("end");
    expect(() => assertProtocolInvariants(sr3.current!.messages)).not.toThrow();
    const results = r3.events.filter((e) => e.type === "tool_result") as Array<{ id: string; isError?: boolean }>;
    expect(results.map((r) => r.id)).toEqual(["t1", "t2"]); // block 序
    expect(results.map((r) => r.isError)).toEqual([false, true]); // 完整者真实执行、未终止者 error
  });

  it("回归（WP-05/ADR-0027）：Anthropic 合并式 usage 双上报——轮内取最后一条快照，input 不翻倍", async () => {
    const p = queueProvider([
      [
        { type: "message_start", id: "m", model: "m" },
        { type: "usage", usage: { inputTokens: 120, outputTokens: 1, cacheCreationTokens: 53, cacheReadTokens: 0 } },
        { type: "text_delta", text: "x" },
        { type: "usage", usage: { inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 } },
        ...STOP,
      ],
    ]);
    const stateRef: { current?: import("../src/types.ts").TurnState } = {};
    const { events, done } = await collect(runAgentLoop({ provider: p, model: "m", messages: baseMessages(), stateRef }));
    expect(done).toBe("end");
    const last = events.filter((e) => e.type === "usage").at(-1) as { usage: { inputTokens: number; outputTokens: number } };
    expect(last.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 });
    expect(stateRef.current!.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheCreationTokens: 53, cacheReadTokens: 0 });
  });

  it("回归（V 清单外-2）：无 finish 事件（流硬断）走④续写通道", async () => {
    const noFinish = queueProvider([
      [{ type: "text_delta", text: "cut" }],
      [{ type: "finish", reason: "completed", raw: "end_turn" }],
    ]);
    const { events, done } = await collect(runAgentLoop({ provider: noFinish, model: "m", messages: baseMessages() }));
    expect(done).toBe("end");
    expect(events.some((e) => e.type === "recovery" && e.chain === "stream_resume")).toBe(true);
  });

  it("主循环无递归：深轮次工具链状态递推不爆栈", async () => {
    const toolRound: LLMEvent[] = [
      { type: "tool_start", id: "t", name: "echo" },
      { type: "tool_input_delta", id: "t", jsonPartial: '{"text":"x"}' },
      { type: "tool_end", id: "t" },
      { type: "finish", reason: "tool_calls", raw: "tool_use" },
    ];
    const pages = Array.from({ length: 40 }, () => toolRound);
    pages.push([{ type: "finish", reason: "completed", raw: "end_turn" }]);
    const p = queueProvider(pages);
    const { done } = await collect(runAgentLoop({ provider: p, model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }], tools: [echoTool()], maxToolRounds: 45 }));
    expect(done).toBe("end");
  });
});
