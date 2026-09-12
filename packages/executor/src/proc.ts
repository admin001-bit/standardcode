// L4 子进程运行核心：超时、中断、输出上限、进程树终止、env 清洗缺省（SEC-080）、超限全文落盘（E2E② 面）。
// 进程树终止语义与 harness tools.ts 同构（Windows taskkill /T、POSIX 进程组 SIGKILL）；
// POSIX 侧 spawn detached 使子进程自成进程组，-pid 才能命中整组。
// 落盘回传（v2.8 §12.2 E2E②"30K 截断+落盘回传"的行为载体；[CC] _440.js:5279-5300 stdoutToFile 同构：
// 全文（stdout 原样+[stderr] 前缀标注混流，到达序）写 spill 文件，返回文本附 KB 汇总+路径行）。
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeToolEnv, type ToolEnvSnapshot } from "./env.ts";

export interface RunProcessOptions {
  command: string;
  args: string[];
  /** true=参数原样拼接（Windows cmd.exe 场景），不做 MSVCRT 引号转义。 */
  verbatimArgs?: boolean;
  cwd?: string;
  /** 子进程环境（显式）；缺席=现场 sanitizeToolEnv() 清洗（隐式缺省，fail-closed——密钥/注入键不下沉）。 */
  env?: NodeJS.ProcessEnv;
  /** 缺省不设超时；调用方按工具语义传入（Bash 120s、rg 20s——dig-03 实测锚点）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  registerProcess?(child: ChildProcess): void;
  /** 单流（stdout/stderr 各自）字符上限，超出即截断，防失控输出撑爆内存。 */
  maxOutputChars?: number;
  /**
   * 超限全文落盘开关（E2E② 行为载体；WP-12 接线=bash.ts）：截断发生时，全量输出（含截断前已收头部）
   * 写 <dir>/standardcode-tool-output-<pid>-<ts>.txt（stdout 原样、stderr 加 "[stderr] " 前缀，到达序混流——
   * [CC] #f 同构）。缺省=不落盘（截断即丢，M1 行为兼容）。
   */
  spill?: { dir: string };
}

export interface RunProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** 本次子进程 env 快照（SEC-080"debug 模式可查"的实体位：env=下发项/removed=剔除项/strippedBy=命中规则）。 */
  envSnapshot: ToolEnvSnapshot;
  /** 超限全文落盘文件路径（spill 开启且截断发生时在位；E2E②"落盘回传"引用面）。 */
  spillFile?: string;
  /** 落盘全文字节量（KB 汇总行数据源）。 */
  spillBytes?: number;
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
  // env 清洗（SEC-080）：显式下发项按其现状做快照归因；隐式缺省现场清洗 process.env（fail-closed）。
  const envSnapshot: ToolEnvSnapshot = opts.env !== undefined ? { env: opts.env, removed: [], strippedBy: [] } : sanitizeToolEnv();
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: envSnapshot.env,
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
  // 超限全文落盘（E2E② 行为载体；[CC] _440.js:5279-5300 stdoutToFile/#f 同构）：截断后余部（含 stderr
  // 的 "[stderr] " 前缀混流，到达序）追加写 spill 文件；首个截断事件时先补写已收头部，保证文件=全量输出。
  let spillStream: WriteStream | null = null;
  let spillFile: string | undefined;
  let spillBytes = 0;
  if (opts.spill) {
    spillFile = path.join(opts.spill.dir, `standardcode-tool-output-${process.pid}-${Date.now()}.txt`);
    spillStream = createWriteStream(spillFile, { encoding: "utf8" });
  }
  const headWritten = { out: false, err: false };
  const spillWrite = (tag: "out" | "err", text: string) => {
    if (!spillStream || text === "") return;
    const s = tag === "err" ? `[stderr] ${text}` : text;
    spillBytes += Buffer.byteLength(s, "utf8");
    spillStream.write(s);
  };
  const capInto = (tag: "out" | "err", sink: () => string, set: (v: string) => void, chunk: Buffer) => {
    const cur = sink();
    const spillHead = () => {
      if (!headWritten[tag] && cur !== "") { // 空 head 不置位——首 chunk 即越界时，头部由后续触发补写
        spillWrite(tag, cur); // 全文完整性：截断前已收头部入档
        headWritten[tag] = true;
      }
    };
    if (cur.length >= cap) {
      truncated = true;
      spillHead();
      spillWrite(tag, chunk.toString("utf8"));
      return;
    }
    const next = cur + chunk.toString("utf8");
    if (next.length > cap) {
      set(next.slice(0, cap));
      truncated = true;
      spillHead();
      spillWrite(tag, next.slice(cap));
      return;
    }
    set(next);
  };
  child.stdout!.on("data", (d: Buffer) => capInto("out", () => stdout, (v) => (stdout = v), d));
  child.stderr!.on("data", (d: Buffer) => capInto("err", () => stderr, (v) => (stderr = v), d));
  const drainSpill = (): Promise<void> =>
    spillStream
      ? new Promise((res) => {
          spillStream!.end(() => res());
          spillStream = null;
        })
      : Promise.resolve();

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
    const settle = (fn: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void fn();
    };
    child.on("error", (err) =>
      settle(async () => {
        await drainSpill();
        reject(err);
      }),
    );
    child.on("close", (code) =>
      settle(async () => {
        if (truncated) {
          stdout += "\n[output truncated]";
          stderr += "\n[stderr truncated]";
        }
        await drainSpill();
        resolve({
          code,
          stdout,
          stderr,
          timedOut,
          truncated,
          envSnapshot,
          ...(truncated && spillFile ? { spillFile, spillBytes } : {}),
        });
      }),
    );
  });
}
