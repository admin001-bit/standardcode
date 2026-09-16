// L4 Bash 原语：shell 命令执行。超时/截断常量取 [CC] dig-03 §3 实测锚点（120000/600000/30000）。
// shell 选择 [自定]：Windows 用 cmd.exe（Git Bash 检测与 WSL 消歧非 M1 范围，可用 STANDARD_CODE_SHELL 显式指定 bash 类 shell），POSIX 用 /bin/sh。
// WP-12（E2E②）：超限全文落盘+返回文本附 [CC] _440.js:5300 同构引用行（"Output truncated (NKB total). Full output saved to: <path>"）。
import { tmpdir } from "node:os";
import { ExecError, sanitizeToolEnv, type ExecEnv } from "./env.ts";
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
  if (env.sandbox) return execBashSandboxed(input, env, shell, timeout);
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
      spill: { dir: env.spillDir ?? tmpdir() }, // E2E②：超限全文落盘（引用行随返回文本）
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new ExecError(`shell not found: ${shell.command}`);
    throw err;
  }
  if (env.signal?.aborted) throw new ExecError("interrupted");
  if (result.timedOut) throw new ExecError(`command timed out after ${timeout}ms and was killed`);
  const output = result.stdout + (result.stderr ? (result.stdout ? "\n[stderr]\n" : "") + result.stderr : "");
  // WP-12（E2E②）：[CC] _440.js:5300 逐字形状引用行——"Output truncated (NKB total). Full output saved to: <path>"
  const spillNote =
    result.truncated && result.spillFile
      ? `\nOutput truncated (${Math.round((result.spillBytes ?? 0) / 1024)}KB total). Full output saved to: ${result.spillFile}`
      : "";
  if (result.code !== 0) throw new ExecError(`exit code ${result.code}\n${output || "(no output)"}${spillNote}`);
  return (output || "(no output)") + spillNote;
}

function clampTimeout(raw?: number): number {
  if (raw === undefined || Number.isNaN(raw)) return BASH_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.floor(raw), 1), BASH_TIMEOUT_MAX_MS);
}

/**
 * 沙箱臂（WP-03 DoD②）：shell 命令经 `standardcode-sandbox --serve` run 帧执行（档=handle
 * 持有 policy 单源）。形状保持：exit code / 30K 截断 / timedOut / interrupted 文案与直通臂同形。
 * [自定] 登记（供 V 判）：①spill 全文落盘不经沙箱臂（首版省略；工具层 cap 截断同位保持——
 * "沙箱不截断"由 server 全量 event 帧回传兑现，cap 截断是宿主语义）；②超时/中断=会话级
 * shutdown（server 进程终止=其沙箱子进程随 die-with-parent/OS 回收，per-request abort=不支持
 * 的同一决策，中断不变量 DoD⑧ 直通臂零回归另测）。
 * 接缝⑭：env 入沙箱前即 sanitizeToolEnv 产物（装配层清洗；此处缺席=现场清洗，禁"开沙箱即豁免"）。
 */
async function execBashSandboxed(input: BashInput, env: ExecEnv, shell: { command: string; args: string[]; verbatim: boolean }, timeout: number): Promise<string> {
  const sandbox = env.sandbox!;
  const cleaned = env.env ?? sanitizeToolEnv().env;
  const execEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleaned)) if (v !== undefined) execEnv[k] = v;
  const run = sandbox.run({
    program: shell.command,
    args: shell.args.concat(shell.verbatim ? [`"${input.command}"`] : [input.command]),
    cwd: env.cwd,
    env: execEnv,
  });
  run.catch(() => {}); // 输 race 时抑制 unhandled rejection（结果已由 timeout/interrupt 呈现）
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeouts = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      sandbox.shutdown();
      reject(new ExecError(`command timed out after ${timeout}ms and was killed`));
    }, timeout);
  });
  const interrupted = env.signal
    ? new Promise<never>((_, reject) => {
        env.signal!.addEventListener(
          "abort",
          () => {
            sandbox.shutdown();
            reject(new ExecError("interrupted"));
          },
          { once: true },
        );
      })
    : null;
  try {
    const result = await Promise.race(interrupted ? [run, timeouts, interrupted] : [run, timeouts]);
    let output = result.stdout + (result.stderr ? (result.stdout ? "\n[stderr]\n" : "") + result.stderr : "");
    let truncated = false;
    if (output.length > BASH_OUTPUT_TRUNCATE_CHARS) {
      output = output.slice(0, BASH_OUTPUT_TRUNCATE_CHARS);
      truncated = true;
    }
    const tail = truncated ? "\n[output truncated]" : "";
    if (result.exitCode !== 0) throw new ExecError(`exit code ${String(result.exitCode)}\n${output || "(no output)"}${tail}`);
    return (output || "(no output)") + tail;
  } catch (err) {
    if (env.signal?.aborted) throw new ExecError("interrupted");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Windows：整条命令外层引号包裹 + verbatim 传参（Node child_process.exec 同款；/s 让 cmd 剥外层引号，
// 内嵌引号原样透传——否则 libuv 的 MSVCRT 转义会被 cmd 撕碎）。STANDARD_CODE_SHELL 覆盖按 bash 类 -c 语义。
function resolveShell(): { command: string; args: string[]; verbatim: boolean } {
  const override = process.env.STANDARD_CODE_SHELL;
  if (override) return { command: override, args: ["-c"], verbatim: false };
  return process.platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c"], verbatim: true } : { command: "/bin/sh", args: ["-c"], verbatim: false };
}
