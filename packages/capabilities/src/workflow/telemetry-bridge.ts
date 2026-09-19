// M6-WP-11：workflow 遥测桥（ENG-090 基线扩列的产生点接线面）。
//
// 形制（卡 §4 设计口径 2，X 裁量落 capabilities/workflow 侧）：kernel.ts / journal.ts 的 `onTelemetry`
// 回调发射 [CC] 原名 `tengu_workflow_*`（本卡不碰 kernel/journal 实现——它们已有 callback 面）；
// 本模块做 **名称映射表** + `createWorkflowTelemetryBridge` 注入件：`"tengu_workflow_*" → "sc_workflow_*"`
// （ADR-0007 前缀族同源映射，平台侧 TelemetryEventName 扩列八名，[CC] 名只口径注不抄名）。
//
// 锚点（A 级 claude-code-workflow.md §10 行 428-441）：agent_cap_exceeded L168061 / budget_cap_exceeded
// L168070 / journal_started_hit_respawn L168314（journal.ts WORKFLOW_JOURNAL_HIT_EVENT 同名）/ launched
// L172994 / completed L170688 / phase_completed L170728 / usage_warning_accepted L56800 / keyword L256690。
//
// 边界与登记：
//   - 当前无 workflow runner 生产构造点（progress.ts 行 296 注：编排装配层 WP-07+）→ 生产装配位
//     （workflow flag 活跃时把本桥注入 kernel/journal 的 onTelemetry、forward 接 platform facade
//     `workflowEvent`）= **未接线 F 项**（与 WP-09 F2 同族形制）；本模块+单测证明映射正确。
//   - 云端/远程 workflow 的 `workflow_launch_*` 族=非目标（B-03，BLK 同族）→ 落入未知事件分支：**点名告警
//     不静默**（禁静默吞，卡 §6 判据）。
//   - 依赖纪律：capabilities 不依赖 platform（session.ts 装配层承担边界）→ forward 由调用方注入，
//     本模块不 import platform；payload 只透传原语（TelemetryProps 闸），非原语值丢弃并**点名告警**。
//   - 脱敏不在本层做：forward 接 facade `workflowEvent` 后经 sanitizeProps（redactSecrets 单源，
//     接缝⑮ 禁复制）——桥接零脱敏实现。

/** [CC] `tengu_workflow_*` → 本仓 `sc_workflow_*` 映射表（八行逐一对应 platform 扩列契约；逐行单测）。
 * as const：值=字面量类型（与 platform ScWorkflowTelemetryEventName 八名结构同形，装配面零断言桥接）。 */
export const WORKFLOW_TELEMETRY_EVENT_MAP = {
  "tengu_workflow_agent_cap_exceeded": "sc_workflow_agent_cap_exceeded",
  "tengu_workflow_budget_cap_exceeded": "sc_workflow_budget_cap_exceeded",
  "tengu_workflow_journal_started_hit_respawn": "sc_workflow_journal_started_hit_respawn",
  "tengu_workflow_launched": "sc_workflow_launched",
  "tengu_workflow_completed": "sc_workflow_completed",
  "tengu_workflow_phase_completed": "sc_workflow_phase_completed",
  "tengu_workflow_usage_warning_accepted": "sc_workflow_usage_warning_accepted",
  "tengu_workflow_keyword": "sc_workflow_keyword",
} as const;

/** 扩列八名的 sc 侧字面量联合（与 platform TelemetryEventName 扩列子集结构同形）。 */
export type ScWorkflowTelemetryEventName = (typeof WORKFLOW_TELEMETRY_EVENT_MAP)[keyof typeof WORKFLOW_TELEMETRY_EVENT_MAP];

/** forward 注入面（装配层接 platform facade.workflowEvent；结构化最小面，不 import platform）。 */
export type WorkflowTelemetryForward = (
  event: ScWorkflowTelemetryEventName,
  payload: Record<string, string | number | boolean | undefined>,
) => void;

/** 名称映射（纯函数）：命中返回 sc 名；未知（含云端 workflow_launch_* 族）返回 null=调用方点名告警。 */
export function mapWorkflowTelemetryEvent(event: string): ScWorkflowTelemetryEventName | null {
  return (WORKFLOW_TELEMETRY_EVENT_MAP as Readonly<Record<string, ScWorkflowTelemetryEventName>>)[event] ?? null;
}

export interface CreateWorkflowTelemetryBridgeOptions {
  /** 发射落点（装配层：`(name, props) => facade.workflowEvent(name, props)`；测试=记录 spy）。 */
  forward: WorkflowTelemetryForward;
  /** 告警（未知事件 / 非原语属性丢弃；缺省=stderr 点名——禁静默）。 */
  warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* 告警通道本身绝不致 workflow 失败 */
  }
}

function isTelemetryPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * 构造 kernel/journal `onTelemetry` 注入件（装配位：workflow flag 活跃时传入
 * createWorkflowOrchestrator / withWorkflowJournal 的 onTelemetry；flag 关=不注入=零事件产出，接缝㉑）。
 * - 映射命中 → 原语化 payload 后 forward（脱敏由 facade 层 sanitizeProps 单源承担，本层不复制）。
 * - 未知事件 → 点名告警 + 丢弃（不 forward、不静默）。
 * - 非原语属性值 → 点名告警 + 丢弃该键（TelemetryProps 原语闸；其余键照常透传）。
 */
export function createWorkflowTelemetryBridge(
  options: CreateWorkflowTelemetryBridgeOptions,
): (event: string, payload: Record<string, unknown>) => void {
  const warn = options.warn ?? defaultWarn;
  return (event, payload) => {
    const mapped = mapWorkflowTelemetryEvent(event);
    if (mapped === null) {
      warn(`workflow telemetry bridge: unmapped event "${event}" dropped (not in ENG-090 M6 baseline)`);
      return;
    }
    const props: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isTelemetryPrimitive(value)) props[key] = value;
      else warn(`workflow telemetry bridge: non-primitive property "${key}" on "${event}" dropped`);
    }
    options.forward(mapped, props);
  };
}
