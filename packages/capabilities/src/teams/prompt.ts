// M6-WP-06：teammate 系统提示词附录（交付物第四件）+ 层级限制（DoD⑤）。
//
// 逐字锚点（A 级 `claude-code-agent-teams.md`）：
//   §7 `TEAMMATE_SYSTEM_PROMPT_ADDENDUM`（变量 `YMt`，L175543-175552，**逐字**）
//   §7.1 teammate 不能再 spawn teammate（L160636 逐字）："- The name parameter is not available in this context —
//        teammates cannot spawn other teammates. Omit it to spawn a subagent."
//        → 层级被限制为 main → teammate → (subagent)。
//
// [自定] 口径（供 V 核验）：本仓当前**无 `Agent` 工具**（subagent 派生走 `/subtask` 命令 + `spawnSubagent` 程序面，
// 见 packages/harness/src/subagent.ts），故 DoD⑤ 以"工具定义 → 工具定义"的**纯变换**交付（去 `name` 参数 + 附逐字
// 说明），接线点随 M6-WP-10（fork 型 subagent 装配）或 M7 的 Agent 工具落地——不在本卡伪造一个 Agent 工具。

/** teammate 上下文系统提示词附录（A 级 §7 L175544-175552 **逐字**，含行首换行）。 */
export const TEAMMATE_SYSTEM_PROMPT_ADDENDUM = `
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team, use the SendMessage tool with \`to: "<name>"\` to send messages to specific teammates.

Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.

The user interacts primarily with the team lead. Your work is coordinated through the task system and teammate messaging.
`;

/** teammate 上下文里对派生参数的逐字说明（A 级 §7.1 L160636）。 */
export const TEAMMATE_AGENT_TOOL_NAME_NOTE =
  "- The name parameter is not available in this context — teammates cannot spawn other teammates. Omit it to spawn a subagent.";

/** teammate 上下文必须被剥夺 `name` 参数的派生工具名（层级限制 main → teammate → subagent）。 */
export const TEAMMATE_SPAWN_TOOL_NAMES: readonly string[] = ["Agent"];

export interface TeammateToolDefinitionLike {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    required?: readonly string[];
    properties?: Record<string, unknown>;
  };
}

/**
 * teammate 上下文工具面变换（DoD⑤）：派生类工具的 `name` 参数被移除，描述追加逐字说明。
 * 非派生工具原样返回（零改动）；返回新对象，不改入参。
 */
export function restrictSpawnToolForTeammate<T extends TeammateToolDefinitionLike>(tool: T): T {
  if (!TEAMMATE_SPAWN_TOOL_NAMES.includes(tool.name)) return tool;
  const { name: _removed, ...restProps } = tool.inputSchema.properties ?? {};
  const required = (tool.inputSchema.required ?? []).filter((key) => key !== "name");
  return {
    ...tool,
    description: `${tool.description}\n${TEAMMATE_AGENT_TOOL_NAME_NOTE}`,
    inputSchema: {
      ...tool.inputSchema,
      required,
      properties: restProps,
    },
  } as T;
}

/** 批量施加（teammate 会话的工具装配面）。 */
export function restrictToolsForTeammate<T extends TeammateToolDefinitionLike>(tools: readonly T[]): T[] {
  return tools.map((tool) => restrictSpawnToolForTeammate(tool));
}

/**
 * Teams 协议使用规范（A 级 §6.4 两条，[自定] 措辞，注明非逐字）：
 *   ① 不得主动发起 `shutdown_request`（除非被要求）；
 *   ② 不得发结构化 JSON 状态消息——进度用任务工具或纯文本汇报。
 * 落提示词供 teammate 遵循（WP-08 交付物第四件）。
 */
export const TEAMS_PROTOCOL_USAGE_RULES = `
# Teams Protocol Usage Rules

- Do NOT proactively send a \`shutdown_request\` unless you are explicitly asked to shut down. (A-level §6.4)
- Do NOT send structured JSON status messages over SendMessage. Report progress through your task tools if you have them, otherwise in plain prose. (A-level §6.4)
`;

/**
 * 组合 teammate 系统提示词：既有 addendum（[CC] 逐字常量，本体零改动）+ 协议使用规范。
 * 返回**新串**，不修改 `TEAMMATE_SYSTEM_PROMPT_ADDENDUM` 常量本体。
 */
export function composeTeammateSystemPrompt(
  addendum: string = TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
  rules: string = TEAMS_PROTOCOL_USAGE_RULES,
): string {
  return `${addendum}\n${rules}`;
}
