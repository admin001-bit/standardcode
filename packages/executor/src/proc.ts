// L4 子进程运行核心：超时、中断、输出上限、进程树终止。
// 进程树终止语义与 harness tools.ts 同构（Windows taskkill /T、POSIX 进程组 SIGKILL）；
// POSIX 侧 spawn detached 使子进程自成进程组，-pid 才能命中整组。
import { spawn, type ChildProcess } from "node:child_process";

export interface RunProcessOptions {
  command: string;
  args: string[];
  /** true=参数原样拼接（Windows cmd.exe 场景），不做 MSVCRT 引号转义。 */
  verbatimArgs?: boolean;
  cwd?: string;
  /** 缺省不设超时；调用方按工具语义传入（Bash 120s、rg 20s——dig-03 实测锚点）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  registerProcess?(child: ChildProcess): void;
  /** 单流（stdout/stderr 各自）字符上限，超出即截断，防失控输出撑爆内存。 */
  maxOutputChars?: number;
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function killTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {}
}

export async function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    windowsHide: true,
    windowsVerbatimArguments: opts.verbatimArgs ?? false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  opts.registerProcess?.(child);

  const cap = opts.maxOutputChars ?? Number.POSITIVE_INFINITY;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const capInto = (sink: () => string, set: (v: string) => void, chunk: Buffer) => {
    if (sink().length >= cap) {
      truncated = true;
      return;
    }
    let next = sink() + chunk.toString("utf8");
    if (next.length > cap) {
      next = next.slice(0, cap);
      truncated = true;
    }
    set(next);
  };
  child.stdout!.on("data", (d: Buffer) => capInto(() => stdout, (v) => (stdout = v), d));
  child.stderr!.on("data", (d: Buffer) => capInto(() => stderr, (v) => (stderr = v), d));

  return await new Promise<RunProcessResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;
    const onAbort = () => killTree(child);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) =>
      settle(() => {
        if (truncated) {
          stdout += "\n[output truncated]";
          stderr += "\n[stderr truncated]";
        }
        resolve({ code, stdout, stderr, timedOut, truncated });
      }),
    );
  });
}
