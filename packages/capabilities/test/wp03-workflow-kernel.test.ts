// M6-WP-03：workflow 编排内核测试（v2.8 ORC-022/023/024；A 级 claude-code-workflow.md §4/§5/§6）。
// 逐条覆盖卡 DoD①-⑥ 与边界。复用 M3 runSubagent/validateSpawn（真派生，非平行实现）。
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import type { Tool } from "@standardcode/harness";
import {
  DEFAULT_STRUCTURED_OUTPUT_RETRY_CAP,
  MAX_WORKFLOW_AGENTS,
  WORKFLOW_MAX_ITEMS,
  WorkflowAgentCapError,
  WorkflowBudgetError,
  WorkflowItemsLimitError,
  concurrencyCapacity,
  createWorkflowOrchestrator,
  makeWorkflowBudget,
  type WorkflowOrchestratorOptions,
} from "../src/workflow/kernel.ts";
import * as harnessModule from "@standardcode/harness";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 };

const TOOLS: Tool[] = [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }];

/** 最轻量 fake provider：单轮文本完成；可选 onStart/onEnd 钩子与延时（并发/在途观测）。 */
function makeFakeProvider(
  text: string,
  hooks?: { onStart?: () => void; onEnd?: () => void; delayMs?: number },
): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("unused");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      hooks?.onStart?.();
      if (hooks?.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: USAGE } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      hooks?.onEnd?.();
    },
  };
}

/** 可控 provider：首次 stream 调用被一个 deferred 挂起（用于在途 agent 观测）。 */
function makeControllableProvider(text: string) {
  let callCount = 0;
  let heldResolve: (() => void) | null = null;
  const provider: ProviderAdapter = {
    capabilities: () => {
      throw new Error("unused");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      const idx = callCount++;
      if (idx === 0) await new Promise<void>((r) => {
        heldResolve = r;
      });
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: USAGE } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
  return { provider, releaseFirst: () => heldResolve?.() };
}

function orch(over: Partial<WorkflowOrchestratorOptions> & { provider: ProviderAdapter }) {
  return createWorkflowOrchestrator({
    model: "m",
    tools: TOOLS,
    availableTypes: ["general-purpose"],
    ...over,
  });
}

describe("DoD② 并发信号量 min(16,max(2,cpus−2)) 含下限 2 保护", () => {
  it("公式实测 = 手算值（含上限 16 / 下限 2 保护）", () => {
    const orig = os.availableParallelism.bind(os);
    const spy = vi.spyOn(os, "availableParallelism");
    const f = (n: number) => Math.min(16, Math.max(2, n - 2));
    for (const cpus of [1, 3, 4, 8, 16, 32]) {
      spy.mockImplementation(() => cpus);
      expect(concurrencyCapacity()).toBe(f(cpus));
    }
    spy.mockImplementation(orig);
  });

  it("多 agent 并发在途数不超过容量（override=2 → maxActive==2）", async () => {
    let active = 0;
    let maxActive = 0;
    const provider = makeFakeProvider("ok", {
      onStart: () => {
        active++;
        maxActive = Math.max(maxActive, active);
      },
      onEnd: () => {
        active--;
      },
      delayMs: 30,
    });
    const o = orch({ provider, concurrencyCapacityOverride: 2 });
    const results = await o.parallel(
      Array.from({ length: 8 }, (_, i) => () => o.agent(`p${i}`)),
    );
    expect(results).toEqual(Array(8).fill("ok"));
    expect(maxActive).toBe(2);
  });
});

describe("DoD① agent() 复用 ORC-022 校验序列（M3 validateSpawn）", () => {
  it("validateSpawn 被 agent() 调用（复用而非平行实现）", async () => {
    const spy = vi.spyOn(harnessModule, "validateSpawn");
    const o = orch({ provider: makeFakeProvider("ok") });
    await o.agent("p");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("校验拒绝（未知类型 / 深度上限 3）→ 该 agent 结果 null（跳过，不崩溃 workflow）", async () => {
    const o1 = orch({ provider: makeFakeProvider("ok") });
    expect(await o1.agent("p", { agentType: "Nope" })).toBeNull();

    const o2 = orch({ provider: makeFakeProvider("ok"), depth: 3 });
    expect(await o2.agent("p")).toBeNull();
  });

  it("校验通过：agent 真派生并返回 subagent 文本（复用 M3 runSubagent）", async () => {
    const o = orch({ provider: makeFakeProvider("result-text") });
    expect(await o.agent("do work")).toBe("result-text");
  });
});

describe("DoD③ 生命周期 agent 总数硬顶 1000 → WorkflowAgentCapError 且遥测只发一次", () => {
  it("MAX_WORKFLOW_AGENTS === 1000", () => {
    expect(MAX_WORKFLOW_AGENTS).toBe(1000);
  });

  it("第 1001 次 agent() 抛 WorkflowAgentCapError（name 同名），且遥测仅发一次", async () => {
    let capEvents = 0;
    const o = orch({
      provider: makeFakeProvider("ok"),
      maxAgents: 1000,
      concurrencyCapacityOverride: 1000,
      onTelemetry: (e) => {
        if (e === "tengu_workflow_agent_cap_exceeded") capEvents++;
      },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 1001 }, (_, i) =>
        o.agent(`p${i}`).then(
          () => ({ threw: false as const }),
          (e: Error) => ({ threw: true as const, name: e.name }),
        ),
      ),
    );
    const threw = outcomes.filter((o) => o.threw);
    expect(threw).toHaveLength(1);
    expect(threw[0]!.name).toBe("WorkflowAgentCapError");
    expect(capEvents).toBe(1);
  });
});

describe("DoD④ budget 硬顶：total=null→remaining()=Infinity；超顶不新发但在途保留", () => {
  it("makeWorkflowBudget(total=null) → remaining()===Infinity", () => {
    const b = makeWorkflowBudget(null, () => 0);
    expect(b.total).toBeNull();
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("total=null 视为无预算：agent 正常派生（不拦截）", async () => {
    const o = orch({ provider: makeFakeProvider("ok"), budget: makeWorkflowBudget(null, () => 0) });
    expect(await o.agent("p")).toBe("ok");
  });

  it("超顶时：新 agent() 抛 WorkflowBudgetError 且零新 spawn（并行 5 个全部 null）", async () => {
    let spawned = 0;
    const o = orch({
      provider: makeFakeProvider("ok", { onStart: () => spawned++ }),
      budget: makeWorkflowBudget(2, () => 5), // remaining 已为 0
    });
    const results = await o.parallel(Array.from({ length: 5 }, () => () => o.agent("p")));
    expect(results).toEqual([null, null, null, null, null]);
    expect(spawned).toBe(0);
  });

  it("在途保留：budget 在 A 在途、B 提交后耗尽，C 被拒，A 结果仍保留", async () => {
    let spent = 0;
    const { provider, releaseFirst } = makeControllableProvider("ok");
    const o = orch({
      provider,
      budget: makeWorkflowBudget(2, () => spent),
      onAgentCommitted: () => {
        spent++;
      },
    });
    const pA = o.agent("A"); // 提交(spent=1)，provider 被挂起 → 在途
    const rB = await o.agent("B"); // 提交(spent=2)，快速完成
    let cName: string | null = null;
    try {
      await o.agent("C");
    } catch (e) {
      cName = (e as Error).name;
    }
    releaseFirst();
    const rA = await pA;
    expect(rA).toBe("ok"); // 在途 A 结果保留
    expect(rB).toBe("ok");
    expect(cName).toBe("WorkflowBudgetError");
    expect(spent).toBe(2); // 仅 A,B 提交，C 未新发
  });
});

describe("DoD⑤ parallel() 有 barrier / pipeline() 无 barrier；单 thunk/stage 抛错落 null 不整体 reject", () => {
  it("parallel 有 barrier：单 thunk 抛错 → 对应位 null，其余照常完成，整体不 reject", async () => {
    const o = orch({ provider: makeFakeProvider("ok") });
    const slowRan: string[] = [];
    const results = await o.parallel([
      () => Promise.reject(new Error("boom")),
      () =>
        new Promise<string>((res) => {
          slowRan.push("slow");
          setTimeout(() => res("slow-ok"), 10);
        }),
      () => Promise.resolve("c"),
    ]);
    expect(results).toEqual([null, "slow-ok", "c"]);
    expect(slowRan).toEqual(["slow"]); // 慢 thunk 也被等完（barrier）
  });

  it("pipeline 无 barrier：单 stage 抛错 → 该项落 null 且后续 stage 跳过；其余项不受影响", async () => {
    const o = orch({ provider: makeFakeProvider("ok") });
    const stageCalls: string[] = [];
    const results = await o.pipeline(
      ["x", "y"],
      (prev, item) => {
        stageCalls.push(`s1:${item}`);
        return `${item}-1`;
      },
      (prev, item) => {
        if (item === "x") throw new Error("stage2 fail");
        stageCalls.push(`s2:${item}`);
        return `${prev}-2`;
      },
      (prev, item) => {
        stageCalls.push(`s3:${item}`);
        return `${prev}-3`;
      },
    );
    expect(results).toEqual([null, "y-1-2-3"]);
    expect(stageCalls).toContain("s1:x");
    expect(stageCalls).toContain("s1:y");
    expect(stageCalls).toContain("s2:y");
    expect(stageCalls).toContain("s3:y");
    expect(stageCalls).not.toContain("s2:x"); // x 的后续 stage 被跳过
    expect(stageCalls).not.toContain("s3:x");
  });

  it("items 上限 4096：超出抛 WorkflowItemsLimitError，恰 4096 放行", async () => {
    const o = orch({ provider: makeFakeProvider("ok") });
    await expect(
      o.parallel(Array.from({ length: WORKFLOW_MAX_ITEMS + 1 }, () => () => Promise.resolve(1))),
    ).rejects.toThrow(WorkflowItemsLimitError);
    await expect(
      o.pipeline(Array.from({ length: WORKFLOW_MAX_ITEMS }, (_, i) => i)),
    ).resolves.toHaveLength(WORKFLOW_MAX_ITEMS);
    await expect(
      o.parallel(Array.from({ length: WORKFLOW_MAX_ITEMS }, () => () => Promise.resolve(1))),
    ).resolves.toHaveLength(WORKFLOW_MAX_ITEMS);
  });
});

describe("DoD⑥ StructuredOutput 校验失败重试至上限后落 null", () => {
  it("DEFAULT_STRUCTURED_OUTPUT_RETRY_CAP === 3（[自定]）", () => {
    expect(DEFAULT_STRUCTURED_OUTPUT_RETRY_CAP).toBe(3);
  });

  it("schema 恒不通过 → 重试 retryCap 次后该 agent 结果 null，且确实重试了 retryCap 次", async () => {
    let calls = 0;
    const o = orch({
      provider: makeFakeProvider("not-json"),
      structuredOutputValidator: () => {
        calls++;
        return { ok: false };
      },
      structuredOutputRetryCap: 3,
    });
    const r = await o.agent("p", { schema: { type: "object", required: ["x"] } });
    expect(r).toBeNull();
    expect(calls).toBe(3);
  });

  it("首次即通过 → 返回校验值（仅 1 次派生）", async () => {
    let calls = 0;
    const o = orch({
      provider: makeFakeProvider('{"x":1}'),
      structuredOutputValidator: (text: string) => {
        calls++;
        return { ok: true, value: JSON.parse(text) };
      },
    });
    const r = await o.agent("p", { schema: { type: "object", required: ["x"] } });
    expect(r).toEqual({ x: 1 });
    expect(calls).toBe(1);
  });

  it("第 2 次重试才通过 → 返回校验值（重试计数=2）", async () => {
    let calls = 0;
    const o = orch({
      provider: makeFakeProvider("ok"),
      structuredOutputValidator: (text: string) => {
        calls++;
        return calls >= 2 ? { ok: true, value: text } : { ok: false };
      },
    });
    const r = await o.agent("p", { schema: {} });
    expect(r).toBe("ok");
    expect(calls).toBe(2);
  });

  it("无 schema → 直接返回文本（不走重试路径）", async () => {
    const o = orch({ provider: makeFakeProvider("plain") });
    expect(await o.agent("p")).toBe("plain");
  });
});

describe("phase()/log() 转发（进度=WP-05，本卡仅转发）", () => {
  it("phase/log 回调被调用", () => {
    const phases: string[] = [];
    const logs: string[] = [];
    const o = orch({ provider: makeFakeProvider("ok"), onPhase: (t) => phases.push(t), onLog: (m) => logs.push(m) });
    o.phase?.("setup");
    o.log?.("working");
    expect(phases).toEqual(["setup"]);
    expect(logs).toEqual(["working"]);
  });
});
