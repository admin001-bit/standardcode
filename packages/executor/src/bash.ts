// L4 Bash 原语：shell 命令执行。超时/截断常量取 [CC] dig-03 §3 实测锚点（120000/600000/30000）。
// shell 选择 [自定]：Windows 用 cmd.exe（Git Bash 检测与 WSL 消歧非 M1 范围，可用 STANDARD_CODE_SHELL 显式指定 bash 类 shell），POSIX 用 /bin/sh。
import { ExecError, type ExecEnv } from "./env.ts";
import { runProcess, type RunProcessResult } from "./proc.ts";

export const BASH_TIMEOUT_DEFAULT_MS = 120_000;
export const BASH_TIMEOUT_MAX_MS = 600_000;
export const BASH_OUTPUT_TRUNCATE_CHARS = 30_000;

export interface BashInput {
  command: string;
  timeout?: number;
}

export async function execBash(input: BashInput, env: ExecEnv): Promise<string> {
  if (typeof input.command !== "string" || input.command.length === 0) throw new ExecError("command must be a non-empty string");
  const timeout = clampTimeout(input.timeout);
  const shell = resolveShell();
  let result: RunProcessResult;
  try {
    result = await runProcess({
      command: shell.command,
      args: shell.args.concat(shell.verbatim ? [`"${input.command}"`] : [input.command]),
      verbatimArgs: shell.verbatim,
      cwd: env.cwd,
      env: env.env,
      timeoutMs: timeout,
      signal: env.signal,
      registerProcess: env.registerProcess,
      maxOutputChars: BASH_OUTPUT_TRUNCATE_CHARS,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new ExecError(`shell not found: ${shell.command}`);
    throw err;
  }
  if (env.signal?.aborted) throw new ExecError("interrupted");
  if (result.timedOut) throw new ExecError(`command timed out after ${timeout}ms and was killed`);
  const output = result.stdout + (result.stderr ? (result.stdout ? "\n[stderr]\n" : "") + result.stderr : "");
  if (result.code !== 0) throw new ExecError(`exit code ${result.code}\n${output || "(no output)"}`);
  return output || "(no output)";
}

function clampTimeout(raw?: number): number {
  if (raw === undefined || Number.isNaN(raw)) return BASH_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.floor(raw), 1), BASH_TIMEOUT_MAX_MS);
}

// Windows：整条命令外层引号包裹 + verbatim 传参（Node child_process.exec 同款；/s 让 cmd 剥外层引号，
// 内嵌引号原样透传——否则 libuv 的 MSVCRT 转义会被 cmd 撕碎）。STANDARD_CODE_SHELL 覆盖按 bash 类 -c 语义。
function resolveShell(): { command: string; args: string[]; verbatim: boolean } {
  const override = process.env.STANDARD_CODE_SHELL;
  if (override) return { command: override, args: ["-c"], verbatim: false };
  return process.platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c"], verbatim: true } : { command: "/bin/sh", args: ["-c"], verbatim: false };
}
