// L3 能力层导出（v2.8 §5.2 capability-runtime 行：工具、Skill、Subagent、MCP、Hooks、Plugin——M1 六工具+注册表切片）。
export type { StandardTool, ToolMetadata, Tool, ToolContext } from "./contract.ts";
export { CapabilityRegistry } from "./registry.ts";
export { createStandardTools, type StandardToolsOptions } from "./tool-factory.ts";
