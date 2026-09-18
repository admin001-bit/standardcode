// WP-07（M6）团队/成员注册表与通讯录单测。判据自足（板 WP-07 DoD①②④）：
//   ①team_name 创建与校验规则落地（空/非法字符拒绝）
//   ②"main" 保留名不可占用；成员名去重；spawn 名字冲突保护（各一例）
//   ④通讯录：to 可寻址集含成员名与 agentId；"main" 恒路由主对话；agentId 内部 ID 不向用户暴露（L179075 逐字）
// 锚点：A 级 claude-code-agent-teams.md §3.1（L176871-176879）/§3.2（L176949-176960）/§3.3（L176953、L177717）/§9（L179075）。
import { describe, expect, it, vi } from "vitest";
import {
  SPAWN_NAME_RESERVED_ERROR,
  TEAM_LEAD_ADDRESS,
  TEAM_NAME_CONTROL_CHARS_ERROR,
  TEAM_NAME_EMPTY_ERROR,
  TEAM_NAME_RESERVED_ERROR,
  createRosterSendMessagePort,
  createTeamRoster,
  dedupeMemberName,
  generateAgentId,
  spawnNameGuard,
  spawnAddressingNote,
  validateTeamName,
} from "../src/index.ts";

describe("DoD① team_name 创建与校验（A 级 §3.1）", () => {
  it("控制字符拒绝（文案逐字同 §3.1 L176871）", () => {
    expect(validateTeamName("team\u0001x")).toBe(TEAM_NAME_CONTROL_CHARS_ERROR);
    expect(validateTeamName("a\nb")).toBe(TEAM_NAME_CONTROL_CHARS_ERROR);
    expect(validateTeamName("a\u007fb")).toBe(TEAM_NAME_CONTROL_CHARS_ERROR); // DEL
  });

  it("空名/非字符串拒绝（[自定]① fail-closed），合法名通过且 createTeamRoster 同规", () => {
    expect(validateTeamName("")).toBe(TEAM_NAME_EMPTY_ERROR);
    expect(validateTeamName(undefined)).toBe(TEAM_NAME_EMPTY_ERROR);
    expect(validateTeamName(42 as never)).toBe(TEAM_NAME_EMPTY_ERROR);
    expect(validateTeamName("design-team")).toBeNull();
    expect(() => createTeamRoster({ teamName: "" })).toThrow(TEAM_NAME_EMPTY_ERROR);
    expect(() => createTeamRoster({ teamName: "bad\u0002" })).toThrow(TEAM_NAME_CONTROL_CHARS_ERROR);
    expect(createTeamRoster({ teamName: "design-team" }).teamName).toBe("design-team");
  });
});

describe("DoD② 保留名与去重（A 级 §3.2 mlr）+ spawn 冲突保护（§3.3）", () => {
  it('"main" 为保留名不可占用（成员注册抛错，文案逐字 §3.2）', () => {
    const roster = createTeamRoster({ teamName: "t" });
    expect(() => roster.addMember("main")).toThrow(TEAM_NAME_RESERVED_ERROR);
    expect(roster.members()).toHaveLength(0); // 拒绝后零残留
  });

  it("成员名去重：重名自动 -2/-3 后缀（大小写不敏感，mlr while 循环算法同构）", () => {
    const roster = createTeamRoster({ teamName: "t" });
    const a1 = roster.addMember("alice");
    expect(a1).toMatchObject({ name: "alice", deduped: false });
    const a2 = roster.addMember("alice");
    expect(a2).toMatchObject({ name: "alice-2", deduped: true });
    const a3 = roster.addMember("ALICE"); // 大小写不敏感（mlr 逐字 toLowerCase 比较）；alice/alice-2 已占 → 跳到 -3
    expect(a3.name).toBe("ALICE-3");
    const a4 = roster.addMember("alice-2"); // 候选名 "alice-2" 撞 "alice-2-2" 检查位 → alice-2-2（while 从 o=2 起）
    expect(a4.name).toBe("alice-2-2");
    expect(roster.members().map((m) => m.name)).toEqual(["alice", "alice-2", "ALICE-3", "alice-2-2"]);
  });

  it("dedupeMemberName 纯函数与注册表行为一致", () => {
    const taken = new Set(["bob", "bob-2"]);
    expect(dedupeMemberName("bob", taken)).toEqual({ name: "bob-3", deduped: true });
    expect(dedupeMemberName("carol", taken)).toEqual({ name: "carol", deduped: false });
  });

  it("spawn 名字冲突保护：main 拒绝（文案逐字 §3.3 L176953），重名不拒绝（latest wins，[自定]③）", () => {
    expect(spawnNameGuard("main")).toBe(SPAWN_NAME_RESERVED_ERROR);
    expect(spawnNameGuard("main")).toBe('"main" is reserved — SendMessage routes it to the main conversation');
    expect(spawnNameGuard("x\u0003")).toBe(TEAM_NAME_CONTROL_CHARS_ERROR);
    expect(spawnNameGuard("")).toBe(TEAM_NAME_EMPTY_ERROR);
    expect(spawnNameGuard("researcher")).toBeNull(); // 合法
    // 成员注册表里已有同名 teammate 时 spawn 该名仍放行（A 级 §2.2 "a newer agent took the name (latest wins)"）。
    const roster = createTeamRoster({ teamName: "t" });
    roster.addMember("dup");
    expect(spawnNameGuard("dup")).toBeNull();
  });
});

describe("DoD④ 通讯录（可寻址名单）与 agentId", () => {
  it("resolve：main 与 lead 别名恒路由主对话；成员名与 agentId 可寻址；未知落 unknown", () => {
    const roster = createTeamRoster({ teamName: "t" });
    const m = roster.addMember("researcher", { agentId: "a0123456789ab-cdef" });
    expect(roster.resolve("main")).toEqual({ kind: "main" });
    expect(roster.resolve(TEAM_LEAD_ADDRESS)).toEqual({ kind: "main" });
    expect(roster.resolve("researcher")).toEqual({ kind: "member", member: m });
    expect(roster.resolve("a0123456789ab-cdef")).toEqual({ kind: "member", member: m });
    expect(roster.resolve("nobody")).toEqual({ kind: "unknown" });
    expect(roster.byAgentId("a0123456789ab-cdef")).toBe(m);
  });

  it("addressable() 含 main、lead 别名、全部成员名与 agentId（顺序稳定）", () => {
    const roster = createTeamRoster({ teamName: "t" });
    const m = roster.addMember("researcher", { agentId: "a0123456789ab-cdef" });
    expect(roster.addressable()).toEqual(["main", TEAM_LEAD_ADDRESS, "researcher", "a0123456789ab-cdef"]);
    expect(roster.addressable()).toContain(m.agentId);
  });

  it("agentId 生成形 a<hex>-<hex>（[自定]②），且 spawn 提示文案逐字同 §9 L179075（agentId 不向用户暴露）", () => {
    const id = generateAgentId();
    expect(id).toMatch(/^a[0-9a-f]{12}-[0-9a-f]{4}$/);
    expect(id).not.toContain(" ");
    expect(spawnAddressingNote({ agentId: "a0123456789ab-cdef" })).toBe(
      "agentId: a0123456789ab-cdef (internal ID - do not mention to user. Use SendMessage with to: 'a0123456789ab-cdef', summary: '<5-10 word recap>' to continue this agent.)",
    );
  });
});

describe("通讯录 × SendMessagePort（WP-06 SendMessagePort 消费面；to:\"main\" 路由落点）", () => {
  it('to="main" 恒路由主对话（渲染文本进 deliverToMain），to=成员进 deliverToMember，未知→unreachable-namespace', async () => {
    const roster = createTeamRoster({ teamName: "t" });
    const m = roster.addMember("researcher", { agentId: "a0123456789ab-cdef" });
    const mains: string[] = [];
    const members: unknown[] = [];
    const port = createRosterSendMessagePort({
      roster,
      from: "team-lead",
      deliverToMain: (text) => mains.push(text),
      deliverToMember: (d) => members.push(d),
    });
    await expect(port.send({ to: "main", message: "status?" })).resolves.toBeNull();
    expect(mains).toEqual(["team-lead: status?"]); // j3({from,text}) 调用形（A 级 §4.1）——无 summary 前缀
    await expect(port.send({ to: "researcher", message: "hello", notifyWhenIdle: true } as never)).resolves.toBeNull();
    await expect(port.send({ to: "a0123456789ab-cdef", message: { type: "shutdown_request", reason: "done" } })).resolves.toBeNull();
    await expect(port.send({ to: "ghost", message: "x" })).resolves.toBe("unreachable-namespace"); // → not_reachable（WP-06 归一）
    expect(members).toHaveLength(2);
    const first = members[0] as { member: { agentId: string }; entry: { from: string; text: string; sentAt: string } };
    expect(first.member.agentId).toBe(m.agentId);
    expect(first.entry).toMatchObject({ from: "team-lead", text: "hello" });
    expect(first.entry.sentAt).toBeTruthy();
    const second = members[1] as { entry: { text: string; message: unknown } };
    expect(second.entry.text).toBe(JSON.stringify({ type: "shutdown_request", reason: "done" }));
    expect(second.entry.message).toEqual({ type: "shutdown_request", reason: "done" }); // 协议原物透传
    expect(port.addressable()).toEqual(roster.addressable());
  });

  it("纯文本消息不带 message 原物字段；渲染器可注入覆写", async () => {
    const roster = createTeamRoster({ teamName: "t" });
    roster.addMember("a", { agentId: "a0123456789ab-cdef" });
    const delivered: unknown[] = [];
    const port = createRosterSendMessagePort({
      roster,
      from: "lead",
      deliverToMain: vi.fn(),
      deliverToMember: (d) => delivered.push(d),
      format: (e) => `<${e.from}> ${e.text}`,
    });
    await port.send({ to: "a", message: "plain" });
    const entry = (delivered[0] as { entry: Record<string, unknown> }).entry;
    expect(entry.text).toBe("plain");
    expect(entry.message).toBeUndefined();
  });
});
