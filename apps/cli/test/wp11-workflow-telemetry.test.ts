// M6-WP-11：workflow 遥测端到端链集成测试（apps/cli 持 platform+capabilities 双依赖=正确装配位）。
// WP-03 V 节遗留清偿（cap 遥测判别力缺口→随 WP-11 补用例）：真内核跑满 agent cap / budget cap → 桥接 →
// facade sink 实收 sc_workflow_*（红例判别力：去 kernel 发射或去桥接映射即红——变异针逐针验证）。
// kernel/journal 实现零触碰（只消费 onTelemetry callback 面）；不改既有 telemetry 19+10 例断言一字。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import type { Tool } from "@standardcode/harness";
import type { TelemetryEnvelope, TelemetrySink } from "@standardcode/platform";
import { createTelemetryFacade, TELEMETRY_ENV_KEY } from "@standardcode/platform";
import {
  createWorkflowOrchestrator,
  createWorkflowTelemetryBridge,
  makeWorkflowBudget,
  parseWorkflowJournal,
  withWorkflowJournal,
} from "@standardcode/capabilities";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 };
const TOOLS: Tool[] = [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }];

function makeFakeProvider(text: string): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("unused");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: USAGE } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

function memorySink(): TelemetrySink & { events: TelemetryEnvelope[] } {
  const events: TelemetryEnvelope[] = [];
  return { events, write: (es) => { events.push(...es); } };
}

/** 真 end-to-end 装配（WP-03 清偿主形）：kernel/journal onTelemetry → bridge → facade → sink。 */
function wiredFacade(opts?: { env?: Record<string, string | undefined>; baseDir?: string }) {
  const sink = memorySink();
  const facade = createTelemetryFacade({
    env: opts?.env ?? { [TELEMETRY_ENV_KEY]: "1" },
    ...(opts?.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
    sink,
    sessionId: "wp11",
  });
  const bridge = createWorkflowTelemetryBridge({ forward: (event, payload) => facade.workflowEvent(event, payload) });
  return { sink, facade, bridge };
}

describe("WP-03 清偿①：真内核跑满 agent cap → 桥 → facade sink 实收 sc_workflow_agent_cap_exceeded", () => {
  it("maxAgents=3 第 4 次抛 WorkflowAgentCapError，sink 恰收一枚（payload agentCount=3）", async () => {
    const { sink, bridge } = wiredFacade();
    const o = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("ok"),
      concurrencyCapacityOverride: 1000,
      maxAgents: 3,
      onTelemetry: bridge,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        o.agent(`p${i}`).then(
          () => ({ threw: false as const }),
          (e: Error) => ({ threw: true as const, name: e.name }),
        ),
      ),
    );
    expect(outcomes.filter((x) => x.threw)).toHaveLength(1);
    const capEvents = sink.events.filter((e) => e.event === "sc_workflow_agent_cap_exceeded");
    expect(capEvents).toHaveLength(1); // 红例判别面：去 kernel 发射或去桥接映射 → 本断言红
    expect(capEvents[0]!.properties.agentCount).toBe(3);
    expect(sink.events.every((e) => e.event.startsWith("sc_"))).toBe(true); // 基线前缀族：无 tengu 裸名漏网
  });
});

describe("WP-03 清偿②：budget 硬顶 → 桥 → facade sink 实收 sc_workflow_budget_cap_exceeded", () => {
  it("total=2 spent=5 → 并行 5 全 null，sink 恰收一枚（payload spent=5/budget=2）", async () => {
    const { sink, bridge } = wiredFacade();
    const o = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("ok"),
      budget: makeWorkflowBudget(2, () => 5),
      onTelemetry: bridge,
    });
    const results = await o.parallel(Array.from({ length: 5 }, () => () => o.agent("p")));
    expect(results).toEqual([null, null, null, null, null]);
    const budgetEvents = sink.events.filter((e) => e.event === "sc_workflow_budget_cap_exceeded");
    expect(budgetEvents).toHaveLength(1); // 红例判别面同上
    expect(budgetEvents[0]!.properties).toEqual({ spent: 5, budget: 2, agentCount: 0 });
  });
});

describe("WP-03 清偿③：journal resume 命中 → 桥 → facade sink 实收 sc_workflow_journal_started_hit_respawn", () => {
  it("started+result+无 failed 的 key → 回放缓存并发射（payload key/agentId/attempts）", async () => {
    const { sink, bridge } = wiredFacade();
    const journalText = [
      JSON.stringify({ type: "started", key: "K", agentId: "wfagent-aa-1" }),
      JSON.stringify({ type: "result", key: "K", agentId: "wfagent-aa-1", result: "cached-value" }),
    ].join("\n");
    const orchestration = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("fresh"), // 命中则不派生：若误派生结果为 "fresh" 即暴露
    });
    const journaled = withWorkflowJournal(orchestration, {
      resume: parseWorkflowJournal(journalText),
      keyDerivation: () => "K",
      onTelemetry: bridge,
    });
    const result = await journaled.hooks.agent("any");
    expect(result).toBe("cached-value"); // 真回放（未派生）
    const hitEvents = sink.events.filter((e) => e.event === "sc_workflow_journal_started_hit_respawn");
    expect(hitEvents).toHaveLength(1); // 红例判别面同上
    expect(hitEvents[0]!.properties).toEqual({ key: "K", agentId: "wfagent-aa-1", attempts: 1 });
  });
});

describe("WP-11 DoD②/⑤ 默认关与接缝㉑：门关=emit 即返 / flag 关=桥接不注入 → 零事件零触盘", () => {
  it("遥测门关（无 env 无 settings）+桥接照常注入 → sink 零事件、文件桩目录不存在", async () => {
    const base = mkdtempSync(join(tmpdir(), "sc-wp11-cap-off-"));
    const { sink, bridge } = wiredFacade({ env: {}, baseDir: base });
    const o = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("ok"),
      concurrencyCapacityOverride: 1000,
      maxAgents: 1,
      onTelemetry: bridge,
    });
    await Promise.all(
      Array.from({ length: 2 }, (_, i) => o.agent(`p${i}`).catch(() => null)),
    );
    expect(sink.events).toHaveLength(0); // emit 纯布尔即返（M5 同口径）
    expect(existsSync(join(base, "telemetry"))).toBe(false); // 零触盘
    rmSync(base, { recursive: true, force: true });
  });
  it("workflow flag 关=桥接不注入（kernel onTelemetry 缺位）→ 零事件（接缝㉑ 语义面；生产装配位=未接线 F 项）", async () => {
    const sink = memorySink();
    const facade = createTelemetryFacade({ env: { [TELEMETRY_ENV_KEY]: "1" }, sink });
    const o = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("ok"),
      concurrencyCapacityOverride: 1000,
      maxAgents: 1,
      // flag 关=不注入 bridge（生产装配位义务；当前无 runner 生产构造点=未接线 F 项登记）
    });
    await Promise.all(
      Array.from({ length: 2 }, (_, i) => o.agent(`p${i}`).catch(() => null)),
    );
    expect(sink.events).toHaveLength(0);
    expect(facade.isEnabled()).toBe(true); // 对照：门开但无注入=仍零事件（缺位≠桥接转发）
  });
  it("非回放路径不误发：空 resume 状态真派生 → 零 journal hit 事件", async () => {
    const { sink, bridge } = wiredFacade();
    const orchestration = createWorkflowOrchestrator({
      model: "m",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      provider: makeFakeProvider("ok"),
    });
    const journaled = withWorkflowJournal(orchestration, {
      resume: parseWorkflowJournal(""),
      keyDerivation: () => "K",
      onTelemetry: bridge,
    });
    const result = await journaled.hooks.agent("any");
    expect(result).toBe("ok"); // 真派生
    expect(sink.events.filter((e) => e.event === "sc_workflow_journal_started_hit_respawn")).toHaveLength(0);
  });
});
