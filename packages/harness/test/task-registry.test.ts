// WP-04（M3）任务注册表+后台默认+120s 翻转测试（v2.8 §6 ORC-040~042；判据自足：板 WP-04 DoD①-④ 逐条）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { createTaskRegistry, type TaskRegistry } from "../src/task-registry.ts";
import { parseAutoBackgroundMs, spawnSubagentTask } from "../src/subagent-tasks.ts";
import type { Tool } from "../src/types.ts";

const TOOLS: Tool[] = [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }];
const CTX = { depth: 0, availableTypes: ["general-purpose"] };
const SPAWN = { prompt: "p", description: "d" };
const RUN = { provider: {} as ProviderAdapter, model: "m", tools: TOOLS };

/** 门控 provider：stream 在 gate 打开前挂起（后台/翻转面用）。 */
function gatedProvider(): { provider: ProviderAdapter; open: (text?: string) => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const provider: ProviderAdapter = {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      await gate;
      yield { type: "text_delta", text: "done" } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
  return { provider, open: () => open() };
}

function instantProvider(text = "done"): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function completedOnce(reg: TaskRegistry): Promise<{ taskId: string }> {
  return new Promise((res) => reg.once("completed", (taskId) => res({ taskId })));
}

describe("DoD① takeConcurrencySlot 幂等释放（重复释放不二次计数）", () => {
  it("take 幂等、release 幂等，计数由持槽任务派生", () => {
    const reg = createTaskRegistry({});
    const t = reg.register({ agentId: "a1", agentType: "general-purpose", description: "d", isBackgrounded: true });
    expect(reg.getConcurrentSubagents()).toBe(0);
    expect(reg.takeConcurrencySlot(t.taskId)).toBe(true);
    expect(reg.takeConcurrencySlot(t.taskId)).toBe(true); // 幂等 take：不重复计数
    expect(reg.getConcurrentSubagents()).toBe(1);
    reg.releaseConcurrencySlot(t.taskId);
    reg.releaseConcurrencySlot(t.taskId); // 重复释放
    expect(reg.getConcurrentSubagents()).toBe(0); // 不二次计数
    // 终态后槽标志随 settle 释放，重复 complete 不复活
    const t2 = reg.register({ agentId: "a2", agentType: "general-purpose", description: "d", isBackgrounded: true });
    reg.takeConcurrencySlot(t2.taskId);
    reg.complete(t2.taskId, { content: "c", totalTokens: 0, totalToolUseCount: 0, totalDurationMs: 0, doneReason: "end" });
    reg.releaseConcurrencySlot(t2.taskId);
    expect(reg.getConcurrentSubagents()).toBe(0);
  });
});

describe("DoD② evictAfter 30s", () => {
  it("默认 30s 调度（注入调度器断言延迟值），触发后任务逐出+evicted 事件", () => {
    const captured: Array<{ fn: () => void; ms: number }> = [];
    const reg = createTaskRegistry({ scheduleEvict: (fn, ms) => captured.push({ fn, ms }) });
    const evicted: string[] = [];
    reg.on("evicted", (id) => evicted.push(id));
    const t = reg.register({ agentId: "a1", agentType: "g", description: "d", isBackgrounded: true });
    reg.takeConcurrencySlot(t.taskId);
    reg.complete(t.taskId, { content: "c", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(30_000); // ORC-040 evictAfter 30s 默认
    expect(reg.get(t.taskId)?.status).toBe("completed"); // 逐出前仍可查
    captured[0]!.fn();
    expect(reg.get(t.taskId)).toBeUndefined();
    expect(evicted).toEqual([t.taskId]);
  });

  it("真实定时路径：evictAfterMs=15 → 逐出后 get 为空", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 15 });
    const t = reg.register({ agentId: "a1", agentType: "g", description: "d", isBackgrounded: true });
    reg.complete(t.taskId, { content: "c", totalTokens: 0, totalToolUseCount: 0, totalDurationMs: 0, doneReason: "end" });
    await sleep(50);
    expect(reg.get(t.taskId)).toBeUndefined();
  });

  it("running 态不逐出：仅终态任务进入 evict 链", () => {
    const captured: Array<{ fn: () => void; ms: number }> = [];
    const reg = createTaskRegistry({ scheduleEvict: (fn, ms) => captured.push({ fn, ms }) });
    const t = reg.register({ agentId: "a1", agentType: "g", description: "d", isBackgrounded: true });
    reg.takeConcurrencySlot(t.taskId);
    expect(captured).toHaveLength(0);
    reg.releaseConcurrencySlot(t.taskId);
    expect(captured).toHaveLength(0);
  });
});

describe("DoD③ 后台默认+同步 120s 翻转（env 覆盖通道）", () => {
  it("parseAutoBackgroundMs：缺省 0/数字值 [自定]/非数字存在=120000（CC Mos 同构）", () => {
    expect(parseAutoBackgroundMs(undefined)).toBe(0);
    expect(parseAutoBackgroundMs("")).toBe(0);
    expect(parseAutoBackgroundMs("true")).toBe(120_000);
    expect(parseAutoBackgroundMs("abc")).toBe(120_000);
    expect(parseAutoBackgroundMs("30000")).toBe(30_000);
  });

  it("后台默认：runInBackground 未指定 → async_launched 即返，完成后注册表落账+槽释放", async () => {
    const reg = createTaskRegistry({});
    const g = gatedProvider();
    const done = completedOnce(reg);
    const launch = await spawnSubagentTask(SPAWN, CTX, { ...RUN, provider: g.provider }, { registry: reg, env: {} });
    expect(launch.status).toBe("async_launched");
    if (launch.status !== "async_launched") return;
    const t = reg.get(launch.taskId)!;
    expect(t.isBackgrounded).toBe(true);
    expect(reg.getConcurrentSubagents()).toBe(1);
    g.open();
    const { taskId } = await done;
    expect(taskId).toBe(launch.taskId);
    expect(reg.get(taskId)?.result?.content).toBe("done");
    expect(reg.getConcurrentSubagents()).toBe(0); // 终态释放
  });

  it("同步 120s 翻转：env STANDARD_CODE_AUTO_BACKGROUND_TASKS=30 → 30ms 后 backgrounded，翻转后完成仍落账", async () => {
    const reg = createTaskRegistry({});
    const g = gatedProvider();
    const done = completedOnce(reg);
    const launch = await spawnSubagentTask(
      { ...SPAWN, runInBackground: false },
      CTX,
      { ...RUN, provider: g.provider },
      { registry: reg, env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "30" } },
    );
    expect(launch.status).toBe("backgrounded"); // 30ms 翻转先于门控完成
    if (launch.status !== "backgrounded") return;
    expect(reg.get(launch.taskId)?.isBackgrounded).toBe(true); // CC §4.2 转后台置位
    expect(reg.getConcurrentSubagents()).toBe(1); // 翻转不释放槽
    g.open();
    const { taskId } = await done;
    expect(taskId).toBe(launch.taskId);
    expect(reg.getConcurrentSubagents()).toBe(0);
  });

  it("同步无翻转：env 缺省（0）→ 同步跑完返回 completed 结果", async () => {
    const reg = createTaskRegistry({});
    const launch = await spawnSubagentTask(
      { ...SPAWN, runInBackground: false },
      CTX,
      { ...RUN, provider: instantProvider() },
      { registry: reg, env: {} },
    );
    expect(launch.status).toBe("completed");
    if (launch.status !== "completed") return;
    expect(launch.result.content).toBe("done");
    expect(reg.get(launch.taskId)?.status).toBe("completed");
    expect(reg.getConcurrentSubagents()).toBe(0);
  });
});

describe("DoD④ 并发 20 槽与注册表一致性", () => {
  it("20 槽满→第 21 个 refused concurrency_limit（校验取注册表实况）→放一→再入槽→计数全程一致", async () => {
    const reg = createTaskRegistry({ maxConcurrent: 20 });
    const gates = Array.from({ length: 20 }, () => gatedProvider());
    const dones = gates.map(() => completedOnce(reg));
    for (const g of gates) {
      const launch = await spawnSubagentTask(SPAWN, CTX, { ...RUN, provider: g.provider }, { registry: reg, env: {} });
      expect(launch.status).toBe("async_launched");
    }
    expect(reg.getConcurrentSubagents()).toBe(20);
    // 第 21 个：validateSpawn ⑤ 以注册表实况计数拒绝
    const g21 = gatedProvider();
    const refused = await spawnSubagentTask(SPAWN, CTX, { ...RUN, provider: g21.provider }, { registry: reg, env: {} });
    expect(refused.status).toBe("refused");
    if (refused.status === "refused") expect(refused.code).toBe("concurrency_limit");
    expect(reg.getConcurrentSubagents()).toBe(20); // 拒绝无残留
    // 放一个 → 计数 19 → 新任务入槽回到 20
    gates[0]!.open();
    await dones[0];
    expect(reg.getConcurrentSubagents()).toBe(19);
    const again = await spawnSubagentTask(SPAWN, CTX, { ...RUN, provider: g21.provider }, { registry: reg, env: {} });
    expect(again.status).toBe("async_launched");
    expect(reg.getConcurrentSubagents()).toBe(20);
    // 收尾：全开（含 again 的门控），等待全部终态落账；计数归零、无活跃任务
    const againDone = again.status === "async_launched" ? completedOnce(reg) : null;
    g21.open();
    gates.slice(1).forEach((g) => g.open());
    await Promise.all(dones.slice(1));
    if (againDone) await againDone;
    await sleep(20);
    expect(reg.getConcurrentSubagents()).toBe(0);
    expect(reg.list({ activeOnly: true })).toHaveLength(0);
  });
});
