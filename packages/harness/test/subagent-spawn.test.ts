// WP-03（M3）subagent spawn 校验序列+执行器测试（v2.8 §6 ORC-022；判据自足：板 WP-03 DoD①-④ 逐条）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { createPermissionBroker } from "../src/permission-broker/index.ts";
import {
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_ANTI_FABRICATION,
  runSubagent,
  validateSpawn,
  type SubagentDefinition,
} from "../src/subagent.ts";
import type { Tool } from "../src/types.ts";

const CTX_BASE = {
  depth: 0,
  concurrentSubagents: 0,
  availableTypes: ["general-purpose", "Explore"],
};

// fake provider：单轮文本完成（执行器跑通面）
function textProvider(text: string, usage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 }): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", id: "m", model: "m" } as LLMEvent;
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

const TOOLS: Tool[] = [
  { name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" },
  { name: "Bash", description: "d", inputSchema: {}, execute: async () => "ok" },
];

const DEFS: Record<string, SubagentDefinition> = {
  "general-purpose": { name: "general-purpose", description: "all tools" },
  Explore: { name: "Explore", description: "read-only", tools: ["Read"], permissionMode: "plan" },
};

describe("DoD① 校验序列逐段（顺序+各自拒绝语义）", () => {
  it("深度>3 拒：depth>=3 → depth_limit，拒绝于序列首位", async () => {
    const r = await validateSpawn(
      { prompt: "p", description: "d" },
      { ...CTX_BASE, depth: 3 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("depth_limit");
      expect(r.trace).toEqual(["depth"]);
      expect(r.message).toContain("Subagent nesting limit reached (depth 3 of 3)");
      expect(r.message).toContain("STANDARD_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    }
  });

  it("并发 20 槽满拒：concurrentSubagents>=20 → concurrency_limit，且排在深度/归一化之后", async () => {
    const r = await validateSpawn(
      { prompt: "p", description: "d" },
      { ...CTX_BASE, concurrentSubagents: MAX_CONCURRENT_SUBAGENTS },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("concurrency_limit");
      expect(r.trace).toEqual(["depth", "description", "permission", "budget", "concurrency"]);
      expect(r.message).toContain("Concurrent subagent limit reached");
      expect(r.message).toContain("STANDARD_CODE_MAX_CONCURRENT_SUBAGENTS");
    }
  });

  it("类型未解析拒：未知类型 → type_not_found；歧义 → type_ambiguous；缺省无 general-purpose → type_missing", async () => {
    const notFound = await validateSpawn({ prompt: "p", subagentType: "Nope", description: "d" }, CTX_BASE);
    expect(notFound).toMatchObject({ ok: false, code: "type_not_found" });
    if (!notFound.ok) expect(notFound.message).toContain("Available types: general-purpose, Explore");

    const ambiguous = await validateSpawn(
      { prompt: "p", subagentType: "explore", description: "d" },
      { ...CTX_BASE, availableTypes: ["general-purpose", "Explore", "explore"] },
    );
    expect(ambiguous).toMatchObject({ ok: false, code: "type_ambiguous" });

    const missing = await validateSpawn({ prompt: "p", description: "d" }, { ...CTX_BASE, availableTypes: ["Explore"] });
    expect(missing).toMatchObject({ ok: false, code: "type_missing" });
  });

  it("顺序全链：成功归一化 trace=九段全序；description 归一化与大小写不敏感解析生效", async () => {
    const r = await validateSpawn(
      { prompt: "p", subagentType: "explore", description: "  read   the\n\ttree  ", isolation: "worktree" },
      { ...CTX_BASE, definitionsOf: (n) => DEFS[n] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trace).toEqual(["depth", "description", "permission", "budget", "concurrency", "type", "requiredMcp", "isolation", "background"]);
      expect(r.normalized.description).toBe("read the tree");
      expect(r.normalized.agentType).toBe("Explore");
      expect(r.normalized.isolation).toBe("worktree");
      expect(r.normalized.background).toBe(true); // 后台为默认（ORC-022）
    }
  });

  it("其余拒绝语义：Agent deny 规则/预算耗尽/显式同步/remote 拒绝/requiredMCP 超时", async () => {
    const denied = await validateSpawn(
      { prompt: "p", subagentType: "Explore", description: "d" },
      { ...CTX_BASE, deniedAgentTypes: ["Explore"] },
    );
    expect(denied).toMatchObject({ ok: false, code: "agent_denied" });
    if (!denied.ok) expect(denied.message).toContain("denied by permission rule 'Agent(Explore)'");

    const budget = await validateSpawn(
      { prompt: "p", description: "d" },
      { ...CTX_BASE, budget: { spentUsd: 5, maxBudgetUsd: 5 } },
    );
    expect(budget).toMatchObject({ ok: false, code: "budget_exhausted" });

    const sync = await validateSpawn({ prompt: "p", description: "d" }, { ...CTX_BASE, backgroundDisabled: false });
    if (sync.ok) {
      const syncExplicit = await validateSpawn({ prompt: "p", description: "d", runInBackground: false }, { ...CTX_BASE });
      expect(syncExplicit.ok && syncExplicit.normalized.background).toBe(false);
      // 定义 background=true 胜过显式 false（CC §4.1 step10 公式）
      const defWins = await validateSpawn(
        { prompt: "p", description: "d", runInBackground: false },
        { ...CTX_BASE, definitionsOf: () => ({ name: "general-purpose", description: "d", background: true }) },
      );
      expect(defWins.ok && defWins.normalized.background).toBe(true);
      // backgroundDisabled 否决一切
      const disabled = await validateSpawn({ prompt: "p", description: "d" }, { ...CTX_BASE, backgroundDisabled: true });
      expect(disabled.ok && disabled.normalized.background).toBe(false);
    }

    const remote = await validateSpawn({ prompt: "p", description: "d", isolation: "remote" }, CTX_BASE);
    expect(remote).toMatchObject({ ok: false, code: "remote_unsupported" });

    // requiredMCP 钩子：M4 前缺省恒跳过（无钩子 trace 仍含 requiredMcp 段）；提供且恒 pending → 30s 超时拒绝
    let polls = 0;
    const mcp = await validateSpawn(
      { prompt: "p", description: "d" },
      {
        ...CTX_BASE,
        pendingRequiredMcp: () => ["ctx"],
        sleep: async () => {
          polls++;
        },
        now: () => polls * 31_000, // 首查即超 deadline
      },
    );
    expect(mcp).toMatchObject({ ok: false, code: "mcp_required_missing" });
  });
});

describe("DoD②/③ 执行器：独立上下文+摘要回传+<subagent_tokens>", () => {
  it("独立上下文：发往 provider 的 messages 仅含本次 prompt（不携带父会话消息）", async () => {
    let captured: any;
    const p = textProvider("done");
    p.stream = async function* (req) {
      // 快照拷贝（loop 收尾会向同一数组推 assistant 轮，引用捕获会被污染）
      captured = JSON.parse(JSON.stringify(req.messages));
      yield { type: "text_delta", text: "done" } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    };
    const v = await validateSpawn({ prompt: "child task", description: "d" }, CTX_BASE);
    if (!v.ok) throw new Error("unreachable");
    const r = await runSubagent(v.normalized, { provider: p, model: "m", tools: TOOLS });
    expect(captured).toEqual([{ role: "user", content: [{ type: "text", text: "child task" }] }]);
    expect(r.status).toBe("completed");
  });

  it("结果摘要回传+<subagent_tokens> 标注+防伪造常量进提示词（DoD③）", async () => {
    let capturedSystem: string | undefined;
    const p = textProvider("");
    p.stream = async function* (req) {
      capturedSystem = req.system;
      yield { type: "text_delta", text: "child answer" } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    };
    const v = await validateSpawn({ prompt: "t", description: "d" }, { ...CTX_BASE, definitionsOf: (n) => DEFS[n] });
    if (!v.ok) throw new Error("unreachable");
    const r = await runSubagent(v.normalized, { provider: p, model: "m", tools: TOOLS, newAgentId: () => "subagent-42" });
    // 摘要=最后一条 assistant text（Gxt 同构）
    expect(r.content).toBe("child answer");
    // <subagent_tokens> 标注：跨轮累计 totalTokens=100+20+1+2=123（CC totalTokens 口径）
    expect(r.report).toContain("child answer");
    expect(r.report).toContain("<subagent_tokens>subagent_tokens: 123, tool_uses: 0, duration_ms:");
    expect(r.agentId).toBe("subagent-42");
    // 防伪造条目（ORC-041）进 subagent 系统提示词
    expect(capturedSystem).toContain(SUBAGENT_ANTI_FABRICATION);
  });

  it("zero-tool 拒绝：白名单解析为空 → refusing（CC §6.2 step3 同构）", async () => {
    const v = await validateSpawn(
      { prompt: "t", subagentType: "Explore", description: "d" },
      { ...CTX_BASE, availableTypes: ["Explore"], definitionsOf: () => ({ name: "Explore", description: "d", tools: ["Grep"] }) },
    );
    if (!v.ok) throw new Error("unreachable");
    await expect(runSubagent(v.normalized, { provider: textProvider("x"), model: "m", tools: TOOLS })).rejects.toThrow(
      /would be spawned with zero tools/,
    );
  });

  it("空输出兜底：(Subagent completed but returned no output.)", async () => {
    const p = textProvider("");
    const v = await validateSpawn({ prompt: "t", description: "d" }, CTX_BASE);
    if (!v.ok) throw new Error("unreachable");
    const r = await runSubagent(v.normalized, { provider: p, model: "m", tools: TOOLS });
    expect(r.content).toBe("(Subagent completed but returned no output.)");
  });
});

describe("DoD④ 权限规则继承：父 broker+agent 定义覆盖", () => {
  const broker = () =>
    createPermissionBroker({
      mode: "default",
      rules: { deny: ["Bash(rm -rf*)"], ask: [], allow: [] },
    });

  it("agent 定义 permissionMode 覆盖模式：子 agent acceptEdits 放行 Write，父模式不变；deny 规则共享恒赢", async () => {
    const parent = broker();
    const def: SubagentDefinition = { name: "writer", description: "d", permissionMode: "acceptEdits" };
    const v = await validateSpawn(
      { prompt: "t", subagentType: "writer", description: "d" },
      { ...CTX_BASE, availableTypes: ["writer"], definitionsOf: () => def },
    );
    if (!v.ok) throw new Error("unreachable");

    const p = textProvider("ok");
    const r = await runSubagent(v.normalized, { provider: p, model: "m", tools: TOOLS, permissionBroker: parent });

    // 结果面正常
    expect(r.content).toBe("ok");
    // 覆盖生效：派生 broker 上 Write 在 acceptEdits 下放行（父 default 会 ask）
    const derived = parent.derive("acceptEdits");
    expect(derived.evaluate("Write", {}).decision).toBe("allow");
    // 规则共享：deny 规则在派生面恒赢（B-13）
    expect(derived.evaluate("Bash", { command: "rm -rf /" }).decision).toBe("deny");
    // 父模式未被覆盖影响
    expect(parent.mode()).toBe("default");
    expect(parent.evaluate("Write", {}).decision).toBe("ask");
  });

  it("无 permissionMode 的 agent 定义：继承父 broker 原模式与规则", async () => {
    const parent = createPermissionBroker({ mode: "plan", rules: { deny: ["Bash(rm -rf*)"], ask: [], allow: [] } });
    const v = await validateSpawn({ prompt: "t", description: "d" }, CTX_BASE);
    if (!v.ok) throw new Error("unreachable");
    await runSubagent(v.normalized, { provider: textProvider("ok"), model: "m", tools: TOOLS, permissionBroker: parent });
    // plan 模式继承：mutating Bash 被 plan 硬门 deny（deny 规则同源）
    expect(parent.evaluate("Bash", { command: "rm -rf /" }).decision).toBe("deny");
    expect(parent.evaluate("Read", {}).decision).toBe("allow");
  });
});
