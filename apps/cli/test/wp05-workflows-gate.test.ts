// M6-WP-05：/workflows 命令注册门面（DoD④）+ 完成通知接线（DoD③）+ /tasks + 后台任务族零回归。
// 判据自足：
//   ① 门关：/workflows 不注册，注册表仍恰 31 件且逐字等于 CLI_COMMANDS（字节等价）【M7-WP-01 /goal 30→31，2026-09-19】；
//   ② 门开（workflow flag）：/workflows 注册（31 件）；
//   ③ /tasks、/background 在两种门态均注册且可执行（既有后台任务面零回归）；
//   ④ /workflows 渲染 workflowBoard 上的活动 tracker 最小树（无活动=提示，不抛）；
//   ⑤ 完成通知队列 push→drain 产出 <task-notification>（DoD③ 载荷形状 + once-only）。
import { afterEach, describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";
import { gatedRegistry } from "../src/experimental-gate.ts";
import { EXPERIMENTAL_ENV_KEY, resolveExperimental, type ExperimentalGate } from "@standardcode/platform";
import { createSession } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { workflowBoard } from "../src/workflow-board.ts";
import { createWorkflowProgressTracker, renderWorkflowProgressTree } from "@standardcode/capabilities";
import type { ProviderAdapter } from "@standardcode/providers";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({
      contextWindow: 1,
      maxOutputTokens: { default: 1, upper: 1 },
      thinking: "none",
      input: ["text"],
      streaming: true,
      toolCalling: true,
      cache: { ttlLevels: ["5m"], explicitBreakpoints: false },
    }),
    async *stream() {
      throw new Error("not used in WP-05 gate tests");
    },
    countTokens: async () => 0,
  };
}

const closed = resolveExperimental({ env: {}, settings: undefined });
// M6-WP-10 断言同步：open 由 env 全量 gate 收窄为显式 workflow 单 flag gate（设计口径「workflow 开=31」的语义）。
// env "1" 白名单缺席=全量随总闸——fork/export 实现落地后全量态=33；本卡前全量态与单 flag 态等价（实现面仅 1 件）。
const open: ExperimentalGate = { enabled: true, flags: ["workflow"], notices: [] };

afterEach(() => {
  workflowBoard.unregister("wp05-test-run");
});

describe("WP-05 DoD④ 实验门：/workflows 仅 flag 开启时注册", () => {
  it("门关：注册表逐字等于 CLI_COMMANDS 且恰 31 件（含 M7 /goal），/workflows 缺席", () => {
    const reg = gatedRegistry(closed);
    expect(reg.map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(reg).toHaveLength(31);
    expect(reg.find((c) => c.name === "workflows")).toBeUndefined();
  });

  it("门开（workflow flag）：/workflows 注册，注册表 32 件【M7-WP-01 /goal 30→31】", () => {
    const reg = gatedRegistry(open);
    expect(reg.find((c) => c.name === "workflows")).toBeDefined();
    expect(reg).toHaveLength(32);
  });

  it("CLI_COMMANDS 常量仍恰 31【M7-WP-01 /goal 30→31】（未被改动），实验命令实现不污染基础表", () => {
    expect(CLI_COMMANDS).toHaveLength(31);
    expect(CLI_COMMANDS.map((c) => c.name)).not.toContain("workflows");
  });
});

describe("WP-05 DoD⑤ /tasks + 后台任务族零回归", () => {
  function run(cmd: string): string {
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    const out: string[] = [];
    const base: ReplDeps = {
      session,
      io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} },
    };
    const commands = gatedRegistry(closed); // 既有面两种门态都含 /tasks /background
    const c = commands.find((x) => x.name === cmd)!;
    c.execute("", createCommandContext({ ...base, commands }));
    return out.join("\n");
  }

  it("/tasks 在门关闭态仍注册且可执行（不抛、产出文本）", () => {
    const text = run("tasks");
    expect(text.length).toBeGreaterThan(0);
  });

  it("/background 在门关闭态仍注册且可执行（不抛、产出文本）", () => {
    const text = run("background");
    expect(text.length).toBeGreaterThan(0);
  });

  it("/tasks、/background 在门开态也注册（两种门态都零回归）", () => {
    for (const gate of [closed, open]) {
      const reg = gatedRegistry(gate).map((c) => c.name);
      expect(reg).toContain("tasks");
      expect(reg).toContain("background");
    }
  });
});

describe("WP-05 DoD④ /workflows 命令渲染活动 tracker 最小树", () => {
  it("无活动 workflow：打印提示、不抛", () => {
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    const out: string[] = [];
    const base: ReplDeps = {
      session,
      io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} },
    };
    const cmd = gatedRegistry(open).find((c) => c.name === "workflows")!;
    cmd.execute("", createCommandContext({ ...base, commands: gatedRegistry(open) }));
    expect(out.join("\n")).toContain("[workflows] no active workflow");
  });

  it("有活动 tracker：渲染最小纯文本进度树（含 phase + cached agent 预览）", () => {
    const tracker = createWorkflowProgressTracker({ name: "W", runId: "wp05-test-run", phases: ["Setup"] });
    tracker.phase("Setup");
    tracker.log("booting");
    tracker.agentProgress(
      { key: "wfkey-x", agentId: "wfagent-x", cached: true, attempts: 1, result: "ok", resultPreview: "ok" },
      { label: "go" },
    );
    workflowBoard.register("wp05-test-run", tracker);

    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    const out: string[] = [];
    const base: ReplDeps = {
      session,
      io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} },
    };
    const cmd = gatedRegistry(open).find((c) => c.name === "workflows")!;
    cmd.execute("", createCommandContext({ ...base, commands: gatedRegistry(open) }));
    const text = out.join("\n");
    expect(text).toContain("workflow: W (run wp05-test-run)");
    expect(text).toContain("[x] phase 1: Setup");
    expect(text).toContain(". booting");
    expect(text).toContain("(cached): ok");
  });

  it("与直接渲染一致（命令走 board 取 tracker）", () => {
    const tracker = createWorkflowProgressTracker({ name: "W", runId: "wp05-test-run", phases: ["Run"] });
    tracker.phase("Run");
    workflowBoard.register("wp05-test-run", tracker);
    const direct = renderWorkflowProgressTree(tracker);
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    const out: string[] = [];
    const base: ReplDeps = {
      session,
      io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} },
    };
    gatedRegistry(open).find((c) => c.name === "workflows")!.execute("", createCommandContext({ ...base, commands: gatedRegistry(open) }));
    expect(out.join("\n")).toBe(direct);
  });
});

describe("WP-05 DoD③ 完成通知接线（board 队列 + <task-notification> 形状 + once-only）", () => {
  it("board.queue.push → drainNotifications 产出 <task-notification>，且 once-only（二次空）", () => {
    workflowBoard.queue.push({ name: "W", runId: "r1", status: "completed", resultPreview: "done" });
    const first = workflowBoard.drainNotifications();
    expect(first).toEqual(['<task-notification>Workflow "W" completed (run r1): done</task-notification>']);
    expect(workflowBoard.drainNotifications()).toEqual([]);
  });
});
