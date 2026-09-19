// M7-WP-13「随卡小件四」（执行员 X-WP13-B）：M6 已核销能力的缺陷修复 + 判别用例。
// 判据原文（先读原文再动手）：D:/StandardCode/plan/T2-交付/M6-高阶编排/M6-1-results.md
//   行 163 → WP-04 观察 O1（坏行跳过 × 失败门交互）/ O2（escapeWorkflowResumeArg 未转义换行）
//   行 187 → WP-05 观察 O1（snapshot 浅拷污染内部）
//   行 188 → WP-05 观察 O2（门内实现合并顺序无断言 → prepend 变异 22/22 仍绿＝0 红针）
// 本件只加断言，不改任何既有测试断言；①-③ 为缺陷复现用例（修前应红），④ 为判别力盲点用例。
import { describe, expect, it } from "vitest";
import {
  createWorkflowProgressTracker,
  isReplayableWorkflowKey,
  parseWorkflowJournal,
  renderWorkflowProgressSnapshot,
  workflowResumeRecipe,
  withWorkflowJournal,
  type WorkflowHooks,
} from "../src/index.ts";
import { CLI_COMMANDS } from "../../../apps/cli/src/commands.ts";
import {
  experimentalCommandImplementations,
  gateCommands,
  gatedRegistry,
} from "../../../apps/cli/src/experimental-gate.ts";

// ═════════════════════ ①WP-04 O1：坏行跳过 × 失败门交互（行 163） ═════════════════════

/** 同键「started + result」＝可回放态；追加一条坏 failed 行即必须失守回放门。 */
const REPLAYABLE_PREFIX = [
  '{"type":"started","key":"K","agentId":"a1"}',
  '{"type":"result","key":"K","agentId":"a1","result":"stale"}',
].join("\n");

function journalText(...extraLines: string[]): string {
  return [REPLAYABLE_PREFIX, ...extraLines].join("\n");
}

/** 最轻量 stub 编排（只探测 agent() 是否真派生）。 */
function stubOrchestration(agentImpl: (prompt: string) => Promise<unknown>): WorkflowHooks {
  return {
    agent: agentImpl as WorkflowHooks["agent"],
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items) => [...items],
  };
}

describe("WP-04 O1 坏行跳过 × 失败门（原报告实测三形）", () => {
  it("形①截断行（`{\"type\":\"failed\",\"key\":\"K\",\"agent`）：failed 集仍须含 K → 不回放", () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed","key":"K","agent'));
    expect([...state.failed]).toEqual(["K"]);
    expect(isReplayableWorkflowKey(state, "K")).toBe(false);
  });

  it("形②缺 agentId（`{\"type\":\"failed\",\"key\":\"K\"}`）：字段不全仍须归 failed 集", () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed","key":"K"}'));
    expect([...state.failed]).toEqual(["K"]);
    expect(isReplayableWorkflowKey(state, "K")).toBe(false);
  });

  it("形③未知 type（`{\"type\":\"failed!\",\"key\":\"K\",\"agentId\":\"a1\"}`）：failed 前缀变体保守归 failed", () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed!","key":"K","agentId":"a1"}'));
    expect([...state.failed]).toEqual(["K"]);
    expect(isReplayableWorkflowKey(state, "K")).toBe(false);
  });

  it("对照例①完整 failed 行 → 正确重跑（不因本次修复而改变）", () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed","key":"K","agentId":"a1"}'));
    expect(isReplayableWorkflowKey(state, "K")).toBe(false);
  });

  it("对照例②无 failed 行 → 回放成立（缓存语义未被本次修复破坏）", () => {
    const state = parseWorkflowJournal(journalText());
    expect(isReplayableWorkflowKey(state, "K")).toBe(true);
  });

  it("对照例③其他键的 result 不受影响（失败门按 key 归属）", () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed","key":"OTHER"}'));
    expect(isReplayableWorkflowKey(state, "K")).toBe(true);
    expect(isReplayableWorkflowKey(state, "OTHER")).toBe(false);
  });

  it("真回放链：截断 failed 行在场时 agent() 必须真派生（fresh），不得返回同键陈旧 result", async () => {
    const state = parseWorkflowJournal(journalText('{"type":"failed","key":"K","agent'));
    let innerCalls = 0;
    const journaled = withWorkflowJournal(
      stubOrchestration(async () => {
        innerCalls++;
        return "fresh";
      }),
      { resume: state, keyDerivation: () => "K" },
    );
    await expect(journaled.hooks.agent("p")).resolves.toBe("fresh");
    expect(innerCalls).toBe(1);
    expect(journaled.replays).toHaveLength(0);
  });

  it("真回放链对照：无 failed 行时同键确实回放 cached:true（证上例判别力非来自门恒假）", async () => {
    const state = parseWorkflowJournal(journalText());
    let innerCalls = 0;
    const journaled = withWorkflowJournal(
      stubOrchestration(async () => {
        innerCalls++;
        return "fresh";
      }),
      { resume: state, keyDerivation: () => "K" },
    );
    await expect(journaled.hooks.agent("p")).resolves.toBe("stale");
    expect(innerCalls).toBe(0);
    expect(journaled.replays[0]?.cached).toBe(true);
  });
});

// ═════════════════════ ②WP-04 O2：配方换行未转义（行 163） ═════════════════════

/** 按 A 级 §7.3 形状剥前缀后，把配方当 JS 表达式求值（配方必须是合法 JS 字面量）。 */
function parseRecipe(recipe: string): { scriptPath: string; runId: string } {
  const prefix = "To resume manually: ";
  expect(recipe.startsWith(prefix)).toBe(true);
  const body = recipe.slice(prefix.length).replace(/\.$/, "");
  const factory = new Function("Workflow", `return ${body};`) as (w: unknown) => unknown;
  const parsed = factory((arg: unknown) => arg) as { scriptPath?: unknown; resumeFromRunId?: unknown };
  return { scriptPath: parsed.scriptPath as string, runId: parsed.resumeFromRunId as string };
}

describe("WP-04 O2 配方转义：含换行/回车的 scriptPath 仍须是合法 JS 字面量", () => {
  it("scriptPath 含 LF：生成配方单行且可解析，值逐字往返", () => {
    const scriptPath = "C:\\a\nb\\audit.js";
    const recipe = workflowResumeRecipe({ scriptPath, runId: "run-1" });
    expect(recipe.split(/\r?\n/)).toHaveLength(1);
    expect(parseRecipe(recipe).scriptPath).toBe(scriptPath);
  });

  it("scriptPath 含 CR：生成配方可解析，值逐字往返", () => {
    const scriptPath = "C:\\a\rb\\audit.js";
    const recipe = workflowResumeRecipe({ scriptPath, runId: "run-1" });
    expect(recipe).not.toContain("\r");
    expect(parseRecipe(recipe).scriptPath).toBe(scriptPath);
  });

  it("runId 含 CRLF：生成配方可解析，值逐字往返", () => {
    const recipe = workflowResumeRecipe({ scriptPath: "/tmp/w.js", runId: "r\r\n1" });
    expect(recipe.split(/\r?\n/)).toHaveLength(1);
    expect(parseRecipe(recipe).runId).toBe("r\r\n1");
  });

  it("对照例：单引号/反斜杠/无控制字符三例仍逐字（既有转义不回归）", () => {
    const cases = [
      { scriptPath: "/tmp/workflows/run-1/audit.js", runId: "run-1" },
      { scriptPath: "C:\\a\\b'c.js", runId: "r'1" },
      { scriptPath: "", runId: "" },
    ];
    for (const input of cases) {
      const parsed = parseRecipe(workflowResumeRecipe(input));
      expect(parsed).toEqual(input);
    }
  });
});

// ═════════════════════ ③WP-05 O1：snapshot 浅拷（行 187） ═════════════════════

const REPLAY_MARK = {
  key: "wfkey-deadbeef",
  agentId: "wfagent-r1-deadbee-1",
  cached: true as const,
  attempts: 1,
  result: "ok",
  resultPreview: "ok",
};

describe("WP-05 O1 snapshot：改返回值不得污染内部状态", () => {
  it("篡改快照内 agent 的 label → 内部状态与再次渲染均不变", () => {
    const tracker = createWorkflowProgressTracker({ name: "W", runId: "r1", phases: ["Setup"] });
    tracker.phase("Setup");
    tracker.log("boot");
    tracker.agentProgress(REPLAY_MARK, { label: "orig" });

    const snap = tracker.snapshot();
    const phase = snap.phases.find((p) => p.title === "Setup")!;
    phase.agents[0]!.label = "MUT_LABEL";
    phase.logs.push("MUT_LOG");

    const again = tracker.snapshot();
    expect(again.phases.find((p) => p.title === "Setup")!.agents[0]!.label).toBe("orig");
    expect(again.phases.find((p) => p.title === "Setup")!.logs).toEqual(["boot"]);
    const rendered = renderWorkflowProgressSnapshot(again);
    expect(rendered).toContain("- agent orig (cached): ok");
    expect(rendered).not.toContain("MUT_LABEL");
  });

  it("篡改快照内 phase 节点的标量字段/数组增删 → 内部状态不变", () => {
    const tracker = createWorkflowProgressTracker({ phases: ["Setup"] });
    tracker.phase("Setup");

    const snap = tracker.snapshot();
    const phase = snap.phases[0]!;
    phase.title = "MUT_TITLE";
    phase.appeared = false;
    phase.agents.push({ label: "ghost", agentId: "x", cached: false, resultPreview: "" });

    const again = tracker.snapshot();
    expect(again.phases.map((p) => [p.title, p.appeared])).toEqual([["Setup", true]]);
    expect(again.phases[0]!.agents).toEqual([]);
  });
});

// ═════════════════════ ④WP-05 O2：门内实现合并顺序（行 188） ═════════════════════

// 门态字面量（flags 用 `as const` 收窄到 ExperimentalFlag 字面量元组——capabilities 包不依赖 platform 类型，故不引其类型）。
const GATE_WORKFLOW_FORK = { enabled: true, flags: ["workflow", "fork"] as const, notices: [] };
const GATE_ALL = { enabled: true, flags: ["workflow", "teams", "fork"] as const, notices: [] };
const GATE_CLOSED = { enabled: false, flags: [] as const, notices: [] };

describe("WP-05 O2 门内实现合并顺序：append（先 CLI_COMMANDS 原序，再门内实现声明序）", () => {
  it("门开：注册表 = CLI_COMMANDS 逐字原序 ＋ 门内实现声明序追加于末尾", () => {
    const baseNames = CLI_COMMANDS.map((c) => c.name);
    const implNames = experimentalCommandImplementations().map((c) => c.name);
    const names = gatedRegistry(GATE_WORKFLOW_FORK).map((c) => c.name);

    expect(implNames).toEqual(["workflows", "fork", "export"]);
    expect(names).toEqual([...baseNames, ...implNames]);
    expect(names.slice(0, baseNames.length)).toEqual(baseNames); // 首段=基础表原序（prepend 变异即在此红）
    expect(names.at(-1)).toBe(implNames.at(-1)); // 门内实现在末尾
    expect(names.slice(baseNames.length)).toEqual(implNames);
  });

  it("三 flag 全开：顺序仍为「基础表原序 + 门内实现声明序」", () => {
    const baseNames = CLI_COMMANDS.map((c) => c.name);
    const implNames = experimentalCommandImplementations().map((c) => c.name);
    expect(gatedRegistry(GATE_ALL).map((c) => c.name)).toEqual([...baseNames, ...implNames]);
  });

  it("门关：逐字等于 CLI_COMMANDS（顺序与内容皆不变）", () => {
    expect(gatedRegistry(GATE_CLOSED).map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
  });

  it("自造变异（prepend 反转）判别力：候选表顺序反转入同一公开 API → 输出与本仓态逐字不同", () => {
    const impls = experimentalCommandImplementations();
    const implNames = impls.map((c) => c.name);
    const baked = gatedRegistry(GATE_WORKFLOW_FORK).map((c) => c.name);
    // 变异态＝候选表改为「门内实现在前」（＝实现若改为 prepend 的等价输出），全部经同一公开 API 合成。
    const prepended = gateCommands([...impls, ...CLI_COMMANDS], GATE_WORKFLOW_FORK).map((c) => c.name);
    const appendComposed = gateCommands([...CLI_COMMANDS, ...impls], GATE_WORKFLOW_FORK).map((c) => c.name);

    expect(prepended[0]).toBe(implNames[0]); // 变异态首项=门内实现（本仓态首项=CLI_COMMANDS[0]）
    expect(baked[0]).toBe(CLI_COMMANDS[0]!.name);
    // 指纹等值：本仓注册表 ≡ append 合成态 且 ≢ prepend 合成态（实现一旦反转为 prepend，本用例必红）。
    expect(baked).toEqual(appendComposed);
    expect(baked).not.toEqual(prepended);
    // 等价地：prepend 态下「首段=基础表原序」与「末项=门内实现末项」两条断言分别必红（＝本件前两条断言的判别点）。
    expect(prepended.slice(0, CLI_COMMANDS.length)).not.toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(prepended.at(-1)).not.toBe(implNames.at(-1));
    // 数量面无助于判别（此处证「存在性/数量断言」确实无法区分两态）：
    expect(new Set(prepended)).toEqual(new Set(baked));
  });
});
