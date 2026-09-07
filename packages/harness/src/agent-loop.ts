// L1 主循环（v2.8 §5.1 ARCH-005、§5.4 请求生命周期与九级恢复链）。
// 结构：单进程 async 生成器 + 单 while 大循环 + turn 状态对象递推；禁递归 turn（ARCH-005）。
// 恢复链（§5.4 九级，M1 最小集——卡边界）：
//   ②prompt-too-long → CTX-101：M1 一律"新会话"，不发压缩请求（done: context_exhausted）
//   ③max_tokens 续写（限 maxContinuations，默认 3）
//   ⑤畸形工具调用重试（限 maxMalformedRounds，默认 3；预算耗尽 fail-closed）
//   ⑧max-turns（工具轮数上限，默认 25）
//   ⑨正常完成
//   ①⑥⑦留接口（M2/M4）；④流中断以 finish{unknown}/paused/无 finish 表现，走③同一续写通道（共享预算，
//     WP-01 V 跑偏#6 补注：恢复链④输入=无 finish 事件或 finish{unknown}，两协议对称）
// 中断不变量（§8.4）：生成中=停流保留已生成（partial 文本进消息历史）；工具执行中=信号传播
// +每个未完成工具合成 error tool_result（协议不留悬空 tool_use，硬不变量）。

import type {
  AgentEvent,
  ContentBlock,
  DoneReason,
  LoopOptions,
  TurnState,
} from "./types.ts";
import type { LLMEvent, LLMRequest } from "@standardcode/providers";
import type { ToolCall } from "./tools.ts";
import { assertProtocolInvariants } from "./invariant.ts";
import { runTools } from "./tools.ts";
import type { ProviderError } from "@standardcode/providers";

const DEFAULTS = {
  maxToolRounds: 25,
  maxContinuations: 3,
  maxMalformedRounds: 3,
} as const;

const ABORTED = Symbol("aborted");

export async function* runAgentLoop(opts: LoopOptions): AsyncGenerator<AgentEvent, TurnState> {
  const registry = {
    get: (name: string) => opts.tools?.find((t) => t.name === name),
  };
  const state: TurnState = {
    messages: [...opts.messages],
    toolRounds: 0,
    continuations: 0,
    malformedRounds: 0,
    usage: null,
  };
  const signal = opts.signal;
  const maxToolRounds = opts.maxToolRounds ?? DEFAULTS.maxToolRounds;
  const maxContinuations = opts.maxContinuations ?? DEFAULTS.maxContinuations;
  const maxMalformedRounds = opts.maxMalformedRounds ?? DEFAULTS.maxMalformedRounds;
  const assertInvariants = opts.assertInvariants ?? true;

  yield { type: "turn_start" };

  // —— ARCH-005：单 while 大循环，状态对象递推，无递归 turn ——
  while (true) {
    if (signal?.aborted) {
      yield { type: "interrupted", phase: "stream" };
      if (opts.stateRef) opts.stateRef.current = state;
      yield { type: "done", reason: "interrupted" };
      return state;
    }
    if (assertInvariants) assertProtocolInvariants(state.messages);

    const req: LLMRequest = {
      model: opts.model,
      ...(opts.system ? { system: opts.system } : {}),
      messages: state.messages,
      tools: opts.tools?.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      signal,
    };

    // —— L5 流式消费（iterator + abort 竞速：挂起的流也能被打断）——
    const blocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const toolInputs = new Map<string, string>();
    const toolNames = new Map<string, string>();
    let finish: { reason: string; raw: string | null } | null = null;
    let partialText = "";
    let streamError: ProviderError | null = null;
    let malformedThisRound = false;

    const it = opts.provider.stream(req)[Symbol.asyncIterator]();
    while (true) {
      if (signal?.aborted) break;
      let r: IteratorResult<LLMEvent> | null;
      try {
        r = signal
          ? await Promise.race([
              it.next(),
              new Promise<null>((res) => signal.addEventListener("abort", () => res(null), { once: true })),
            ])
          : await it.next();
      } catch (err) {
        if (signal?.aborted) break;
        if (isContextLength(err)) {
          // 恢复链②：CTX-101——M1 不做半成品压缩，交还用户开新会话
          yield { type: "context_exhausted" };
          yield { type: "done", reason: "context_exhausted" };
          return state;
        }
        throw err;
      }
      if (r === null || r.done) break; // r===null：abort 竞速胜出（停流）
      const ev = r.value;
      switch (ev.type) {
        case "text_delta":
          partialText += ev.text;
          yield { type: "text_delta", text: ev.text };
          break;
        case "thinking_delta":
          yield { type: "thinking_delta", thinking: ev.thinking };
          break;
        case "tool_start":
          toolNames.set(ev.id, ev.name);
          toolInputs.set(ev.id, "");
          yield { type: "tool_start", id: ev.id, name: ev.name };
          break;
        case "tool_input_delta":
          toolInputs.set(ev.id, (toolInputs.get(ev.id) ?? "") + ev.jsonPartial);
          break;
        case "tool_end": {
          const raw = toolInputs.get(ev.id) ?? "";
          try {
            const input = raw === "" ? {} : JSON.parse(raw);
            toolCalls.push({ id: ev.id, name: toolNames.get(ev.id) ?? "", input });
          } catch {
            malformedThisRound = true; // 恢复链⑤：畸形工具调用
          }
          break;
        }
        case "usage":
          state.usage = state.usage
            ? {
                inputTokens: state.usage.inputTokens + ev.usage.inputTokens,
                outputTokens: state.usage.outputTokens + ev.usage.outputTokens,
                cacheCreationTokens: state.usage.cacheCreationTokens + ev.usage.cacheCreationTokens,
                cacheReadTokens: state.usage.cacheReadTokens + ev.usage.cacheReadTokens,
              }
            : ev.usage;
          yield { type: "usage", usage: state.usage };
          break;
        case "finish":
          finish = { reason: ev.reason, raw: ev.raw };
          yield { type: "finish", reason: ev.reason, raw: ev.raw };
          break;
        case "error":
          streamError = ev.error;
          break;
      }
    }
    if (signal?.aborted) {
      // 停流：关闭底层迭代器（保留已生成内容）
      try {
        it.return?.(undefined as never); // 停流：不等待生成器清退（其内部挂起不应阻塞中断）
      } catch {}
    }

    // —— 块收尾（无论中断与否）：partial 文本 + 已完整 tool_use；未终止的 tool_use 尽力解析 ——
    if (partialText) blocks.push({ type: "text", text: partialText });
    for (const call of toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    for (const [id, raw] of toolInputs) {
      if (toolCalls.some((c) => c.id === id)) continue;
      try {
        blocks.push({ type: "tool_use", id, name: toolNames.get(id) ?? "", input: raw === "" ? {} : JSON.parse(raw) });
      } catch {
        malformedThisRound = true; // tool_start 过但流断，input 不完整 → ⑤
      }
    }

    // —— 中断收尾（§8.4）：保留已生成；已完成工具的回灌在 runTools 侧合成，此处先入 assistant ——
    if (signal?.aborted) {
      if (blocks.length > 0) state.messages.push({ role: "assistant", content: blocks });
      const hadTools = toolCalls.length > 0 || toolInputs.size > 0;
      if (hadTools) {
        // 未执行的调用合成 error tool_result（无悬空 tool_use，硬不变量）
        const pending: ToolCall[] = [...toolCalls, ...[...toolInputs.keys()].filter((id) => !toolCalls.some((c) => c.id === id)).map((id) => ({ id, name: toolNames.get(id) ?? "", input: {} }))];
        const outcomes = await runTools(pending, { registry, permission: opts.permission, signal });
        const resultBlocks: ContentBlock[] = outcomes.map((o) => ({ type: "tool_result", toolUseId: o.id, content: o.content, isError: true }));
        for (const o of outcomes) yield { type: "tool_result", ...o, isError: true };
        state.messages.push({ role: "user", content: resultBlocks });
        yield { type: "interrupted", phase: "tool" };
      } else {
        yield { type: "interrupted", phase: "stream" };
      }
      if (opts.stateRef) opts.stateRef.current = state;
      yield { type: "done", reason: "interrupted" };
      return state;
    }

    // —— 流级错误（非中断）——
    if (streamError && !finish) {
      if (isContextLength(streamError)) {
        yield { type: "context_exhausted" };
        yield { type: "done", reason: "context_exhausted" };
        return state;
      }
      throw streamError; // M1：硬错误上抛（④硬网络中断的续写细化登记偏差）
    }

    if (blocks.length > 0) state.messages.push({ role: "assistant", content: blocks });

    // —— 无工具调用：finish 语义分派 ——
    if (toolCalls.length === 0) {
      if (malformedThisRound) {
        // 恢复链⑤：畸形——丢弃本轮重试
        if (state.malformedRounds < maxMalformedRounds) {
          state.malformedRounds++;
          yield { type: "recovery", chain: "malformed_retry", round: state.malformedRounds };
          continue;
        }
        yield { type: "done", reason: "malformed_fail_closed" };
        return state;
      }
      if (finish?.reason === "truncated") {
        // 恢复链③：max_tokens 续写（限 3）
        if (state.continuations < maxContinuations) {
          state.continuations++;
          yield { type: "recovery", chain: "max_tokens_continue", round: state.continuations };
          continue;
        }
        yield { type: "done", reason: "truncated_gave_up" };
        return state;
      }
      if (finish?.reason === "unknown" || finish?.reason === "paused") {
        // 恢复链④：流中断续写（与③共享预算）
        if (state.continuations < maxContinuations) {
          state.continuations++;
          yield { type: "recovery", chain: "stream_resume", round: state.continuations };
          continue;
        }
        yield { type: "done", reason: "truncated_gave_up" };
        return state;
      }
      if (finish?.reason === "filtered") {
        yield { type: "done", reason: "filtered" };
        return state;
      }
      // ⑨正常完成
      if (opts.stateRef) opts.stateRef.current = state;
      yield { type: "done", reason: "end" };
      return state;
    }

    // —— 工具轮预算（恢复链⑧）——
    if (state.toolRounds >= maxToolRounds) {
      // 预算耗尽：不执行（防预算边界外的副作用白跑），直接合成 error tool_result（无悬空 tool_use）
      const resultBlocks: ContentBlock[] = toolCalls.map((c) => ({
        type: "tool_result",
        toolUseId: c.id,
        content: "max tool rounds reached",
        isError: true,
      }));
      state.messages.push({ role: "user", content: resultBlocks });
      yield { type: "done", reason: "max_turns" };
      return state;
    }
    state.toolRounds++;

    // —— 工具执行（并发策略+中断合成）并按 block index 回填 ——
    const outcomes = await runTools(toolCalls, {
      registry,
      permission: opts.permission,
      signal,
    });
    const resultBlocks: ContentBlock[] = outcomes.map((o) => ({
      type: "tool_result",
      toolUseId: o.id,
      content: o.content,
      isError: o.isError,
    }));
    for (const o of outcomes) yield { type: "tool_result", ...o };
    state.messages.push({ role: "user", content: resultBlocks });
    // 循环递推（transition: next_turn）
  }
}

function isContextLength(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as ProviderError).kind === "context_length";
}

export type { DoneReason, LoopOptions };
