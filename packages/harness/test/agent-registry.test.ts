// WP-06（M3）内置 agent 集+注册表发现链测试（v2.8 §6 ORC-022；判据自足：板 WP-06 DoD①-④ 逐条）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import {
  AGENT_SOURCE_ORDER,
  BUILT_IN_AGENTS,
  MEDIUM_CAP_MODEL,
  READ_ONLY_TOOLS,
  createAgentRegistry,
  resolveInheritCap,
} from "../src/agent-registry.ts";
import { SUBAGENT_ANTI_FABRICATION, validateSpawn, runSubagent, type SubagentDefinition } from "../src/subagent.ts";
import type { Tool } from "../src/types.ts";

function parentCtx() {
  return { depth: 0, concurrentSubagents: 0, availableTypes: ["general-purpose", "Explore", "Plan", "statusline-setup"] };
}

describe("DoD① 四内置定义齐且 general-purpose 全工具/Explore+Plan 只读", () => {
  it("内置集恰四件且名字对", () => {
    expect(BUILT_IN_AGENTS.map((a) => a.name)).toEqual(["general-purpose", "Explore", "Plan", "statusline-setup"]);
    expect(BUILT_IN_AGENTS.every((a) => a.source === "built-in")).toBe(true);
  });

  it("general-purpose 全工具（tools 缺省）；Explore/Plan 只读白名单；statusline-setup 定义壳", () => {
    const gp = BUILT_IN_AGENTS.find((a) => a.name === "general-purpose")!;
    expect(gp.tools).toBeUndefined(); // 缺省=继承父全工具
    const explore = BUILT_IN_AGENTS.find((a) => a.name === "Explore")!;
    const plan = BUILT_IN_AGENTS.find((a) => a.name === "Plan")!;
    expect(explore.tools).toEqual([...READ_ONLY_TOOLS]);
    expect(plan.tools).toEqual([...READ_ONLY_TOOLS]);
    // 只读断言：白名单无写类工具
    for (const w of ["Write", "Edit", "Bash"]) {
      expect(explore.tools).not.toContain(w);
      expect(plan.tools).not.toContain(w);
    }
    expect(explore.model).toBe("inherit");
    expect(explore.inheritCap).toBe(true);
    const status = BUILT_IN_AGENTS.find((a) => a.name === "statusline-setup")!;
    expect(status.tools).toEqual(["Read", "Edit"]); // 定义壳（渲染消费 M5+）
  });

  it("注册表默认即含四内置；disableBuiltins 整体禁用（wOe none 同构）", () => {
    expect(createAgentRegistry().names().sort()).toEqual(["Explore", "Plan", "general-purpose", "statusline-setup"]);
    expect(createAgentRegistry({ disableBuiltins: true }).names()).toEqual([]);
  });
});

describe("DoD② Explore/Plan omitClaudeMd+不注入 gitStatus 断言（装配消费面）", () => {
  it("内置定义位：Explore/Plan 置真、general-purpose 置假（缺省）", () => {
    const explore = BUILT_IN_AGENTS.find((a) => a.name === "Explore")!;
    const plan = BUILT_IN_AGENTS.find((a) => a.name === "Plan")!;
    const gp = BUILT_IN_AGENTS.find((a) => a.name === "general-purpose")!;
    expect(explore.omitClaudeMd).toBe(true);
    expect(explore.omitGitStatus).toBe(true);
    expect(plan.omitClaudeMd).toBe(true);
    expect(gp.omitClaudeMd).toBeUndefined();
    expect(gp.omitGitStatus).toBeUndefined();
  });

  // 用可捕获 system 的 provider 走 runSubagent 验证装配（provider.stream 收 LLMRequest.system）
  function captureProvider(text = "ok"): { provider: ProviderAdapter; systems: (string | undefined)[] } {
    const systems: (string | undefined)[] = [];
    const provider: ProviderAdapter = {
      capabilities: () => {
        throw new Error("not used");
      },
      countTokens: async () => 0,
      async *stream(req): AsyncGenerator<LLMEvent> {
        systems.push(req.system);
        yield { type: "text_delta", text } as LLMEvent;
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      },
    };
    return { provider, systems };
  }

  const TOOLS: Tool[] = [
    { name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" },
    { name: "Write", description: "d", inputSchema: {}, execute: async () => "ok" },
  ];
  const parentContext = { memory: "# PROJECT MEMORY\nsecret project facts", gitStatus: "On branch main\n M foo.ts" };

  async function systemFor(def: SubagentDefinition): Promise<string | undefined> {
    const { provider, systems } = captureProvider();
    const v = await validateSpawn(
      { prompt: "p", subagentType: def.name, description: "d" },
      { ...parentCtx(), definitionsOf: (n) => (n === def.name ? def : undefined) },
    );
    if (!v.ok) throw new Error("unreachable");
    await runSubagent(v.normalized, { provider, model: "m", tools: TOOLS, parentContext });
    return systems[0];
  }

  it("general-purpose：记忆段与 gitStatus 段均入 system（+防伪造常量）", async () => {
    const gp = BUILT_IN_AGENTS.find((a) => a.name === "general-purpose")!;
    const sys = (await systemFor(gp)) ?? "";
    expect(sys).toContain("PROJECT MEMORY");
    expect(sys).toContain("On branch main");
    expect(sys).toContain(SUBAGENT_ANTI_FABRICATION);
  });

  it("Explore/Plan：omitClaudeMd+omitGitStatus → 两段均省略，防伪造常量仍在", async () => {
    for (const name of ["Explore", "Plan"]) {
      const def = BUILT_IN_AGENTS.find((a) => a.name === name)!;
      const sys = (await systemFor(def)) ?? "";
      expect(sys).not.toContain("PROJECT MEMORY");
      expect(sys).not.toContain("On branch main");
      expect(sys).toContain(SUBAGENT_ANTI_FABRICATION); // 防伪造不受 omit 影响
      expect(sys.startsWith(def.systemPrompt!)).toBe(true); // 定义自身提示词在位（omit 只裁父上下文段）
    }
  });
});

describe("DoD③ 优先级链六层逐层覆盖（policy 最上/built-in 兜底）", () => {
  it("AGENT_SOURCE_ORDER 低→高=内置兜底、policy 最上", () => {
    expect(AGENT_SOURCE_ORDER).toEqual(["built-in", "plugin", "user", "project", "flag", "policy"]);
  });

  it("同名定义六层逐层入注，最终胜者=最高来源；逐层覆盖语义", () => {
    const mk = (src: string): SubagentDefinition => ({ name: "shared", description: `from ${src}` });
    // 只给 built-in 之外的五层（内置占位用同名覆盖测试）
    const reg = createAgentRegistry({
      sources: {
        plugin: [mk("plugin")],
        user: [mk("user")],
        project: [mk("project")],
        flag: [mk("flag")],
        policy: [mk("policy")],
      },
    });
    expect(reg.get("shared")!.description).toBe("from policy"); // policy 最上
    // 逐层：去掉更高来源，胜者下移
    expect(
      createAgentRegistry({ sources: { plugin: [mk("plugin")], user: [mk("user")], project: [mk("project")], flag: [mk("flag")] } }).get("shared")!.description,
    ).toBe("from flag");
    expect(
      createAgentRegistry({ sources: { plugin: [mk("plugin")], user: [mk("user")], project: [mk("project")] } }).get("shared")!.description,
    ).toBe("from project");
    expect(createAgentRegistry({ sources: { plugin: [mk("plugin")], user: [mk("user")] } }).get("shared")!.description).toBe("from user");
    expect(createAgentRegistry({ sources: { plugin: [mk("plugin")] } }).get("shared")!.description).toBe("from plugin");
    // 内置兜底：无高来源覆盖时 Explore 保留内置描述
    expect(createAgentRegistry().get("Explore")!.source).toBe("built-in");
  });

  it("内置可被高来源覆盖（如 policy 重定义 Explore）", () => {
    const reg = createAgentRegistry({ sources: { policy: [{ name: "Explore", description: "policy override", tools: [] }] } });
    expect(reg.get("Explore")!.description).toBe("policy override");
    expect(reg.get("Explore")!.source).toBe("policy");
  });
});

describe("DoD④ 同名去重高来源胜", () => {
  it("同层多同名 Map 后写覆盖；跨层高来源胜；onDuplicate 告警逐次触发", () => {
    const dups: Array<{ name: string; winner: string; loser: string }> = [];
    const reg = createAgentRegistry({
      sources: {
        user: [
          { name: "dup", description: "user-a" },
          { name: "dup", description: "user-b" },
        ],
        policy: [{ name: "dup", description: "policy-1" }],
      },
      onDuplicate: (name, winner, loser) => dups.push({ name, winner: winner.description, loser: loser.description }),
    });
    expect(reg.get("dup")!.description).toBe("policy-1"); // 高来源胜
    expect(reg.list().filter((d) => d.name === "dup")).toHaveLength(1); // 去重
    // 告警：user-b 覆盖 user-a + policy-1 覆盖 user-b（两次）
    expect(dups).toEqual([
      { name: "dup", winner: "user-b", loser: "user-a" },
      { name: "dup", winner: "policy-1", loser: "user-b" },
    ]);
  });

  it("大小写不敏感解析（同名归一，不同源）", () => {
    const reg = createAgentRegistry({ sources: { user: [{ name: "myAgent", description: "d" }] } });
    expect(reg.get("MYAGENT")!.name).toBe("myAgent");
    expect(reg.get("myagent")).toBeDefined();
  });
});

describe("DoD① 附：非最新模型压中档 env 同构位（iP/关断面，纯函数）", () => {
  it("model:inherit+inheritCap 且父非最新→压 MEDIUM_CAP_MODEL；env 置值关断→保持 inherit", () => {
    const explore = BUILT_IN_AGENTS.find((a) => a.name === "Explore")!;
    expect(resolveInheritCap(explore, { sessionModelIsLatest: false }).model).toBe(MEDIUM_CAP_MODEL);
    expect(resolveInheritCap(explore, { sessionModelIsLatest: false }).capped).toBe(true);
    expect(resolveInheritCap(explore, { sessionModelIsLatest: false, disableCapEnv: "1" }).capped).toBe(false);
    expect(resolveInheritCap(explore, { sessionModelIsLatest: false, disableCapEnv: "" }).capped).toBe(true); // V 复验 P5：空串 truthy 判定=不关断（CC 同构）
    expect(resolveInheritCap(explore, { sessionModelIsLatest: true }).model).toBe("inherit");
    // 非 inherit 模型不受 cap 影响
    const status = BUILT_IN_AGENTS.find((a) => a.name === "statusline-setup")!;
    expect(resolveInheritCap(status, { sessionModelIsLatest: false })).toEqual({ model: status.model, capped: false });
  });
});
