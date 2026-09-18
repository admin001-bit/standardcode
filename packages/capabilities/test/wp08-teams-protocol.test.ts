// WP-08（M6）Teams 协议消息与生命周期单测（DoD①-⑤ + two-mismatch 裁决 + 五事件封闭不变量 + 同源 DoD⑤ 断言）。
// 依据 A 级 `claude-code-agent-teams.md` §6.1-§6.4 / §7.1；证据 `_440.js` L37104/L210087/L56327-56331/L56485-56520/L175784/L176009-176018。
import { describe, expect, it, vi } from "vitest";
import {
  TEAMS_PROTOCOL_TYPES,
  buildShutdownRequest,
  buildShutdownResponse,
  buildPlanApprovalRequest,
  buildPlanApprovalResponse,
  parseProtocolMessage,
  createProtocolPairing,
  TEAMS_PROTOCOL_CONSEQUENCES,
  isTeamsProtocolType,
  SEND_MESSAGE_PROTOCOL_FIELDS,
  createTeammateRunner,
  TEAMMATE_MESSAGE_EVENTS,
  TEAMMATE_DEFAULT_LEAD_NAME,
  createTeamRoster,
  teammateInboxPath,
  restrictToolsForTeammate,
  TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
  TEAMS_PROTOCOL_USAGE_RULES,
  composeTeammateSystemPrompt,
  createTeammateMessagePump,
  type TeammateDelivery,
  type MailboxFs,
} from "../src/index.ts";

const FIXED_ID = "req-fixed-1";
const idGen = () => FIXED_ID;

function memFs(): MailboxFs & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`memFs ENOENT: ${p}`);
      return v;
    },
    writeFileSync: (p, d) => {
      store.set(p, d);
    },
    mkdirSync: () => {},
  };
}

describe("DoD① 四类协议类型常量", () => {
  it("恰为四型且为 request/response 对称", () => {
    expect([...TEAMS_PROTOCOL_TYPES]).toEqual([
      "shutdown_request",
      "shutdown_response",
      "plan_approval_request",
      "plan_approval_response",
    ]);
    expect(TEAMS_PROTOCOL_TYPES).toHaveLength(4);
  });
});

describe("two-mismatch (b) 裁决：四类协议对象键集 MUST ⊆ 白名单", () => {
  it("shutdown_request 构造产物键集 ⊆ 白名单", () => {
    const m = buildShutdownRequest({ request_id: "r", content: "reason" });
    expect(Object.keys(m).every((k) => (SEND_MESSAGE_PROTOCOL_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
  it("shutdown_response 构造产物键集 ⊆ 白名单", () => {
    const m = buildShutdownResponse({ request_id: "r", approve: true });
    expect(Object.keys(m).every((k) => (SEND_MESSAGE_PROTOCOL_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
  it("plan_approval_request 构造产物键集 ⊆ 白名单", () => {
    const m = buildPlanApprovalRequest({ request_id: "r", content: "plan" });
    expect(Object.keys(m).every((k) => (SEND_MESSAGE_PROTOCOL_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
  it("plan_approval_response 构造产物键集 ⊆ 白名单", () => {
    const m = buildPlanApprovalResponse({ request_id: "r", approve: false });
    expect(Object.keys(m).every((k) => (SEND_MESSAGE_PROTOCOL_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
});

describe("生成/解析对称（逐类 round-trip 深等于）", () => {
  it("shutdown_request build→parse 深等于", () => {
    const b = buildShutdownRequest({ request_id: "r1", content: "stop now", idGen });
    const p = parseProtocolMessage(b);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.message).toEqual(b);
  });
  it("shutdown_response build→parse 深等于", () => {
    const b = buildShutdownResponse({ request_id: "r1", approve: true, content: "bye" });
    const p = parseProtocolMessage(b);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.message).toEqual(b);
  });
  it("plan_approval_request build→parse 深等于", () => {
    const b = buildPlanApprovalRequest({ request_id: "r2", content: "the plan", idGen });
    const p = parseProtocolMessage(b);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.message).toEqual(b);
  });
  it("plan_approval_response build→parse 深等于（content 缺省省略键）", () => {
    const b = buildPlanApprovalResponse({ request_id: "r2", approve: false });
    const p = parseProtocolMessage(b);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.message).toEqual(b);
  });
});

describe("解析器点名报错（禁静默）", () => {
  it("非对象报错", () => {
    const r = parseProtocolMessage("not object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plain object/);
  });
  it("缺/空 type 报错", () => {
    const r = parseProtocolMessage({ request_id: "r" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty string `type`/);
  });
  it("未知 type 报错（点名 type）", () => {
    const r = parseProtocolMessage({ type: "bogus", request_id: "r" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown protocol type `bogus`/);
  });
  it("越界键报错（点名键名）", () => {
    const r = parseProtocolMessage({ type: "shutdown_request", request_id: "r", content: "", evil: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown protocol field `evil`/);
  });
  it("two-mismatch (b)：证据富字段（from/timestamp/planFilePath/planContent/requestId）一律被拒", () => {
    const evidenceShape = {
      type: "plan_approval_request",
      from: "lead",
      timestamp: "2026-01-01T00:00:00Z",
      planFilePath: "/p/plan.md",
      planContent: "full plan body",
      requestId: "r-evidence",
    };
    const r = parseProtocolMessage(evidenceShape);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown protocol field `(from|timestamp|planFilePath|planContent|requestId)`/);
  });
  it("two-mismatch (b)：shutdown_request 富字段（from/reason/timestamp）被拒", () => {
    const r = parseProtocolMessage({ type: "shutdown_request", request_id: "r", content: "", from: "x", reason: "y", timestamp: "z" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown protocol field `(from|reason|timestamp)`/);
  });
  it("response 缺布尔 approve 报错", () => {
    const r = parseProtocolMessage({ type: "shutdown_response", request_id: "r" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must carry a boolean `approve`/);
  });
});

describe("createProtocolPairing 配对四点", () => {
  it("正常配对：open→settle 返回配对且出途清空", () => {
    const p = createProtocolPairing();
    const req = buildShutdownRequest({ request_id: "r1", idGen });
    p.open(req);
    expect(p.pending()).toHaveLength(1);
    const pair = p.settle("r1", buildShutdownResponse({ request_id: "r1", approve: true }));
    expect(pair.request).toEqual(req);
    expect(pair.response.approve).toBe(true);
    expect(p.pending()).toHaveLength(0);
  });
  it("未知 id settle 抛错（点名 request_id）", () => {
    const p = createProtocolPairing();
    expect(() => p.settle("ghost", buildShutdownResponse({ request_id: "ghost", approve: true }))).toThrow(
      /unknown request_id `ghost`/,
    );
  });
  it("二次 settle 抛错（点名 unknown）", () => {
    const p = createProtocolPairing();
    p.open(buildShutdownRequest({ request_id: "r2", idGen }));
    p.settle("r2", buildShutdownResponse({ request_id: "r2", approve: false }));
    expect(() => p.settle("r2", buildShutdownResponse({ request_id: "r2", approve: true }))).toThrow(/unknown request_id `r2`/);
  });
  it("跨类型错配（shutdown↔plan）settle 抛错（点名）", () => {
    const p = createProtocolPairing();
    p.open(buildShutdownRequest({ request_id: "r3", idGen }));
    expect(() => p.settle("r3", buildPlanApprovalResponse({ request_id: "r3", approve: true }))).toThrow(
      /type mismatch for request_id `r3`/,
    );
  });
});

describe("拒绝/批准双路（布尔字段）与后果文案常量", () => {
  it("shutdown_response approve 两值均正确", () => {
    expect(buildShutdownResponse({ request_id: "r", approve: true }).approve).toBe(true);
    expect(buildShutdownResponse({ request_id: "r", approve: false }).approve).toBe(false);
  });
  it("plan_approval_response approve 两值均正确", () => {
    expect(buildPlanApprovalResponse({ request_id: "r", approve: true }).approve).toBe(true);
    expect(buildPlanApprovalResponse({ request_id: "r", approve: false }).approve).toBe(false);
  });
  it("后果文案常量明确例外后果（批准 shutdown=终止自己 / 拒绝 plan=发起方继续）", () => {
    expect(TEAMS_PROTOCOL_CONSEQUENCES.shutdownApproved).toMatch(/terminates itself/);
    expect(TEAMS_PROTOCOL_CONSEQUENCES.planRejected).toMatch(/continues modifying the plan/);
    expect(TEAMS_PROTOCOL_CONSEQUENCES.shutdownRejected).toMatch(/continues running/);
    expect(TEAMS_PROTOCOL_CONSEQUENCES.planApproved).toMatch(/proceed with the plan/);
  });
});

describe("DoD② 不自动终止（复用既有泵；onAborted 计数 0）", () => {
  it("泵：shutdown_request 分发不触发 onAborted，且 handled.shutdown_request=1", () => {
    const onAborted = vi.fn();
    const pump = createTeammateMessagePump({ deliver: () => {}, onAborted });
    pump.dispatch({ type: "shutdown_request", originalMessage: "please stop" });
    expect(onAborted).not.toHaveBeenCalled();
    expect(pump.handled.shutdown_request).toBe(1);
  });
  it("runner.receive shutdown_request：注入为 shutdown_request user turn，terminate 不被自动调用", () => {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    const inboxPath = teammateInboxPath("/teams", "team1", "mateA");
    mem.writeFileSync(
      inboxPath,
      JSON.stringify([{ from: "team-lead", text: "", message: buildShutdownRequest({ request_id: "rX", content: "wrap up" }) }]),
    );
    const deliveredToModel: TeammateDelivery[] = [];
    const terminate = vi.fn();
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToModel: (d) => deliveredToModel.push(d),
      terminate,
    });
    return runner.receive().then(() => {
      expect(terminate).not.toHaveBeenCalled();
      expect(deliveredToModel).toHaveLength(1);
      expect(deliveredToModel[0]!.meta.kind).toBe("shutdown_request");
    });
  });
});

describe("DoD③ plan_approval 链（请求→确认→回灌发起方；拒绝=发起方继续）", () => {
  function setupPlan(overrides: { requestApproval?: (r: { request_id: string; content: string }) => { approve: boolean; feedback?: string } }) {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    const inboxPath = teammateInboxPath("/teams", "team1", "mateA");
    mem.writeFileSync(
      inboxPath,
      JSON.stringify([
        {
          from: "team-lead",
          text: "",
          message: buildPlanApprovalRequest({ request_id: "plan-1", content: "proposed plan" }),
        },
      ]),
    );
    const deliveredToMain: string[] = [];
    const warns: string[] = [];
    const requestApproval = overrides.requestApproval ?? ((_r) => ({ approve: true }));
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToMain: (t) => deliveredToMain.push(t),
      warn: (m) => warns.push(m),
      requestApproval,
    });
    return { runner, deliveredToMain, warns };
  }
  it("批准：requestApproval 被调用，response 回灌 lead 且 approve=true", async () => {
    const { runner, deliveredToMain } = setupPlan({ requestApproval: () => ({ approve: true, feedback: "lgtm" }) });
    await runner.receive();
    expect(deliveredToMain).toHaveLength(1);
    expect(deliveredToMain[0]).toContain('"approve":true');
    expect(deliveredToMain[0]).toContain("plan-1");
  });
  it("拒绝：response approve=false 回灌 + 后果文案（发起方继续修改）", async () => {
    const { runner, deliveredToMain, warns } = setupPlan({ requestApproval: () => ({ approve: false, feedback: "needs work" }) });
    await runner.receive();
    expect(deliveredToMain[0]).toContain('"approve":false');
    expect(warns.some((w) => w.includes(TEAMS_PROTOCOL_CONSEQUENCES.planRejected))).toBe(true);
  });
  it("fail-closed：requestApproval 缺席 → 判定拒绝（approve=false 回灌）+ 告警不静默", async () => {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    const inboxPath = teammateInboxPath("/teams", "team1", "mateA");
    mem.writeFileSync(
      inboxPath,
      JSON.stringify([{ from: "team-lead", text: "", message: buildPlanApprovalRequest({ request_id: "plan-2", content: "p" }) }]),
    );
    const deliveredToMain: string[] = [];
    const warns: string[] = [];
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToMain: (t) => deliveredToMain.push(t),
      warn: (m) => warns.push(m),
    });
    await runner.receive();
    expect(deliveredToMain[0]).toContain('"approve":false');
    expect(warns.some((w) => /failing closed to REJECT/.test(w))).toBe(true);
  });
});

describe("DoD④ 后果文案（runner 层：shutdown 应答 terminate 恰好一次 / 拒绝继续）", () => {
  function setupShutdownResponder(inboxEntries: unknown[]) {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    const inboxPath = teammateInboxPath("/teams", "team1", "mateA");
    mem.writeFileSync(inboxPath, JSON.stringify(inboxEntries));
    const deliveredToModel: TeammateDelivery[] = [];
    const deliveredToMain: string[] = [];
    const warns: string[] = [];
    const terminate = vi.fn();
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToModel: (d) => deliveredToModel.push(d),
      deliverToMain: (t) => deliveredToMain.push(t),
      warn: (m) => warns.push(m),
      terminate,
    });
    return { runner, deliveredToModel, deliveredToMain, warns, terminate };
  }
  it("批准 shutdown：模型经 port 回送 approve=true → terminate 恰好一次 + 后果文案", async () => {
    const { runner, terminate, warns } = setupShutdownResponder([
      { from: "team-lead", text: "", message: buildShutdownRequest({ request_id: "s1", content: "stop" }) },
    ]);
    await runner.receive(); // 注入 shutdown_request（不自动终止）
    await runner.port.send({ to: "main", message: buildShutdownResponse({ request_id: "s1", approve: true }) });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => w.includes(TEAMS_PROTOCOL_CONSEQUENCES.shutdownApproved))).toBe(true);
  });
  it("拒绝 shutdown：approve=false → 不终止 + 继续文案", async () => {
    const { runner, terminate, warns } = setupShutdownResponder([
      { from: "team-lead", text: "", message: buildShutdownRequest({ request_id: "s2", content: "stop" }) },
    ]);
    await runner.receive();
    await runner.port.send({ to: "main", message: buildShutdownResponse({ request_id: "s2", approve: false }) });
    expect(terminate).not.toHaveBeenCalled();
    expect(warns.some((w) => w.includes(TEAMS_PROTOCOL_CONSEQUENCES.shutdownRejected))).toBe(true);
  });
  it("非法/未配对应答：request_id 未配对 → 抛错点名", async () => {
    const { runner } = setupShutdownResponder([]);
    await expect(runner.port.send({ to: "main", message: buildShutdownResponse({ request_id: "unpaired", approve: true }) })).rejects.toThrow(
      /unpaired protocol response/,
    );
  });
});

describe("回灌链路（port 投递路由）", () => {
  function setup() {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    roster.addMember("mateB");
    const deliveredToMain: string[] = [];
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToMain: (t) => deliveredToMain.push(t),
    });
    return { runner, mem, roster, deliveredToMain };
  }
  it("to=成员 → 落该成员 inbox（appendMailbox 落盘）", async () => {
    const { runner, mem, roster } = setup();
    const member = roster.members()[1]!;
    await runner.port.send({ to: member.name, message: "hello mate" });
    const path = teammateInboxPath("/teams", "team1", member.name);
    expect(mem.store.has(path)).toBe(true);
    const entries = JSON.parse(mem.store.get(path)!);
    expect(entries[0].text).toBe("hello mate");
    expect(entries[0].from).toBe("mateA");
  });
  it("to=main → deliverToMain 调用", async () => {
    const { runner, deliveredToMain } = setup();
    await runner.port.send({ to: "main", message: "to lead" });
    expect(deliveredToMain).toEqual(["to lead"]);
  });
  it("to=unknown → 返回 unreachable-namespace", async () => {
    const { runner } = setup();
    const r = await runner.port.send({ to: "ghost", message: "x" });
    expect(r).toBe("unreachable-namespace");
  });
});

describe("幂等：重复 receive 不重复回灌", () => {
  it("两条纯文本 inbox 条目，第二次 receive 不再注入", async () => {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "team1" });
    roster.addMember("mateA");
    const inboxPath = teammateInboxPath("/teams", "team1", "mateA");
    mem.writeFileSync(
      inboxPath,
      JSON.stringify([
        { from: "lead", text: "one" },
        { from: "lead", text: "two" },
      ]),
    );
    const deliveredToModel: TeammateDelivery[] = [];
    const runner = createTeammateRunner({
      roster,
      selfName: "mateA",
      teamsRoot: "/teams",
      fs: mem,
      deliverToModel: (d) => deliveredToModel.push(d),
    });
    await runner.receive();
    await runner.receive();
    // new_messages 一次注入（两条合并）；第二次无新条目 → 仍是 1 次
    expect(deliveredToModel).toHaveLength(1);
  });
});

describe("DoD⑤ 同源断言（restrictToolsForTeammate 去 Agent name 参数，不改既有常量）", () => {
  it("Agent 工具经 restrictToolsForTeammate 后 name 参数被移除、required 去 name", () => {
    const agent = {
      name: "Agent",
      description: "spawn",
      inputSchema: { type: "object", required: ["prompt", "name"], properties: { prompt: { type: "string" }, name: { type: "string" } } },
    };
    const out = restrictToolsForTeammate([agent]);
    expect(Object.keys(out[0]!.inputSchema.properties ?? {})).not.toContain("name");
    expect(out[0]!.inputSchema.required).toEqual(["prompt"]);
  });
  it("TEAMMATE_SYSTEM_PROMPT_ADDENDUM 常量本体零改动（逐字对照）", () => {
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain("you MUST use the SendMessage tool.");
    expect(TEAMS_PROTOCOL_USAGE_RULES).toMatch(/Do NOT proactively send a `shutdown_request`/);
    expect(TEAMS_PROTOCOL_USAGE_RULES).toMatch(/Do NOT send structured JSON status messages/);
  });
  it("composeTeammateSystemPrompt 组合 addendum+rules 且不改 addendum 本体", () => {
    const composed = composeTeammateSystemPrompt();
    expect(composed).toContain(TEAMMATE_SYSTEM_PROMPT_ADDENDUM);
    expect(composed).toContain(TEAMS_PROTOCOL_USAGE_RULES);
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).not.toContain("Protocol Usage Rules");
  });
});

describe("五事件封闭不变量（本卡不新增事件型，泵仍恰五型）", () => {
  it("TEAMMATE_MESSAGE_EVENTS 仍恰五型，逐名与 WP-06 一致", () => {
    expect(TEAMMATE_MESSAGE_EVENTS).toHaveLength(5);
    expect([...TEAMMATE_MESSAGE_EVENTS]).toEqual([
      "shutdown_request",
      "new_message",
      "new_messages",
      "aborted",
      "idle_timeout",
    ]);
  });
});

// —— X-2 补充判别用例（盲态 V 实测的两枚 0 红针对应判别面；只新增，既有 40 例断言零改动）——
//   V6：protocol.ts `open()` 的 `duplicate open request_id` 分支被短路时，既有套件无一条变红（无判别力）。
//   V7：runner.ts `receive()` 的 `entry.from || TEAM_LEAD_ADDRESS` 被写死 team-lead 时，既有套件无一条变红
//       （既有用例入站条目 from 全是 "team-lead"，DoD③「回灌真正发起方」语义不可证伪）。
/** 虚拟 teamsRoot：全程 memFs 注入，不真落盘。 */
const X2_TEAMS_ROOT = "/tmp/wp08-x2-teams";

describe("X-2 判别①：同一 request_id 二次 open 抛错且点名该 id", () => {
  it("重复 open 抛错点名 request_id，且首次请求未被覆盖", () => {
    const p = createProtocolPairing();
    const first = buildShutdownRequest({ request_id: "dup-open-1", idGen });
    expect(p.open(first)).toBe("dup-open-1");
    expect(() => p.open(buildShutdownRequest({ request_id: "dup-open-1", idGen }))).toThrow(
      /duplicate open request_id `dup-open-1`/,
    );
    expect(p.pending()).toHaveLength(1);
    expect(p.pending()[0]!.request).toEqual(first); // 第二次 open 不得覆盖在途请求
  });
});

describe("X-2 判别②：回灌**真正发起方**（入站 from=alice ≠ team-lead）", () => {
  const REQ_ID = "plan-alice-1";
  /** alice 为发起方（非 team-lead），自 teammate=name 的视角收 plan_approval_request。 */
  function setupAliceInitiator(approve: boolean) {
    const mem = memFs();
    const roster = createTeamRoster({ teamName: "teamX" });
    roster.addMember("alice", { agentId: "a111111111111-2222" });
    const self = roster.addMember("mateA");
    const selfInbox = teammateInboxPath(X2_TEAMS_ROOT, roster.teamName, self.name);
    mem.writeFileSync(
      selfInbox,
      JSON.stringify([
        {
          from: "alice", // 真正的发起方（既有 40 例全是 "team-lead"，故该语义无判别力）
          text: "",
          message: buildPlanApprovalRequest({ request_id: REQ_ID, content: "alice's plan body" }),
        },
      ]),
    );
    const deliveredToMain: string[] = [];
    const runner = createTeammateRunner({
      roster,
      selfName: self.name,
      teamsRoot: X2_TEAMS_ROOT,
      fs: mem,
      deliverToMain: (t) => deliveredToMain.push(t),
      warn: () => {},
      requestApproval: () => ({ approve, feedback: "ok" }),
    });
    return {
      runner,
      mem,
      deliveredToMain,
      aliceInbox: teammateInboxPath(X2_TEAMS_ROOT, roster.teamName, "alice"),
    };
  }

  it("批准：plan_approval_response 落 alice 的 mailbox（request_id 一致），deliverToMain 零调用", async () => {
    const { runner, mem, deliveredToMain, aliceInbox } = setupAliceInitiator(true);
    await runner.receive();
    expect(deliveredToMain).toHaveLength(0); // 回灌走真正发起方，不是主对话
    expect(mem.store.has(aliceInbox)).toBe(true);
    const entries = JSON.parse(mem.store.get(aliceInbox)!) as Array<{
      message?: { type?: string; request_id?: string; approve?: boolean };
    }>;
    const hit = entries.find((e) => e.message?.type === "plan_approval_response");
    expect(hit).toBeDefined();
    expect(hit!.message!.request_id).toBe(REQ_ID);
    expect(hit!.message!.approve).toBe(true);
  });

  it("拒绝：approve=false 同样落 alice 的 mailbox，deliverToMain 零调用", async () => {
    const { runner, mem, deliveredToMain, aliceInbox } = setupAliceInitiator(false);
    await runner.receive();
    expect(deliveredToMain).toHaveLength(0);
    const entries = JSON.parse(mem.store.get(aliceInbox)!) as Array<{
      message?: { type?: string; request_id?: string; approve?: boolean };
    }>;
    const hit = entries.find((e) => e.message?.type === "plan_approval_response");
    expect(hit!.message!.request_id).toBe(REQ_ID);
    expect(hit!.message!.approve).toBe(false);
  });
});

describe("sanity：isTeamsProtocolType 与 TEAMMATE_DEFAULT_LEAD_NAME", () => {
  it("类型判别器", () => {
    expect(isTeamsProtocolType("shutdown_request")).toBe(true);
    expect(isTeamsProtocolType("nope")).toBe(false);
  });
});
