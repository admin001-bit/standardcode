// MCP 三传输：stdio 子进程 / Streamable HTTP / legacy SSE（ORC-050 首批范围；ADR-0040 决策 4/5）。
// 内部扩展型（ws/sse-ide/sdk/claudeai-proxy）在 config 解析层已拒收，不到这里。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizeToolEnv } from "@standardcode/executor";
import type { McpServerConfig } from "./config.ts";
import type { McpTransport, JsonRpcMessage } from "./client.ts";
import { NdjsonFramer } from "./framer.ts";

/** HTTP 会话过期判据（形状逐字 dig-05 §6 :294700）。 */
export const MCP_SESSION_EXPIRED_RE = /Server not initialized|No valid session ID|Mcp-Session-Id header is required/i;

// —— stdio ——

export interface StdioEnvOptions {
  cwd: string;
  sessionId: string;
  /** 清洗基底（缺省 process.env——SEC-080 fail-closed 同面对齐：MCP server=第三方长驻进程）。 */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * stdio 子进程 env 装配（ADR-0040 决策 5）：
 * sanitizeToolEnv 清洗基底 → 会话级注入（STANDARD_CODE_* 显式白名单通道，先滤后注=唯一放行口）→ config.env 最后覆盖（声明式下沉）。
 * API key 不自动下沉：${VAR} 插值在 config 装载期已完成（config.ts），此处只拼装结果。
 */
export function buildStdioEnv(config: McpServerConfig & { type: "stdio" }, opts: StdioEnvOptions): NodeJS.ProcessEnv {
  const sanitized = sanitizeToolEnv(opts.baseEnv ?? process.env);
  return {
    ...sanitized.env,
    // 会话级注入（[CC] CLAUDE_PROJECT_DIR/CLAUDE_CODE_SESSION_ID/CLAUDECODE=1 同构，:299010-299021；键名 STANDARD_CODE_ 前缀 ADR-0007 [自定]）。
    STANDARD_CODE_PROJECT_DIR: opts.cwd,
    STANDARD_CODE_SESSION_ID: opts.sessionId,
    STANDARD_CODE_MCP: "1",
    ...(config.env ?? {}),
  };
}

export interface StdioTransportOptions extends StdioEnvOptions {
  config: McpServerConfig & { type: "stdio" };
  /** 单帧行上限字节（测试注入口；缺省 16MB=MCP_STDOUT_MAX_LINE_BYTES）。 */
  maxLineBytes?: number;
  /** stderr 尾部留存上限（失败诊断用，64MB :299034 上限的同构最小面 [自定] 取 8KB 尾）。 */
  stderrTailBytes?: number;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private framer: NdjsonFramer;
  private messageCb: ((m: JsonRpcMessage) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private closed = false;
  private stderrTail = "";

  constructor(private readonly opts: StdioTransportOptions) {
    this.framer = new NdjsonFramer(opts.maxLineBytes);
  }

  get childPid(): number | undefined {
    return this.child?.pid;
  }
  get stderrText(): string {
    return this.stderrTail;
  }

  start(): Promise<void> {
    const { config } = this.opts;
    // shell:false + windowsHide=true（形状 dig-05 §6 :35763-35764）。
    this.child = spawn(config.command, config.args ?? [], {
      cwd: this.opts.cwd,
      env: buildStdioEnv(config, this.opts),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const child = this.child;
    child.stdout.on("data", (chunk: Buffer) => {
      const frames = this.framer.push(chunk);
      for (const f of frames) this.messageCb?.(f as JsonRpcMessage);
      const of = this.framer.overflowError;
      if (of) this.terminate(of, true);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-(this.opts.stderrTailBytes ?? 8192));
    });
    child.on("error", (err) => this.terminate(err));
    child.on("exit", (code, signal) => {
      if (!this.closed) this.terminate(new Error(`MCP stdio server exited (code=${String(code)} signal=${String(signal)})`));
    });
    return Promise.resolve();
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.child || this.closed) throw new Error("MCP stdio transport not started/closed");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(JSON.stringify(msg) + "\n", (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child?.kill("SIGTERM");
  }

  private terminate(err: Error, force = false): void {
    if (this.closed) return;
    this.closed = true;
    if (force) this.child?.kill("SIGKILL");
    this.closeCb?.(err);
  }
}

// —— SSE 帧解析（text/event-stream，data 行集合→消息） ——

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseFrameParser {
  private buf = "";
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const ev = parseEventBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// —— Streamable HTTP ——

export interface HttpTransportOptions {
  config: McpServerConfig & { type: "http" };
  fetchImpl?: typeof fetch;
}

export class HttpTransport implements McpTransport {
  readonly kind = "http" as const;
  private messageCb: ((m: JsonRpcMessage) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private closed = false;
  private sessionId: string | null = null;
  /** 会话过期→重建钩子（client 侧接 initialize 重跑）；单次重试纪律在此执行（DoD⑦"重建后重试恰一次"）。 */
  onSessionExpired: (() => Promise<void>) | null = null;
  private reinitializing = false;
  sessionSeen = 0; // 可观测：会话重建次数

  constructor(private readonly opts: HttpTransportOptions) {}

  async start(): Promise<void> {
    // 惰性 POST——无需预连。
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP http transport closed");
    const first = await this.post(msg, false);
    if (first.kind === "expired" && !this.reinitializing && this.onSessionExpired) {
      // 重建一次：清会话→重握手→重发（仍过期=不可恢复，断连）。
      this.sessionId = null;
      this.reinitializing = true;
      try {
        await this.onSessionExpired();
      } finally {
        this.reinitializing = false;
      }
      this.sessionSeen++;
      const second = await this.post(msg, true);
      if (second.kind === "ok") return;
      const err = new Error(`MCP http session expired again after one recovery attempt: ${second.detail}`);
      this.terminate(err);
      throw err;
    }
    if (first.kind === "expired") {
      const err = new Error(`MCP http session expired (recovery unavailable): ${first.detail}`);
      this.terminate(err);
      throw err;
    }
  }

  private async post(msg: JsonRpcMessage, isRetry: boolean): Promise<{ kind: "ok" } | { kind: "expired"; detail: string }> {
    const f = this.opts.fetchImpl ?? fetch;
    const isRequest = "id" in msg;
    const res = await f(this.opts.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream", // 强制双 Accept（kGs :298468 形状）
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.opts.config.headers,
      },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if ((res.status === 404 || res.status === 400) && isRequest) {
      const text = await res.text().catch(() => "");
      if (MCP_SESSION_EXPIRED_RE.test(text)) return { kind: "expired", detail: `status=${res.status} body=${text.slice(0, 200)}${isRetry ? " (retry)" : ""}` };
      const err = new Error(`MCP http request rejected: status=${res.status} ${text.slice(0, 200)}`);
      this.terminate(err);
      throw err;
    }
    if (res.status === 202 || res.status === 204) return { kind: "ok" }; // 通知类
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`MCP http request failed: status=${res.status} ${text.slice(0, 200)}`);
      this.terminate(err);
      throw err;
    }
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (body.trim() !== "") {
      if (ct.includes("text/event-stream")) {
        for (const ev of new SseFrameParser().push(body.endsWith("\n\n") ? body : body + "\n\n")) {
          try {
            this.messageCb?.(JSON.parse(ev.data) as JsonRpcMessage);
          } catch {
            /* 非 JSON data 帧忽略 */
          }
        }
      } else {
        try {
          this.messageCb?.(JSON.parse(body) as JsonRpcMessage);
        } catch {
          const err = new Error(`MCP http response is not JSON (content-type=${ct})`);
          this.terminate(err);
          throw err;
        }
      }
    }
    return { kind: "ok" };
  }

  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  private terminate(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(err);
  }
}

// —— legacy SSE（2024-11-05 endpoint 流） ——

export interface SseTransportOptions {
  config: McpServerConfig & { type: "sse" };
  fetchImpl?: typeof fetch;
  /** endpoint 事件等待上限（ms）。 */
  endpointTimeoutMs?: number;
}

export class SseTransport implements McpTransport {
  readonly kind = "sse" as const;
  private messageCb: ((m: JsonRpcMessage) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private endpointUrl: URL | null = null;
  private endpointReady!: Promise<void>;
  private endpointResolve!: () => void;
  private endpointReject!: (e: Error) => void;
  private abort = new AbortController();
  private closed = false;

  constructor(private readonly opts: SseTransportOptions) {
    this.endpointReady = new Promise<void>((res, rej) => {
      this.endpointResolve = res;
      this.endpointReject = rej;
    });
  }

  async start(): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.endpointTimeoutMs ?? 30_000;
    const timer = setTimeout(() => this.endpointReject(new Error(`MCP sse endpoint event not received within ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const run = async () => {
      const res = await f(this.opts.config.url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...this.opts.config.headers },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`MCP sse connect failed: status=${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SseFrameParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(dec.decode(value, { stream: true }))) {
          if (ev.event === "endpoint") {
            this.endpointUrl = new URL(ev.data.trim(), this.opts.config.url);
            this.endpointResolve();
          } else if (ev.event === "message" || ev.event === undefined) {
            try {
              this.messageCb?.(JSON.parse(ev.data) as JsonRpcMessage);
            } catch {
              /* 忽略 */
            }
          }
        }
      }
      this.terminate(new Error("MCP sse stream closed"));
    };
    run().catch((e: unknown) => {
      this.endpointReject(e instanceof Error ? e : new Error(String(e)));
      this.terminate(e instanceof Error ? e : new Error(String(e)));
    });
    await this.endpointReady;
    clearTimeout(timer);
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed || !this.endpointUrl) throw new Error("MCP sse transport not ready/closed");
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.endpointUrl.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!res.ok) throw new Error(`MCP sse POST failed: status=${res.status}`);
  }

  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
  }
  private terminate(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.(err);
  }
}

export function makeTransport(config: McpServerConfig, opts: StdioEnvOptions & { fetchImpl?: typeof fetch; maxLineBytes?: number }): McpTransport {
  if (config.type === "stdio") return new StdioTransport({ config, ...opts, maxLineBytes: opts.maxLineBytes });
  if (config.type === "http") return new HttpTransport({ config, fetchImpl: opts.fetchImpl });
  return new SseTransport({ config, fetchImpl: opts.fetchImpl });
}
