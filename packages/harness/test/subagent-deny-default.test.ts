// M8-WP-03 判据（DoD②）：deny 规则覆盖**缺省类型**——校验段③按生效类型（省略→general-purpose）判定。
// 判据自足：ADR-0052 决策 1-4 逐条；显式类型既有语义零改（同族既有用例在 subagent-spawn.test.ts 零改动复跑）。
import { describe, expect, it } from "vitest";
import { validateSpawn, type SpawnValidationContext } from "../src/subagent.ts";

const CTX_BASE: Omit<SpawnValidationContext, "concurrentSubagents"> = {
  depth: 0,
  availableTypes: ["general-purpose", "Explore"],
};

const spawn = (input: { prompt: string; description: string; subagentType?: string }, ctx: Partial<SpawnValidationContext>) =>
  validateSpawn(
    { ...input, ...(input.subagentType !== undefined ? { subagentType: input.subagentType } : {}) },
    { ...CTX_BASE, concurrentSubagents: 0, ...ctx },
  );

describe("M8-WP-03 DoD② 缺省类型×deny（生效类型判定）", () => {
  it("类型省略（生效 general-purpose）＋deny Agent(general-purpose) → agent_denied，消息带 (default) 标注", async () => {
    const r = await spawn({ prompt: "p", description: "d" }, { deniedAgentTypes: ["general-purpose"] });
    expect(r).toMatchObject({ ok: false, code: "agent_denied" });
    if (!r.ok) {
      expect(r.message).toContain("Agent type 'general-purpose' (default) has been denied");
      expect(r.message).toContain("permission rule 'Agent(general-purpose)'");
      expect(r.trace.at(-1)).toBe("permission"); // 段③拒绝（序不变）
    }
  });

  it("大小写不敏感：deny Agent(General-Purpose) 同样拒缺省派发", async () => {
    const r = await spawn({ prompt: "p", description: "d" }, { deniedAgentTypes: ["General-Purpose"] });
    expect(r).toMatchObject({ ok: false, code: "agent_denied" });
  });

  it("阳性对照（判别力）：deny 其它类型（Explore）不影响缺省派发 → ok", async () => {
    const r = await spawn({ prompt: "p", description: "d" }, { deniedAgentTypes: ["Explore"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.agentType).toBe("general-purpose");
  });

  it("显式类型既有语义零改：deny 该类型 → agent_denied，消息逐字为旧形（无 (default) 标注）", async () => {
    const r = await spawn({ prompt: "p", description: "d", subagentType: "Explore" }, { deniedAgentTypes: ["Explore"] });
    expect(r).toMatchObject({ ok: false, code: "agent_denied" });
    if (!r.ok) {
      expect(r.message).toContain("Agent type 'Explore' has been denied by permission rule 'Agent(Explore)'");
      expect(r.message).not.toContain("(default)");
    }
  });

  it("生效类型为显式值时不被缺省类型 deny 波及：deny Agent(general-purpose)＋显式 Explore → ok", async () => {
    const r = await spawn({ prompt: "p", description: "d", subagentType: "Explore" }, { deniedAgentTypes: ["general-purpose"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.agentType).toBe("Explore");
  });

  it("边界形登记（ADR-0052 兼容判定）：缺省＋deny 命中且注册表无 general-purpose → 更早拒为 agent_denied（非 type_missing）", async () => {
    const r = await validateSpawn(
      { prompt: "p", description: "d" },
      { ...CTX_BASE, concurrentSubagents: 0, availableTypes: ["Explore"], deniedAgentTypes: ["general-purpose"] },
    );
    expect(r).toMatchObject({ ok: false, code: "agent_denied" });
    if (!r.ok) expect(r.trace.at(-1)).toBe("permission");
  });

  it("无 deny 供给＝行为不变（缺省→general-purpose ok；回归对照）", async () => {
    const r = await spawn({ prompt: "p", description: "d" }, {});
    expect(r.ok).toBe(true);
  });
});
