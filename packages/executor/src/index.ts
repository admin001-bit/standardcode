// L4 执行底座导出（v2.8 §5.2 executor 行：命令执行、文件读写）。
export {
  ExecError,
  type ExecEnv,
  sanitizeToolEnv,
  TOOL_ENV_STRIP_RULES,
  type ToolEnvSnapshot,
  type ToolEnvStripRule,
} from "./env.ts";
export { runProcess, killTree, type RunProcessOptions, type RunProcessResult } from "./proc.ts";
export {
  execBash,
  BASH_TIMEOUT_DEFAULT_MS,
  BASH_TIMEOUT_MAX_MS,
  BASH_OUTPUT_TRUNCATE_CHARS,
  type BashInput,
} from "./bash.ts";
export { execRead, READ_DEFAULT_LIMIT, type ReadInput } from "./read.ts";
export { execWrite, type WriteInput } from "./write.ts";
export { execEdit, type EditInput } from "./edit.ts";
export { execGlob, GLOB_MAX_RESULTS, type GlobInput } from "./glob.ts";
export {
  execGrep,
  GREP_TIMEOUT_MS,
  GREP_MAX_RESULTS,
  type GrepInput,
} from "./grep.ts";
