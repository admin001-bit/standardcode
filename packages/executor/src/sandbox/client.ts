// 沙箱服务器客户端（ARCH-008：TS ↔ Rust 唯一通道=stdio JSON 帧；禁 FFI）。
// 一会话一 server 进程（池首形 [自定]：装配期 lazy 拉起、多请求 id 复用）。
// fail-closed（B-12/DoD⑥）：二进制缺位/spawn 失败/握手不符/坏帧/error 帧=一律抛出，
// 调用方（bash/write 路由）呈现为执行失败，绝不回退未沙箱执行；server 死=会话沙箱终止
// 不自动重启（重启会静默吞掉策略语义变化，[自定] 登记）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { decodeFrame, encodeFrame, IPC_PROTOCOL_VERSION, type Frame } from "./codec.ts";
import { policyFor, type SandboxTier, type WireSandboxPolicy } from "./policy.ts";

export interface SandboxExecRequest {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 通道级失败（二进制缺位/拉起/握手/坏帧/断连）：宿主必须呈现为执行拒绝（DoD⑥）。 */
export class SandboxUnavailableError extends Error {}

/** 方法级执行拒绝（error 帧）：fail-closed 回灌面。 */
export class SandboxExecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** 二进制解析序（[自定] 键位登记走结果页，WP-07 先例形制）：显式参数 >
 * env STANDARD_CODE_SANDBOX_BIN > 仓形制探针（自本包向上找 target/release 再 target/debug
 * 的 standardcode-sandbox(.exe)——开发/CI 通道；npm 发布形态=BIN 随包路径=WP-07 义务）。 */
export function resolveSandboxBinary(explicit?: string): string {
  const exe = process.platform === "win32" ? "standardcode-sandbox.exe" : "standardcode-sandbox";
  // 显式参数=最高优先且不回退探针（DoD⑥：显式指向缺位文件=拒绝，探针"救活"=旁路用户意图）。
  if (explicit) {
    if (!existsSync(explicit)) throw new SandboxUnavailableError(`显式指定的沙箱二进制不存在：${explicit}——拒绝执行而非回退探针/未沙箱（B-12）`);
    return explicit;
  }
  const candidates: string[] = [];
  const envBin = process.env.STANDARD_CODE_SANDBOX_BIN;
  if (envBin) candidates.push(envBin);
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let up = 0; up < 8; up++) {
    candidates.push(path.join(dir, "target", "release", exe), path.join(dir, "target", "debug", exe));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new SandboxUnavailableError(`standardcode-sandbox 二进制未找到（显式/env/target 探针皆空）——沙箱拒绝启动而非未沙箱执行（B-12）`);
}

interface Pending {
  stdout: string[];
  stderr: string[];
  resolve: (r: SandboxRunResult) => void;
  reject: (e: Error) => void;
}

/** 帧协议服务器进程（内部类；消费方经 createSandboxHandle 以保 lazy 语义）。 */
class SandboxServer {
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handshake: Promise<void>;
  #dead = false;

  private constructor(binary: string, args: string[]) {
    this.#child = spawn(binary, [...args, "--serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onChunk(chunk));
    this.#child.stderr.resume(); // server 自身 stderr=诊断带，不并流
    this.#child.on("error", (err) => this.#die(new SandboxUnavailableError(`server spawn error: ${err.message}`)));
    this.#child.on("exit", (code) => this.#die(new SandboxUnavailableError(`server exited (code=${String(code)}) before response`)));
    this.#handshake = this.#handshakeOnce();
  }

  /** 同步 spawn（pid 立即可查=livePid 断言面）+ 独立 await 握手。 */
  static make(binary: string, args: string[] = []): SandboxServer {
    return new SandboxServer(binary, args);
  }

  handshake(): Promise<void> {
    return this.#handshake;
  }

  async #handshakeOnce(): Promise<void> {
    this.#child.stdin.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, kind: "hello", payload: { protocol: IPC_PROTOCOL_VERSION } }));
    const reply = await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxUnavailableError("握手超时（10s）——fail-closed 拒绝")), 10_000);
      this.#firstFrame = (f) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.#onDieBeforeHandshake = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    }).catch((e) => {
      this.kill();
      throw e;
    });
    if (reply.kind !== "hello" || (reply.payload as { protocol?: number } | undefined)?.protocol !== IPC_PROTOCOL_VERSION) {
      this.kill();
      throw new SandboxUnavailableError(`握手不符（${reply.kind}）——版本核对失败即关通道（ARCH-008 fail-closed）`);
    }
  }

  #firstFrame?: (f: Frame) => void;
  #onDieBeforeHandshake?: (e: Error) => void;

  #die(err: Error): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#onDieBeforeHandshake?.(err);
    this.#onDieBeforeHandshake = undefined;
  }

  #onChunk(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      let frame: Frame;
      try {
        frame = decodeFrame(line);
      } catch (e) {
        // 坏帧=关通道（不得跳帧续读——与 Rust 端同纪律）。
        this.kill();
        this.#die(new SandboxUnavailableError(`坏帧，关闭沙箱通道: ${(e as Error).message}`));
        return;
      }
      if (frame.kind === "hello") {
        this.#firstFrame?.(frame);
        this.#firstFrame = undefined;
        continue;
      }
      this.#route(frame);
    }
  }

  #route(frame: Frame): void {
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.kind === "event") {
      const data = (payload.data ?? {}) as { reqId?: number; stream?: string; data?: string };
      const p = data.reqId !== undefined ? this.#pending.get(data.reqId) : undefined;
      if (p && typeof data.data === "string") {
        if (data.stream === "stdout") p.stdout.push(data.data);
        else if (data.stream === "stderr") p.stderr.push(data.data);
      }
      return;
    }
    if (frame.id === undefined) return;
    const p = this.#pending.get(frame.id);
    if (!p) return;
    this.#pending.delete(frame.id);
    if (frame.kind === "error") {
      p.reject(new SandboxExecError(String(payload.code ?? "unknown"), String(payload.message ?? "")));
      return;
    }
    if (frame.kind === "response") {
      const result = (payload.result ?? {}) as { exitCode?: number | null };
      p.resolve({ exitCode: result.exitCode ?? null, stdout: p.stdout.join(""), stderr: p.stderr.join("") });
      return;
    }
    p.reject(new SandboxUnavailableError(`意外帧类型 ${frame.kind}（id=${frame.id}）`));
  }

  request(method: string, params: unknown): Promise<SandboxRunResult> {
    if (this.#dead) return Promise.reject(new SandboxUnavailableError("server 已终止（不自动重启）"));
    if (!this.#child.stdin.writable) return Promise.reject(new SandboxUnavailableError("server 通道已关（EOF/关闭中），拒绝新请求"));
    const id = this.#nextId++;
    const promise = new Promise<SandboxRunResult>((resolve, reject) => {
      this.#pending.set(id, { stdout: [], stderr: [], resolve, reject });
    });
    this.#child.stdin.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, kind: "request", id, payload: { method, params } }), (err) => {
      if (err) {
        this.#pending.get(id)?.reject(new SandboxUnavailableError(`写帧失败: ${err.message}`));
        this.#pending.delete(id);
      }
    });
    return promise;
  }

  kill(): void {
    try {
      this.#child.kill();
    } catch {}
  }

  get pid(): number {
    return this.#child.pid ?? 0;
  }

  /** 正常关闭：stdin EOF=server 会话结束退出（Rust serve EOF 臂）。 */
  async close(): Promise<void> {
    if (this.#dead) return;
    this.#child.stdin.end();
    await new Promise<void>((resolve) => {
      this.#child.on("exit", () => resolve());
      const t = setTimeout(() => {
        this.kill();
        resolve();
      }, 5000);
      this.#child.once("exit", () => clearTimeout(t));
    });
  }

  get exited(): boolean {
    return this.#dead || !this.#child.stdin.writable;
  }
}

export interface SandboxHandle {
  readonly tier: SandboxTier;
  /** 当前策略 wire（单源=handle 持有；bash/write 路由共用同一档）。 */
  policy(): WireSandboxPolicy;
  run(exec: SandboxExecRequest): Promise<SandboxRunResult>;
  /** 沙箱内文件写（DoD② 文件写经沙箱载体）。 */
  writeViaSandbox(absPath: string, content: string): Promise<void>;
  /** 已拉起 server 的 pid（未拉起=null——DoD①"零沙箱子进程拉起"断言面）。 */
  livePid(): number | null;
  /** workspace-write 根（repl /cd 换目录随形）。 */
  root(): string;
  /** 换根重建 wire policy（server 无根状态=policy 随请求 wire 下传；零重启）。 */
  setRoot(absPath: string): void;
  shutdown(): void;
  close(): Promise<void>;
}

export interface SandboxHandleInit {
  tier: SandboxTier;
  workspaceRoot: string;
  binaryPath?: string;
  /** 二进制前置参数（[自定] 测试载体：node + fake .mjs；生产缺省=无参直起 --serve）。 */
  binaryArgs?: string[];
}

export function createSandboxHandle(init: SandboxHandleInit): SandboxHandle {
  let policy = policyFor(init.tier, init.workspaceRoot);
  let currentRoot = init.workspaceRoot;
  let srvRef: SandboxServer | null = null;
  let shutting = false;
  async function ensure(): Promise<SandboxServer> {
    if (shutting) throw new SandboxUnavailableError("沙箱会话已终止（shutdown 后拒绝再执行，不回退未沙箱）");
    if (!srvRef) {
      // lazy：拉起在首次执行时（装配期零进程=DoD① 字面判据）。
      const s = SandboxServer.make(resolveSandboxBinary(init.binaryPath), init.binaryArgs ?? []);
      try {
        await s.handshake();
      } catch (e) {
        s.kill();
        throw e instanceof SandboxUnavailableError ? e : new SandboxUnavailableError(String((e as Error).message));
      }
      srvRef = s;
    }
    return srvRef;
  }
  return {
    tier: init.tier,
    policy: () => policy,
    run: async (exec) => (await ensure()).request("run", { exec, policy }),
    writeViaSandbox: async (absPath, content) => {
      const r = await (await ensure()).request("fsWrite", { path: absPath, content, policy });
      if (r.exitCode !== 0) {
        throw new SandboxExecError("fs_write_failed", `沙箱内写失败 exit=${String(r.exitCode)}：${(r.stderr || r.stdout).trim() || "(无诊断输出)"}`);
      }
    },
    livePid: () => srvRef?.pid ?? null,
    root: () => currentRoot,
    setRoot: (absPath) => {
      currentRoot = absPath;
      policy = policyFor(init.tier, absPath);
    },
    shutdown: () => {
      shutting = true;
      srvRef?.kill();
    },
    close: async () => {
      shutting = true;
      const s = srvRef;
      srvRef = null;
      if (s) await s.close();
    },
  };
}
