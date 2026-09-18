// WP-06（M6）teammate 提示词附录与层级限制单测（DoD⑤：teammate 上下文 Agent 工具移除 name 参数）。
// 依据 A 级 `claude-code-agent-teams.md` §7（L175543-175552 TEAMMATE_SYSTEM_PROMPT_ADDENDUM 逐字）
// 与 §7.1（L160636 "teammates cannot spawn other teammates" 逐字）。
import { describe, expect, it } from "vitest";
import {
  restrictSpawnToolForTeammate,
  restrictToolsForTeammate,
  TEAMMATE_AGENT_TOOL_NAME_NOTE,
  TEAMMATE_SPAWN_TOOL_NAMES,
  TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
} from "../src/index.ts";

/** A 级 §7 L175544-175552 的独立誊录（逐字比对基准，非引用实现常量）。 */
const EXPECTED_ADDENDUM = [
  "",
  "# Agent Teammate Communication",
  "",
  'IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team, use the SendMessage tool with `to: "<name>"` to send messages to specific teammates.',
  "",
  "Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.",
  "",
  "The user interacts primarily with the team lead. Your work is coordinated through the task system and teammate messaging.",
  "",
].join("\n");

function agentTool() {
  return {
    name: "Agent",
    description: "Spawn a subagent to handle a task.",
    inputSchema: {
      type: "object",
      required: ["prompt", "name"],
      properties: {
        prompt: { type: "string", description: "task" },
        name: { type: "string", description: "Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running." },
        plan_mode_required: { type: "boolean" },
      },
    },
  };
}

describe("DoD⑤ teammate 提示词附录（A 级 §7 逐字）", () => {
  it("与独立誊录逐字相等", () => {
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toBe(EXPECTED_ADDENDUM);
  });

  it("三个承重句在位（纯文本不可见/沟通必须调工具/用户只与 lead 对话）", () => {
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain("is not visible to others on your team");
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain("you MUST use the SendMessage tool.");
    expect(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).toContain("The user interacts primarily with the team lead.");
  });

  it("name 参数逐字说明与 A 级 §7.1 相等", () => {
    expect(TEAMMATE_AGENT_TOOL_NAME_NOTE).toBe(
      "- The name parameter is not available in this context — teammates cannot spawn other teammates. Omit it to spawn a subagent.",
    );
  });
});

describe("DoD⑤ 层级限制：teammate 上下文的 Agent 工具移除 name 参数", () => {
  it("派生类工具名为 Agent（层级 main → teammate → subagent）", () => {
    expect([...TEAMMATE_SPAWN_TOOL_NAMES]).toEqual(["Agent"]);
  });

  it("Agent 工具：name 属性被移除、required 去掉 name、描述追加逐字说明", () => {
    const restricted = restrictSpawnToolForTeammate(agentTool());
    expect(Object.keys(restricted.inputSchema.properties ?? {})).toEqual(["prompt", "plan_mode_required"]);
    expect(restricted.inputSchema.required).toEqual(["prompt"]);
    expect(restricted.description.endsWith(TEAMMATE_AGENT_TOOL_NAME_NOTE)).toBe(true);
  });

  it("不改入参（纯变换返回新对象）", () => {
    const original = agentTool();
    const restricted = restrictSpawnToolForTeammate(original);
    expect(restricted).not.toBe(original);
    expect(Object.keys(original.inputSchema.properties ?? {})).toContain("name");
    expect(original.description).not.toContain("teammates cannot spawn other teammates");
  });

  it("非派生工具原样返回（引用相等，零改动）", () => {
    const readTool = { name: "Read", description: "read", inputSchema: { type: "object", required: ["file_path"], properties: { file_path: { type: "string" } } } };
    expect(restrictSpawnToolForTeammate(readTool)).toBe(readTool);
  });

  it("批量施加：只作用于 Agent，其余引用不变", () => {
    const readTool = { name: "Read", description: "read", inputSchema: { type: "object", required: ["file_path"], properties: { file_path: { type: "string" } } } };
    const result = restrictToolsForTeammate([agentTool(), readTool]);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(readTool);
    expect(Object.keys(result[0]!.inputSchema.properties ?? {})).not.toContain("name");
  });
});
