// M6-WP-11：workflow/teams 事件入 ENG-090 遥测基线之 platform 面单测（扩列契约逐枚+脱敏单源+默认关零触盘）。
// 基座形制复用 M5 WP-06（telemetry.test.ts 同口径，既有 19 例断言零改动）；本文件只测扩列增量：
//   - DoD① 扩列：sc_workflow_* 八枚逐枚产生（facade.workflowEvent 家族语义方法 [自定]，名对位 A 级 §10 八锚点）；
//   - DoD③ 脱敏：扩列事件属性经 SEC-030 同一单源 redactSecrets（与七事件同一 emit 通路）；
//   - DoD② 默认关：扩列事件零事件零写盘（M5 同口径断言）；
//   - teams 扩位：subagentLaunch.refusedCode 语义扩位两枚（SUBAGENT_REFUSED_CODE_* 常量）经既有产生点发射。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTelemetryFacade,
  SUBAGENT_REFUSED_CODE_TEAMMATE_MISSING_PARAMS,
  SUBAGENT_REFUSED_CODE_TEAMMATE_NO_TEAM_NAME,
  TELEMETRY_ENV_KEY,
  type ScWorkflowTelemetryEventName,
  type TelemetryEnvelope,
  type TelemetrySink,
} from "../src/telemetry.ts";
import { SECRET_PLACEHOLDER } from "../src/session-store.ts";

function memorySink(): TelemetrySink & { events: TelemetryEnvelope[] } {
  const events: TelemetryEnvelope[] = [];
  return { events, write: (es) => { events.push(...es); } };
}

const ENV_ON = { [TELEMETRY_ENV_KEY]: "1" };
const ENV_OFF = { [TELEMETRY_ENV_KEY]: "0" };

/** 扩列八枚（名对位 A 级 workflow §10 锚点：L168061/L168070/L168314/L172994/L170688/L170728/L56800/L256690）。 */
const WORKFLOW_EVENTS: readonly ScWorkflowTelemetryEventName[] = [
  "sc_workflow_agent_cap_exceeded",
  "sc_workflow_budget_cap_exceeded",
  "sc_workflow_journal_started_hit_respawn",
  "sc_workflow_launched",
  "sc_workflow_completed",
  "sc_workflow_phase_completed",
  "sc_workflow_usage_warning_accepted",
  "sc_workflow_keyword",
];

describe("WP-11 DoD① 扩列契约逐枚（sc_workflow_* 八名；facade.workflowEvent 家族语义方法 [自定]）", () => {
  it("八枚逐枚产生：名逐字、原语属性透传、信封字段齐备", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink, sessionId: "s-wp11" });
    for (const name of WORKFLOW_EVENTS) {
      f.workflowEvent(name, { key: "k1", count: 2, ok: true });
    }
    expect(sink.events.map((e) => e.event)).toEqual([...WORKFLOW_EVENTS]);
    for (const e of sink.events) {
      expect(e.properties).toEqual({ key: "k1", count: 2, ok: true });
      expect(e.sessionId).toBe("s-wp11");
      expect(typeof e.eventId).toBe("string");
      expect(typeof e.timestamp).toBe("number");
    }
  });
  it("缺省 properties=空对象（不抛）；扩列名编译期封闭（ScWorkflowTelemetryEventName ⊆ TelemetryEventName）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.workflowEvent("sc_workflow_launched");
    expect(sink.events[0]!.event).toBe("sc_workflow_launched");
    expect(sink.events[0]!.properties).toEqual({});
  });
  it("三分支有真实发射面：kernel cap/budget 与 journal hit 的 payload 形状经 facade 实收（桥接端到端见 capabilities wp11）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.workflowEvent("sc_workflow_agent_cap_exceeded", { agentCount: 3 });
    f.workflowEvent("sc_workflow_budget_cap_exceeded", { spent: 7, budget: 5, agentCount: 2 });
    f.workflowEvent("sc_workflow_journal_started_hit_respawn", { key: "wfkey-ab", agentId: "wfagent-x-1", attempts: 2 });
    expect(sink.events[0]!.properties).toEqual({ agentCount: 3 });
    expect(sink.events[1]!.properties).toEqual({ spent: 7, budget: 5, agentCount: 2 });
    expect(sink.events[2]!.properties).toEqual({ key: "wfkey-ab", agentId: "wfagent-x-1", attempts: 2 });
  });
});

describe("WP-11 DoD③ 脱敏=SEC-030 同一单源（扩列事件与七事件同一 emit 通路）", () => {
  it("workflowEvent 字符串属性经 redactSecrets（sk- 形状→SECRET_PLACEHOLDER）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.workflowEvent("sc_workflow_launched", { scriptPath: "run sk-abc123def456ghijk leaked" });
    expect(sink.events[0]!.properties.scriptPath).toBe(`run ${SECRET_PLACEHOLDER} leaked`);
  });
  it("门序复用 M5：env=0 凌驾/门关 emit 纯布尔即返（扩列事件同口径）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_OFF, settingsEnabled: true, sink });
    f.workflowEvent("sc_workflow_completed", { runId: "r1" });
    expect(sink.events).toHaveLength(0);
    expect(f.isEnabled()).toBe(false);
  });
});

describe("WP-11 DoD② 默认关零触盘（M5 WP-06 同口径）：扩列事件零构造零写盘", () => {
  it("缺省关：workflowEvent 全八枚后 sink 零事件、baseDir 下无 telemetry 目录", async () => {
    const base = mkdtempSync(join(tmpdir(), "sc-wp11-off-"));
    const facade = createTelemetryFacade({ env: {}, baseDir: base });
    for (const name of WORKFLOW_EVENTS) facade.workflowEvent(name, { key: "k" });
    await facade.flush();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(base, "telemetry"))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("WP-11 teams 扩位：subagentLaunch.refusedCode 语义扩位两枚（[CC] 五枚→两枚移植+三枚 CC-only 不移植）", () => {
  it("SUBAGENT_REFUSED_CODE_* 常量值逐字（[CC] missing_params L176967 / no_team_name L176974 的 outcome 语义扩位）", () => {
    expect(SUBAGENT_REFUSED_CODE_TEAMMATE_MISSING_PARAMS).toBe("teammate_missing_params");
    expect(SUBAGENT_REFUSED_CODE_TEAMMATE_NO_TEAM_NAME).toBe("teammate_no_team_name");
  });
  it("refused + 扩位码经既有 subagentLaunch 产生点发射（属性经脱敏单源；roster 校验拒绝点接线=未接线 F 项）", () => {
    const sink = memorySink();
    const f = createTelemetryFacade({ env: ENV_ON, sink });
    f.subagentLaunch({ outcome: "refused", refusedCode: SUBAGENT_REFUSED_CODE_TEAMMATE_MISSING_PARAMS });
    f.subagentLaunch({ outcome: "refused", refusedCode: SUBAGENT_REFUSED_CODE_TEAMMATE_NO_TEAM_NAME, agentType: "teammate" });
    expect(sink.events[0]!.event).toBe("sc_subagent_launch");
    expect(sink.events[0]!.properties.outcome).toBe("refused");
    expect(sink.events[0]!.properties.refusedCode).toBe("teammate_missing_params");
    expect(sink.events[1]!.properties.refusedCode).toBe("teammate_no_team_name");
  });
});
