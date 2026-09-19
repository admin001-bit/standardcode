// M7-WP-13（X-A 执行员）「可装配段」接线单测——八项各项正向一例（判别力：去掉接线即红）。
// 依据 D:/StandardCode/.work/wp13-recon.md §2 ①②④⑨⑩⑪⑬（⑦⑫ 见文件内说明）。
// 判据自足：
//   ① runsDir 注入：workflow flag 活跃 → session.workflowRunner.runsDir = platform workflowsDir(projectRoot, home/.standardcode)
//     （去 platform 单源/去三元注入 → 红）；flag 缺席/白名单未含 → 零构造。
//   ④ 真实 runner：装配五步真跑（tracker→orchestrator→journal→runWorkflowScript→queue.push→register）——
//     会话面 journal 落 <runsDir>/<runId>/journal.jsonl + <task-notification> 入 board 队列 + register/unregister 配对。
//   ⑨ 遥测桥接：真内核实发 tengu_workflow_* → 桥映射 → facade sink 实收 sc_workflow_*（去桥注入 → 红；对照例见 ⑨-control）。
//   ⑩ spent 注入：budgetTotal=3 / spent=()=>5 → 内核 budget 硬顶走通（cap 事件 payload {spent:5,budget:3}）→ 证 budget 面已注入。
//   ⑪ createSharedTaskBoard：teams flag 活跃 → 看板在位且读得到共享 registry 行（去一行构造 → 红）。
//   ⑬ unregister：终态必回收（registered/unregistered 恒等配对 + 终态后 board.get(runId)=null）。
//   ⑫ drainSessionNotes：三段 drain 抽公共后仍逐条回灌 user turn（once-only）。
// 注：⑦ loop 灌回续跑未落地（侦察 §2⑦ 标「高不确定/需新面」——续跑语义无规格）→ 见 .work/wp13-x-a.md §B。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEAMMATE_DEFAULT_LEAD_NAME, type WorkflowProgressTracker } from "@standardcode/capabilities";
import { createTelemetryFacade, encodeProjectPath, TELEMETRY_ENV_KEY, workflowsDir, type TelemetryEnvelope, type TelemetrySink } from "@standardcode/platform";
import type { Tool } from "@standardcode/harness";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { drainSessionNotes } from "../src/repl.ts";
import { WorkflowBoard, workflowBoard } from "../src/workflow-board.ts";
import { createWorkflowRunner } from "../src/workflow-runner.ts";

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 };
const TOOLS: Tool[] = [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }];

function fakeProvider(text = "ok"): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: USAGE } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

/** 简单脚本：phase/log + 一次真 agent 派生（走 kernel→runSubagent），顶层 return。 */
const SCRIPT_WITH_AGENT = `export const meta = { name: "W13", description: "wp13 wiring", phases: ["Setup"] };
phase("Setup");
log("boot");
const a = await agent("p0");
return { a };
`;

/** budget 硬顶脚本：首调 agent() 即触 budget cap（total=3 / spent=5）。 */
const SCRIPT_BUDGET = `export const meta = { name: "W13-budget", description: "wp13 budget" };
const a = await agent("p0");
return { a };
`;

const WF_ON = { enabled: true, flags: ["workflow"] as const, notices: [] };
const TEAMS_ON = { enabled: true, flags: ["teams"] as const, notices: [] };

/** register/unregister 可观测看板（子类化——不改 board 本体，无新 API）。 */
class SpyBoard extends WorkflowBoard {
  registered: string[] = [];
  unregistered: string[] = [];
  registerHadTracker: string[] = [];
  override register(runId: string, tracker: WorkflowProgressTracker): void {
    super.register(runId, tracker);
    this.registered.push(runId);
    if (super.get(runId) !== null) this.registerHadTracker.push(runId);
  }
  override unregister(runId: string): void {
    super.unregister(runId);
    this.unregistered.push(runId);
  }
}

function memorySink(): TelemetrySink & { events: TelemetryEnvelope[] } {
  const events: TelemetryEnvelope[] = [];
  return { events, write: (es) => { events.push(...es); } };
}

const homes: string[] = [];
function makeHome(): string {
  const dir = mkdtempSync(path.join(process.env.TEMP ?? tmpdir(), "wp13-x-a-home-"));
  homes.push(dir);
  return dir;
}

const runsDirs: string[] = [];
function makeRunsDir(): string {
  const dir = mkdtempSync(path.join(process.env.TEMP ?? tmpdir(), "wp13-x-a-runs-"));
  runsDirs.push(dir);
  return dir;
}

afterEach(() => {
  workflowBoard.drainNotifications();
  workflowBoard.unregister("wp13-sess-1");
  for (const d of runsDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("WP-13① runsDir 注入（session.ts workflow 门段，镜像 teamsRoot 三元形）", () => {
  it("flag 活跃：workflowRunner 在位，runsDir = workflowsDir(projectRoot, <home>/.standardcode)", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: WF_ON });
    expect(session.workflowRunner).toBeDefined();
    // 去 platform 单源（自拼路径）/去 home 三元覆写 → 本断言红
    expect(session.workflowRunner!.runsDir).toBe(workflowsDir(home, path.join(home, ".standardcode")));
    expect(session.workflowRunner!.runsDir).toBe(path.join(home, ".standardcode", "projects", encodeProjectPath(home), "workflows"));
  });

  it("门关（缺 experimental）与白名单未含 workflow：workflowRunner 零构造 + projects 目录零创建", () => {
    const home = makeHome();
    const off = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home });
    expect(off.workflowRunner).toBeUndefined();
    const teamsOnly = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: TEAMS_ON });
    expect(teamsOnly.workflowRunner).toBeUndefined();
    expect(existsSync(path.join(home, ".standardcode", "projects"))).toBe(false); // 零触盘
  });
});

describe("WP-13①④ 会话装配面：runner 真跑 → journal 落注入 runsDir + 通知入队列 + ⑬ 已回收", () => {
  it("session.workflowRunner.run：status=completed、journal.jsonl 落在 runsDir 下、board 队列实收通知、终态后不残留 tracker", async () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: WF_ON });
    const runner = session.workflowRunner!;
    const out = await runner.run({
      script: SCRIPT_WITH_AGENT,
      provider: fakeProvider("ok"),
      model: "m-a",
      tools: TOOLS,
      availableTypes: ["general-purpose"],
      runId: "wp13-sess-1",
    });
    expect(out.status).toBe("completed");
    expect(out.result).toEqual({ a: "ok" }); // 真编排内核 + 真 runSubagent（假 provider 文本回灌）
    // ① 单源路径：runsDir → journal（去注入 → 文件不在该目录）
    expect(existsSync(path.join(runner.runsDir, "wp13-sess-1", "journal.jsonl"))).toBe(true);
    // ④ 终态通知（queue.push 消费点）
    const notes = workflowBoard.drainNotifications();
    expect(notes).toEqual(['<task-notification>Workflow "W13" completed (run wp13-sess-1): {"a":"ok"}</task-notification>']);
    // ⑬ 配对回收：终态后单例不留 tracker
    expect(workflowBoard.get("wp13-sess-1")).toBeNull();
    expect(workflowBoard.list()).toEqual([]);
  });
});

describe("WP-13④⑤⑬ runner 装配：register/unregister 配对 + 队列消费点", () => {
  it("SpyBoard：派生时 register(runId, tracker) 真挂载、终态 unregister(runId)，两者恒等配对", async () => {
    const board = new SpyBoard();
    const runner = createWorkflowRunner({ runsDir: makeRunsDir(), board, newRunId: () => "run-fixed-1" });
    const out = await runner.run({ script: SCRIPT_WITH_AGENT, provider: fakeProvider("ok"), model: "m-a", tools: TOOLS, availableTypes: ["general-purpose"] });
    expect(out.runId).toBe("run-fixed-1");
    expect(board.registered).toEqual(["run-fixed-1"]); // ⑤ register 消费点存在
    expect(board.registerHadTracker).toEqual(["run-fixed-1"]); // 确挂上 tracker（非空调）
    expect(board.unregistered).toEqual(["run-fixed-1"]); // ⑬ 终态回收
    expect(board.get("run-fixed-1")).toBeNull();
    expect(board.drainNotifications()).toEqual(['<task-notification>Workflow "W13" completed (run run-fixed-1): {"a":"ok"}</task-notification>']);
  });

  it("失败终态同样投递（status=failed）+ 回收（⑬ 不泄漏）", async () => {
    const board = new SpyBoard();
    const runner = createWorkflowRunner({ runsDir: makeRunsDir(), board, newRunId: () => "run-failed-1" });
    const out = await runner.run({ script: `export const meta = { name: "W13-fail", description: "d" };\nthrow new Error("boom");\n`, provider: fakeProvider(), model: "m-a" });
    expect(out.status).toBe("failed");
    expect((out.error as Error).message).toContain("boom");
    expect(board.unregistered).toEqual(["run-failed-1"]);
    expect(board.drainNotifications()).toEqual(['<task-notification>Workflow "W13-fail" failed (run run-failed-1)</task-notification>']);
  });
});

describe("WP-13⑨⑩ 遥测桥接 + spent 注入（真内核 budget 硬顶 → 桥 → facade sink）", () => {
  function wired(runsDir: string, board: WorkflowBoard) {
    const sink = memorySink();
    const facade = createTelemetryFacade({ env: { [TELEMETRY_ENV_KEY]: "1" }, sink, sessionId: "wp13" });
    const runner = createWorkflowRunner({
      runsDir,
      board,
      newRunId: () => "run-budget-1",
      budgetTotal: 3,
      spent: () => 5,
      forwardTelemetry: (event, props) => facade.workflowEvent(event, props),
    });
    return { sink, runner };
  }

  it("budgetTotal=3/spent=5：内核硬顶触发 → 桥映射 → sink 实收 sc_workflow_budget_cap_exceeded{spent,budget}", async () => {
    const board = new SpyBoard();
    const { sink, runner } = wired(makeRunsDir(), board);
    const out = await runner.run({ script: SCRIPT_BUDGET, provider: fakeProvider("ok"), model: "m-a", tools: TOOLS, availableTypes: ["general-purpose"] });
    expect(out.status).toBe("failed"); // budget 硬顶抛出 → 失败终态（仍投递+回收）
    expect((out.error as Error).name).toBe("WorkflowBudgetError");
    const cap = sink.events.filter((e) => e.event === "sc_workflow_budget_cap_exceeded");
    expect(cap).toHaveLength(1); // 去 ⑩ budget 注入（total=null）→ 内核不发 → 红；去 ⑨ 桥注入 → sink 空 → 红
    expect(cap[0]!.properties).toEqual({ spent: 5, budget: 3, agentCount: 0 });
    expect(sink.events.every((e) => e.event.startsWith("sc_"))).toBe(true); // 无 tengu 裸名漏网（桥为唯一出口）
    expect(board.unregistered).toEqual(["run-budget-1"]);
  });

  it("⑨ 对照例：同 budget 场景但 runner 不注入桥（forwardTelemetry 缺位）→ 已接 sink 的 facade 零事件", async () => {
    const board = new SpyBoard();
    const sink = memorySink();
    createTelemetryFacade({ env: { [TELEMETRY_ENV_KEY]: "1" }, sink, sessionId: "wp13-ctl" }); // 门开、sink 就位
    const runner = createWorkflowRunner({ runsDir: makeRunsDir(), board, newRunId: () => "run-budget-2", budgetTotal: 3, spent: () => 5 });
    const out = await runner.run({ script: SCRIPT_BUDGET, provider: fakeProvider("ok"), model: "m-a", tools: TOOLS, availableTypes: ["general-purpose"] });
    expect(out.status).toBe("failed"); // budget 面仍在（证明上一例的产出确来自 ⑨ 桥注入，而非别处）
    expect(sink.events).toHaveLength(0);
  });
});

describe("WP-13⑪ createSharedTaskBoard 消费点（teams 门段一行）", () => {
  it("teams flag 活跃：sharedTaskBoard 在位，且 board(actor) 读得到共享 registry 的行", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: TEAMS_ON });
    expect(session.sharedTaskBoard).toBeDefined(); // 去那一行构造 → 红
    session.taskRegistry.register({ agentId: "a1", agentType: "general-purpose", description: "shared row", isBackgrounded: false });
    const rows = session.sharedTaskBoard!.board(TEAMMATE_DEFAULT_LEAD_NAME); // "team-lead" ∈ roster.addressable()（roster.ts:153-157）
    expect(rows.map((r) => r.subject)).toEqual(["shared row"]);
    expect(rows[0]!.taskId).toBeTruthy();
  });

  it("门关（teams flag 不活跃）：sharedTaskBoard 零构造", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: WF_ON });
    expect(session.sharedTaskBoard).toBeUndefined();
  });
});

describe("WP-13⑫ drainSessionNotes 抽公共（三段 isomorphic 单源）", () => {
  it("MCP/workflow/teammate 三段逐条回灌 user turn（形状+顺序与内联版逐字同）；once-only", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home });
    const mcpBuf = ["mcp-note"];
    const teamBuf = ["team-lead: hi"];
    session.drainMcpNotifications = () => mcpBuf.splice(0, mcpBuf.length); // 真实现同为 once-only（splice 语义）
    session.drainTeammateMessages = () => teamBuf.splice(0, teamBuf.length);
    workflowBoard.queue.push({ name: "W", runId: "r-drain", status: "completed", resultPreview: "ok" });

    drainSessionNotes(session);
    expect(session.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "<system-reminder>mcp-note</system-reminder>" }] },
      { role: "user", content: [{ type: "text", text: '<task-notification>Workflow "W" completed (run r-drain): ok</task-notification>' }] },
      { role: "user", content: [{ type: "text", text: "team-lead: hi" }] },
    ]);
    drainSessionNotes(session); // once-only：缓冲已空
    expect(session.messages).toHaveLength(3);
  });
});
