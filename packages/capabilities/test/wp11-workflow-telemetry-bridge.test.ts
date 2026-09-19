// M6-WP-11：workflow 遥测桥单测（映射表逐行 + 未知事件点名告警 + 非原语丢弃 + 注入/缺位语义）。
// 依赖纪律：capabilities 不依赖 platform（session.ts 装配层承担边界）→ 本文件只测桥接层；
// kernel/journal → 桥 → platform facade → sink 的端到端实收链见 apps/cli/test/wp11-workflow-telemetry.test.ts。
// kernel/journal 实现零触碰（只消费 onTelemetry callback 面）；不改 wp03-workflow-kernel.test.ts 断言一字。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_JOURNAL_HIT_EVENT,
} from "../src/workflow/journal.ts";
import {
  WORKFLOW_TELEMETRY_EVENT_MAP,
  createWorkflowTelemetryBridge,
  mapWorkflowTelemetryEvent,
} from "../src/workflow/telemetry-bridge.ts";

function recordingForward() {
  const calls: Array<{ event: string; payload: Record<string, string | number | boolean | undefined> }> = [];
  return { calls, forward: (event: string, payload: Record<string, string | number | boolean | undefined>) => { calls.push({ event, payload }); } };
}

describe("WP-11 桥接映射表逐行（tengu_workflow_* → sc_workflow_*；ADR-0007 前缀族同源）", () => {
  it("八行逐一命中（名对位 A 级 workflow §10 锚点 L168061/L168070/L168314/L172994/L170688/L170728/L56800/L256690）", () => {
    expect(Object.entries(WORKFLOW_TELEMETRY_EVENT_MAP)).toEqual([
      ["tengu_workflow_agent_cap_exceeded", "sc_workflow_agent_cap_exceeded"],
      ["tengu_workflow_budget_cap_exceeded", "sc_workflow_budget_cap_exceeded"],
      ["tengu_workflow_journal_started_hit_respawn", "sc_workflow_journal_started_hit_respawn"],
      ["tengu_workflow_launched", "sc_workflow_launched"],
      ["tengu_workflow_completed", "sc_workflow_completed"],
      ["tengu_workflow_phase_completed", "sc_workflow_phase_completed"],
      ["tengu_workflow_usage_warning_accepted", "sc_workflow_usage_warning_accepted"],
      ["tengu_workflow_keyword", "sc_workflow_keyword"],
    ]);
    for (const [from, to] of Object.entries(WORKFLOW_TELEMETRY_EVENT_MAP)) {
      expect(mapWorkflowTelemetryEvent(from)).toBe(to);
    }
  });
  it("未知事件（含云端 workflow_launch_* 族）→ null（调用方点名告警分支的判定面）", () => {
    expect(mapWorkflowTelemetryEvent("tengu_workflow_launch_remote")).toBeNull();
    expect(mapWorkflowTelemetryEvent("sc_workflow_agent_cap_exceeded")).toBeNull();
  });
});

describe("WP-11 桥接注入件：未知事件/非原语点名告警不静默（缺省回落分支覆盖非缺省形）", () => {
  it("未知事件 → 点名告警 + 零 forward（不静默吞）", () => {
    const { calls, forward } = recordingForward();
    const warns: string[] = [];
    const bridge = createWorkflowTelemetryBridge({ forward, warn: (m) => warns.push(m) });
    bridge("tengu_workflow_launch_remote", { runId: "r1" });
    expect(calls).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("tengu_workflow_launch_remote");
    expect(warns[0]).toContain("unmapped");
  });
  it("非原语属性值 → 点名告警 + 丢该键；原语键照常透传", () => {
    const { calls, forward } = recordingForward();
    const warns: string[] = [];
    const bridge = createWorkflowTelemetryBridge({ forward, warn: (m) => warns.push(m) });
    bridge("tengu_workflow_completed", { runId: "r1", nested: { a: 1 } });
    expect(calls).toEqual([{ event: "sc_workflow_completed", payload: { runId: "r1" } }]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("nested");
  });
  it("journal 原始常量名（WORKFLOW_JOURNAL_HIT_EVENT）在映射表内（journal.ts 零触碰的映射一致性）", () => {
    expect(mapWorkflowTelemetryEvent(WORKFLOW_JOURNAL_HIT_EVENT)).toBe("sc_workflow_journal_started_hit_respawn");
  });
  it("kernel cap 遥测原始名（tengu_workflow_agent_cap_exceeded，kernel.ts 行 339 裸名字面）在映射表内", () => {
    expect(mapWorkflowTelemetryEvent("tengu_workflow_agent_cap_exceeded")).toBe("sc_workflow_agent_cap_exceeded");
    expect(mapWorkflowTelemetryEvent("tengu_workflow_budget_cap_exceeded")).toBe("sc_workflow_budget_cap_exceeded");
  });
});
