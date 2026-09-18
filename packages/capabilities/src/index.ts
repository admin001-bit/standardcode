// L3 能力层导出（v2.8 §5.2 capability-runtime 行：工具、Skill、Subagent、MCP、Hooks、Plugin——M1 六工具+注册表切片）。
export type { StandardTool, ToolMetadata, Tool, ToolContext } from "./contract.ts";
export { CapabilityRegistry } from "./registry.ts";
export { createStandardTools, type StandardToolsOptions } from "./tool-factory.ts";
// WP-03（M5）：沙箱宿主接线消费面 re-export（装配层 apps/cli 经本包取，executor 不直连）。
export {
  createSandboxHandle,
  resolveSandboxBinary,
  SandboxUnavailableError,
  SandboxExecError,
  policyFor,
  SANDBOX_TIERS,
  encodeFrame,
  decodeFrame,
  type SandboxHandle,
  type SandboxHandleInit,
  type SandboxTier,
  type SandboxExecRequest,
  type SandboxRunResult,
  type WireSandboxPolicy,
  execBash,
  execWrite,
  execEdit,
  type ExecEnv,
} from "@standardcode/executor";
// M4-WP-01：MCP 配置载体+客户端连接运行时（工具注入/信任门=WP-02/03）。
export * from "./mcp/index.ts";
// M4-WP-04：hooks 引擎（settings 配置源+事件编排+退出码/JSON 协议+聚合）。
export * from "./hooks/index.ts";
// M4-WP-05：skills（frontmatter+三源发现+清单预算+Skill 工具）。
export * from "./skills/index.ts";
// M6-WP-02：workflow vm 沙箱与脚本求值（ORC-023/024 行 295；DoD① 载体=逃逸测试集）。
export * from "./workflow/index.ts";
