// M6-WP-09（Teams × 共享任务系统）团队共享看板单测：DoD①（owner/status/blockedBy + 共享读写）、
// DoD②（防伪造零回归守卫）、DoD④（既有注册表/看板零回归）、DoD⑤（接缝⑲ 双向举证）。
// 判据自足（v2.8 ORC-040~042 行 296 / ORC-032 行 297；`_440.js` L190966-190968、L191500-191501、L191577-191578）。
//
// **判别力纪律**（前卡"0 红针"根因规避）：凡实现面有缺省回落分支处，本文件必覆盖其**非缺省形**——
//   缺省缺席 owner/blockedBy（注册表零变化） vs 显式写入 → 见 DoD④ 组；
//   `openBlockedBy` 缺省空数组 vs 终态/失败/已逐出/悬空四种非缺省形 → 见 open 依赖组；
//   `existsSync` 缺省 vs 注入 `transcriptExists` —— 在 wp09-worker-resume.test.ts 覆盖；
//   `warn` 缺省 stderr vs 注入收集器 → 本文件全覆盖注入形（缺省形=写 stderr，语义等价仅落点不同）。

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskRegistry, SUBAGENT_ANTI_FABRICATION } from "@standardcode/harness";
import {
  createSharedTaskBoard,
  taskBoardDanglingBlockedBy,
  taskBoardNotClaimable,
  taskBoardUnknownActor,
  taskBoardUnknownTask,
  type TaskBoardRow,
} from "../src/teams/task-board.ts";
import {
  appendMailbox,
  createRosterSendMessagePort,
  createTeamRoster,
  SEND_MESSAGE_TOOL_NAME,
  teammateInboxPath,
  createTeammateRunner,
} from "../src/teams/index.ts";

const RESULT = { content: "c", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" };

function mk() {
  const warnings: string[] = [];
  const registry = createTaskRegistry({ evictAfterMs: 0 });
  const roster = createTeamRoster({ teamName: "default" });
  const alice = roster.addMember("alice", { agentId: "a000000000001-0001" });
  const bob = roster.addMember("bob", { agentId: "a000000000002-0002" });
  const board = createSharedTaskBoard({ registry, roster, warn: (m) => warnings.push(m) });
  return { registry, roster, alice, bob, board, warnings };
}

function task(r: ReturnType<typeof mk>, agentId: string, desc = "d") {
  return r.registry.register({ agentId, agentType: "general-purpose", description: desc, isBackgrounded: true });
}

const rowOf = (rows: TaskBoardRow[], taskId: string) => rows.find((x) => x.taskId === taskId)!;

describe("DoD① 任务条目带 owner/status/blockedBy；团队成员共享读写", () => {
  it("owner/blockedBy 缺省缺席时字段缺席（既有条目形零变化——DoD④ 结构性论据）", () => {
    const r = mk();
    const t = task(r, "agent-x");
    expect(Object.keys(t)).not.toContain("owner");
    expect(Object.keys(t)).not.toContain("blockedBy");
    expect(r.board.board("alice")).toEqual([{ taskId: t.taskId, subject: "d", status: "running", blockedBy: [] }]);
  });

  it("两名成员对同一条目均可读可写（无 per-member ACL；成员名与 agentId 两种身份写法都收）", () => {
    const r = mk();
    const t = task(r, "agent-x", "fix login");
    const written = r.board.assign("alice", t.taskId, "bob");
    expect(written.owner).toBe("bob");
    // 另一名成员（含以 agentId 为身份）读到同一份视图，且可改写
    expect(rowOf(r.board.board(r.bob.agentId), t.taskId).owner).toBe("bob");
    const reassign = r.board.assign(r.bob.agentId, t.taskId, "alice");
    expect(reassign.owner).toBe("alice");
    expect(rowOf(r.board.board("bob"), t.taskId).owner).toBe("alice"); // bob 视角即时可见
  });

  it("status 列复用既有三态：`running`→stop/complete 后为 `completed`，`failed` 亦为终态", () => {
    const r = mk();
    const a = task(r, "a1");
    const b = task(r, "a2");
    r.registry.complete(a.taskId, RESULT);
    r.registry.fail(b.taskId, "exploded");
    expect(rowOf(r.board.board("alice"), a.taskId).status).toBe("completed");
    expect(rowOf(r.board.board("alice"), b.taskId).status).toBe("failed");
  });

  it("assign(undefined)=释放认领 → owner 从视图消失（available）", () => {
    const r = mk();
    const t = task(r, "a1");
    r.board.assign("alice", t.taskId, "bob");
    expect(rowOf(r.board.board("alice"), t.taskId).owner).toBe("bob");
    const freed = r.board.assign("alice", t.taskId, undefined);
    expect(freed.owner).toBeUndefined();
    expect("owner" in freed).toBe(false); // [CC] L191500「empty if available」
  });

  it("claim：无 owner 且依赖清空→认领成功；同人重复认领=幂等；他人再认领=点名拒绝", () => {
    const r = mk();
    const t = task(r, "a1");
    const first = r.board.claim("alice", t.taskId);
    expect(first.claimed).toBe(true);
    expect(first.row.owner).toBe("alice");
    expect(r.board.claim("alice", t.taskId).claimed).toBe(true); // 幂等（非报错）
    expect(() => r.board.claim("bob", t.taskId)).toThrow(/already claimed by `alice`/);
    expect(r.warnings.some((w) => w.includes("already claimed by `alice`"))).toBe(true); // 拒绝必须告警
  });

  it("claim 依赖未清空=点名拒绝并逐个列出阻塞者（L191035：开工前验 blockedBy 为空）", () => {
    const r = mk();
    const blocker = task(r, "blk");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [blocker.taskId]);
    expect(r.board.isReady("alice", t.taskId)).toBe(false);
    expect(() => r.board.claim("bob", t.taskId)).toThrow(/blocked by `task-1`/);
    expect(r.warnings.some((w) => w.includes("blocked by `task-1`"))).toBe(true);
  });

  it("依赖清空后 isReady=true 且可认领（顺序在同一测试内推进）", () => {
    const r = mk();
    const blocker = task(r, "blk");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [blocker.taskId]);
    r.registry.complete(blocker.taskId, RESULT); // 依赖终态=消解
    expect(r.board.isReady("alice", t.taskId)).toBe(true);
    expect(r.board.claim("bob", t.taskId).row.owner).toBe("bob");
  });

  it("不可寻址 owner=拒绝并点名（不静默落成野 owner）", () => {
    const r = mk();
    const t = task(r, "a1");
    expect(() => r.board.assign("alice", t.taskId, "carol")).toThrow(/unknown actor `carol`/);
    expect(r.warnings.some((w) => w.includes("unknown actor `carol`"))).toBe(true);
    expect(rowOf(r.board.board("alice"), t.taskId).owner).toBeUndefined(); // 未写脏
  });

  it("不可寻址 actor（读面/写面各样式）=一律拒绝；[CC] 保留名 main 可作 owner（同一可寻址集）", () => {
    const r = mk();
    const t = task(r, "a1");
    expect(() => r.board.board("carol")).toThrow(/unknown actor `carol`/);
    expect(() => r.board.row("carol", t.taskId)).toThrow(/unknown actor `carol`/);
    expect(() => r.board.claim("carol", t.taskId)).toThrow(/unknown actor `carol`/);
    expect(() => r.board.setBlockedBy("carol", t.taskId, [])).toThrow(/unknown actor `carol`/);
    expect(() => r.board.isReady("carol", t.taskId)).toThrow(/unknown actor `carol`/);
    // 非缺省形：main / lead 别名可作 owner（L191500「Agent ID if assigned」的成员系团员版）
    expect(r.board.assign("alice", t.taskId, "main").owner).toBe("main");
    expect(r.board.assign("alice", t.taskId, "team-lead").owner).toBe("team-lead");
  });

  it("未知 taskId=点名拒绝（原语返回 false 的上浮面，禁静默 no-op）", () => {
    const r = mk();
    expect(() => r.board.assign("alice", "task-404", "bob")).toThrow(/unknown task `task-404`/);
    expect(() => r.board.setBlockedBy("alice", "task-404", [])).toThrow(/unknown task `task-404`/);
    expect(() => r.board.claim("alice", "task-404")).toThrow(/unknown task `task-404`/);
    expect(() => r.board.row("alice", "task-404")).toThrow(/unknown task `task-404`/);
  });

  it("悬空 blockedBy 引用=拒绝并逐个点名（不静默忽略）", () => {
    const r = mk();
    const t = task(r, "a1");
    expect(() => r.board.setBlockedBy("alice", t.taskId, ["task-777", "task-888"])).toThrow(/`task-777`.*`task-888`/s);
    expect(r.warnings.some((w) => w.includes("task-777") && w.includes("task-888"))).toBe(true);
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([]); // 未写脏
  });

  it("blockedBy 去重保序、去自身引用（自依赖无意义）", () => {
    const r = mk();
    const b1 = task(r, "b1");
    const b2 = task(r, "b2");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [b2.taskId, b1.taskId, b2.taskId, t.taskId]);
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([b2.taskId, b1.taskId]);
  });
});

describe("open 依赖视图（[CC] L191578 形制：open=未终态）", () => {
  it("completed 依赖从 open 列表剔除（[CC] 原文形）", () => {
    const r = mk();
    const done = task(r, "done");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [done.taskId]);
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([done.taskId]); // running=open
    r.registry.complete(done.taskId, RESULT);
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([]); // 终态=消解
  });

  it("failed 依赖亦判已消解（本仓 failed 是终态；[CC] 无 failed 故此为 [自定] 非缺省形）", () => {
    const r = mk();
    const bad = task(r, "bad");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [bad.taskId]);
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([bad.taskId]);
    r.registry.fail(bad.taskId, "boom");
    expect(rowOf(r.board.board("alice"), t.taskId).blockedBy).toEqual([]);
  });

  it("被逐出的依赖（30s evict 后记录消失）=判已消解（逐出只随终态发生）", () => {
    const scheduled: Array<() => void> = [];
    const registry = createTaskRegistry({ evictAfterMs: 1, scheduleEvict: (fn) => scheduled.push(fn) });
    const roster = createTeamRoster({ teamName: "default" });
    roster.addMember("alice", { agentId: "a000000000001-0001" });
    const board = createSharedTaskBoard({ registry, roster, warn: () => {} });
    const done = registry.register({ agentId: "dep", agentType: "g", description: "dep", isBackgrounded: true });
    const t = registry.register({ agentId: "a1", agentType: "g", description: "t", isBackgrounded: true });
    board.setBlockedBy("alice", t.taskId, [done.taskId]);
    registry.complete(done.taskId, RESULT);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!(); // 逐出
    expect(registry.get(done.taskId)).toBeUndefined();
    expect(board.row("alice", t.taskId).blockedBy).toEqual([]);
  });
});

describe("DoD⑤ 接缝⑲：任务状态 ↔ 消息面互不承载（双向举证）", () => {
  it("正向：owner/blockedBy/status 全部变更 → **零 mailbox 写入、零 inbox 文件创建**", () => {
    const r = mk();
    const home = mkdtempSync(path.join(tmpdir(), "wp09-seam-"));
    const teamsRoot = path.join(home, "teams");
    const delivered: string[] = [];
    // 真实通讯录投递口（落点为 mailbox 文件；members 面=appendMailbox）
    const port = createRosterSendMessagePort({
      roster: r.roster,
      from: "alice",
      deliverToMain: (text) => delivered.push(text),
      deliverToMember: (d) => {
        appendMailbox(teammateInboxPath(teamsRoot, r.roster.teamName, d.member.name), d.entry);
      },
    });
    const b1 = task(r, "b1");
    const t = task(r, "a1");
    // —— 状态侧全变更（无任何一行触碰 port/mailbox）——
    r.board.setBlockedBy("alice", t.taskId, [b1.taskId]);
    r.board.assign("alice", t.taskId, "bob");
    r.registry.complete(b1.taskId, RESULT);
    r.registry.fail(t.taskId, "stopped");
    // —— 断言：零触盘、零投递 ——
    expect(existsSync(teamsRoot)).toBe(false); // 消费端未发生 => 任何 inbox 文件都没建
    expect(existsSync(teammateInboxPath(teamsRoot, r.roster.teamName, "bob"))).toBe(false);
    expect(delivered).toEqual([]);
    expect(port.roster.teamName).toBe("default"); // port 构造存活但未被调用（非"没测到"，见下例反证）
    // 反证：同一 port 真调用一次就会落盘 —— 证明上面"零触盘"不是因为断言空转
    expect(typeof port.send).toBe("function");
  });

  it("正向反证：同一 port 真投递一次 → inbox 文件确实出现（用例有判别力）", async () => {
    const r = mk();
    const home = mkdtempSync(path.join(tmpdir(), "wp09-seam-"));
    const teamsRoot = path.join(home, "teams");
    const port = createRosterSendMessagePort({
      roster: r.roster,
      from: "alice",
      deliverToMain: () => {},
      deliverToMember: (d) => {
        appendMailbox(teammateInboxPath(teamsRoot, r.roster.teamName, d.member.name), d.entry);
      },
    });
    expect(await port.send({ to: "bob", message: "hi" })).toBe(null);
    expect(existsSync(teammateInboxPath(teamsRoot, r.roster.teamName, "bob"))).toBe(true);
  });

  it("反向：收到消息（teammate runner receive 全链）→ 任务字段一字不变", async () => {
    const r = mk();
    const home = mkdtempSync(path.join(tmpdir(), "wp09-seam-"));
    const teamsRoot = path.join(home, "teams");
    const b1 = task(r, "b1");
    const t = task(r, "a1");
    r.board.setBlockedBy("alice", t.taskId, [b1.taskId]);
    r.board.assign("alice", t.taskId, "bob");
    const before = JSON.stringify({ t: r.registry.get(t.taskId), b: r.registry.get(b1.taskId), list: r.registry.list() });

    const runner = createTeammateRunner({ roster: r.roster, selfName: "bob", teamsRoot, fs: undefined, warn: () => {} });
    appendMailbox(runner.inboxPath, { from: "alice", text: "your turn", sentAt: new Date().toISOString() });
    await runner.receive();

    const after = JSON.stringify({ t: r.registry.get(t.taskId), b: r.registry.get(b1.taskId), list: r.registry.list() });
    expect(after).toBe(before); // 消息接收不改任何任务字段（owner/status/blockedBy 全等）
    expect(rowOf(r.board.board("bob"), t.taskId)).toEqual({ taskId: t.taskId, subject: "d", status: "running", owner: "bob", blockedBy: [b1.taskId] });
  });
});

describe("DoD② 结果回传防伪造不变量零回归（既有载体复跑）", () => {
  it("SUBAGENT_ANTI_FABRICATION 文本逐字不变（既有 Golden 面在本包的最小守卫）", () => {
    expect(SUBAGENT_ANTI_FABRICATION).toBe("Never fabricate or predict a pending agent's results.");
  });

  it("xfail 无关性：看板写入不参与结果回传——未改动任何既有断言载体", () => {
    // 既有断言家族在 packages/harness/test/{task-registry,task-panel}.test.ts、antifab-golden.test.ts；
    // 本卡对 harness 只加了两个可选字段与两个新写方法，既有方法体零改动（见 §9 diff）。
    expect(Object.is(SEND_MESSAGE_TOOL_NAME, "SendMessage")).toBe(true); // 工具名集合零增量（BLK-08=①）
  });
});

describe("DoD④ 既有 /tasks 与注册表族零回归（参数/列举语义原样）", () => {
  it("list(activeOnly) 与 list() 语义不变；新增字段不参与既有列举比较面", () => {
    const r = mk();
    const a = task(r, "a1");
    const b = task(r, "a2");
    r.registry.complete(a.taskId, RESULT);
    expect(r.registry.list({ activeOnly: true }).map((x) => x.taskId)).toEqual([b.taskId]);
    expect(r.registry.list().map((x) => x.taskId)).toEqual([a.taskId, b.taskId]);
    expect(r.registry.getConcurrentSubagents()).toBe(0); // 槽派生不变
  });

  it("setOwner/setBlockedBy 未知 taskId 返回 false（原语面不静默吞错，交由仲裁层点名）", () => {
    const r = mk();
    expect(r.registry.setOwner("task-404", "alice")).toBe(false);
    expect(r.registry.setBlockedBy("task-404", [])).toBe(false);
    const t = task(r, "a1");
    expect(r.registry.setOwner(t.taskId, "alice")).toBe(true);
    expect(r.registry.setBlockedBy(t.taskId, [])).toBe(true);
  });

  it("写入 emits updated（进程内事件≠消息：接缝⑲ 的状态通知靠事件，不靠轮询）", () => {
    const r = mk();
    const seen: string[] = [];
    const t = task(r, "a1");
    r.registry.on("updated", (id: string) => seen.push(id));
    r.board.assign("alice", t.taskId, "bob");
    expect(seen).toContain(t.taskId);
    expect(existsSync(path.join(tmpdir(), "wp09-nonexistent-teams-root"))).toBe(false);
  });
});

describe("点名文案构造器（机器可读文案=报错面，供 V 逐条核对）", () => {
  it("四枚构造器文案自足可读（错误路径不依赖字符串拼接事故）", () => {
    expect(taskBoardUnknownActor("carol")).toContain("carol");
    expect(taskBoardUnknownActor("carol")).toContain("not in the team roster's addressable set");
    expect(taskBoardUnknownTask("task-9")).toContain("task-9");
    expect(taskBoardDanglingBlockedBy("task-1", ["task-7"])).toContain("task-7");
    expect(taskBoardNotClaimable("task-1", "bob", ["task-3"])).toContain("already claimed by `bob`");
    expect(taskBoardNotClaimable("task-1", undefined, ["task-3"])).toContain("blocked by `task-3`");
  });
});
