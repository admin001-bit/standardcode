// L3 工具装配工厂：元数据 + executor 原语 → StandardTool（harness Tool 结构兼容——由集成测试锁形）。
// 每次调用产出绑定会话 cwd 的新实例，避免模块级单例状态。
import type { ExecEnv } from "@standardcode/executor";
import {
  execBash,
  execEdit,
  execGlob,
  execGrep,
  execRead,
  execWrite,
  type BashInput,
  type EditInput,
  type GlobInput,
  type GrepInput,
  type ReadInput,
  type WriteInput,
} from "@standardcode/executor";
import type { ToolContext } from "@standardcode/harness";
import type { StandardTool, ToolMetadata } from "./contract.ts";

export interface StandardToolsOptions {
  /** 会话工作目录：相对路径解析基点（缺省进程 cwd）。 */
  cwd?: string;
}

export function createStandardTools(opts: StandardToolsOptions = {}): StandardTool[] {
  const env: ExecEnv = { cwd: opts.cwd ?? process.cwd() };
  const bind = (def: ToolMetadata & { run(input: unknown, env: ExecEnv): Promise<string> }): StandardTool => ({
    ...def,
    // 中断信号与子进程注册逐调用并入 env（§8.4：工具 MUST 观察中断；harness 负责注册进程的树终止）
    execute: (input: unknown, ctx: ToolContext) => def.run(input, { ...env, signal: ctx.signal, registerProcess: ctx.registerProcess }),
  });
  return [bashTool(env), readTool(env), writeTool(env), editTool(env), globTool(env), grepTool(env)].map(bind);
}

// —— 执行类 ——

const bashTool = (env: ExecEnv) => ({
  name: "Bash",
  description:
    "Executes a shell command and returns combined stdout/stderr. Default timeout 120s, hard cap 600s (pass timeout in milliseconds to raise per-call); " +
    "output beyond 30k characters is truncated. Long-running commands must respect user interruption.",
  searchHint: "shell command execution",
  isConcurrencySafe: false,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "the shell command to execute" },
      timeout: { type: "integer", description: "optional timeout in ms (max 600000)" },
    },
  },
  run: (input: unknown) => execBash(input as BashInput, env),
});

// —— 文件类 ——

const readTool = (env: ExecEnv) => ({
  name: "Read",
  description:
    "Reads a file from the local filesystem as UTF-8 text with cat -n line numbers (default up to 2000 lines; overlong lines truncated). " +
    "Use offset/limit for paging. Binary files are rejected.",
  searchHint: "file reading, view file contents",
  isConcurrencySafe: true,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["file_path"],
    properties: {
      file_path: { type: "string", description: "absolute or session-cwd-relative path" },
      offset: { type: "integer", description: "1-based start line" },
      limit: { type: "integer", description: "max lines to read" },
    },
  },
  run: (input: unknown) => execRead(input as ReadInput, env),
});

const writeTool = (env: ExecEnv) => ({
  name: "Write",
  description: "Writes a file to the local filesystem, overwriting it if it exists (parent directories are created). Prefer Edit for changing existing files.",
  searchHint: "file creation, overwrite file",
  isConcurrencySafe: false,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["file_path", "content"],
    properties: {
      file_path: { type: "string", description: "absolute or session-cwd-relative path" },
      content: { type: "string", description: "full file content" },
    },
  },
  run: (input: unknown) => execWrite(input as WriteInput, env),
});

const editTool = (env: ExecEnv) => ({
  name: "Edit",
  description:
    "Replaces old_string with new_string in a file. Fails when old_string is not unique unless replace_all is set — include more surrounding context " +
    "to make it unique. Fails when old_string does not match exactly.",
  searchHint: "file editing, string replacement",
  isConcurrencySafe: false,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["file_path", "old_string", "new_string"],
    properties: {
      file_path: { type: "string", description: "absolute or session-cwd-relative path" },
      old_string: { type: "string", description: "exact text to replace" },
      new_string: { type: "string", description: "replacement text" },
      replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
    },
  },
  run: (input: unknown) => execEdit(input as EditInput, env),
});

// —— 搜索类 ——

const globTool = (env: ExecEnv) => ({
  name: "Glob",
  description:
    "Fast file pattern matching: returns up to 100 newest files matching a glob pattern (supports * and **), sorted by modification time. " +
    "Skips node_modules, .git and dot-directories.",
  searchHint: "file name pattern search",
  isConcurrencySafe: true,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "glob pattern relative to the search root, e.g. src/**/*.ts" },
      path: { type: "string", description: "optional root directory (default session cwd)" },
    },
  },
  run: (input: unknown) => execGlob(input as GlobInput, env),
});

const grepTool = (env: ExecEnv) => ({
  name: "Grep",
  description:
    "Content search backed by ripgrep (must be installed on PATH; on Windows: winget install BurntSushi.ripgrep.MSVC). " +
    "Supports regular expressions with output modes: content (default), files_with_matches, count.",
  searchHint: "content search, regex over files",
  isConcurrencySafe: true,
  deferred: false,
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "regular expression to search for" },
      path: { type: "string", description: "optional file or directory to search (default session cwd)" },
      include: { type: "string", description: "glob filter, e.g. *.ts" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "output shape (default content)" },
      case_insensitive: { type: "boolean", description: "case-insensitive matching" },
    },
  },
  run: (input: unknown) => execGrep(input as GrepInput, env),
});
