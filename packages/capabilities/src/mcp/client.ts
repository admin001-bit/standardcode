// MCP JSON-RPC 客户端：initialize 握手三步+协议版本校验+roots/list+服务器反向请求路由。
// 锚点：dig-05 §2.2（握手 SDK 层 :34887-34916；roots/list 处理器 :299101-299107；client name 构造 :299051-299053）。
// 协议版本面：不做 [CC] era 协商（自定义 server/discover RPC=规格外 B-03）；标准 MCP 修订版协商=SUPPORTED 列表
// 声明缺省最新，server 回非支持修订版=拒绝（DoD③"不支持修订版拒绝"）。

export type JsonRpcId = number | string;
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const isRequest = (m: JsonRpcMessage): m is JsonRpcRequest => "method" in m && "id" in m;
export const isNotification = (m: JsonRpcMessage): m is JsonRpcNotification => "method" in m && !("id" in m);
export const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m);

/** 传输抽象：帧级双向通道（stdio/Streamable HTTP/SSE 三实现 + 测试内存回放实现）。 */
export interface McpTransport {
  readonly kind: "stdio" | "sse" | "http";
  start(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  onMessage(cb: (msg: JsonRpcMessage) => void): void;
  /** 连接终态（关闭/溢出/会话不可恢复失败）。 */
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}

export interface McpRoot {
  uri: string;
  name?: string;
}

export const MCP_PROTOCOL_LATEST = "2025-06-18";
/** 支持的协议修订版（首元素=声明缺省）。2026-07-28=custom server/discover 面，不做（ADR-0040 决策 4）。 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export class McpProtocolError extends Error {}
export class McpTimeoutError extends Error {}

export interface InitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string; title?: string };
  instructions?: string;
}

export interface McpClientOptions {
  clientInfo: { name: string; version: string };
  /** roots/list 应答源（工作区根，:299101 同构）。 */
  listRoots?: () => McpRoot[];
  requestTimeoutMs?: number;
}

/** 反向请求可观测钩子（测试判据面；不影响协议行为）。 */
export interface McpClientObservability {
  onRootsListed?(roots: McpRoot[]): void;
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private messageCb: ((msg: JsonRpcMessage) => void) | null = null;
  private notificationCb: ((n: JsonRpcNotification) => void) | null = null;
  private notificationListeners: ((n: JsonRpcNotification) => void)[] = [];
  private activityCbs: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpClientOptions,
    private readonly obs?: McpClientObservability,
  ) {
    transport.onMessage((m) => this.route(m));
    transport.onClose((err) => this.failAll(err ?? new Error("MCP transport closed")));
  }

  get transportKind(): McpTransport["kind"] {
    return this.transport.kind;
  }

  onNotification(cb: (n: JsonRpcNotification) => void): void {
    this.notificationCb = cb;
  }

  /** WP-02：多监听（工具刷新/进度活动共享通知流；与单槽 onNotification 并行不斥）。 */
  addNotificationListener(cb: (n: JsonRpcNotification) => void): () => void {
    this.notificationListeners.push(cb);
    return () => {
      const i = this.notificationListeners.indexOf(cb);
      if (i >= 0) this.notificationListeners.splice(i, 1);
    };
  }

  /** WP-02 idle 计时复位源：任何入站帧（响应/通知/服务器请求）都算活动（DoD⑤"无响应/无 progress"形状）。 */
  onActivity(cb: () => void): () => void {
    this.activityCbs.push(cb);
    return () => {
      const i = this.activityCbs.indexOf(cb);
      if (i >= 0) this.activityCbs.splice(i, 1);
    };
  }

  async initialize(): Promise<InitializeResult> {
    const res = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_LATEST,
      capabilities: { roots: {} }, // roots capability 声明（:299051 client 构造同构，clientInfo 名=standardcode）
      clientInfo: this.opts.clientInfo,
    })) as InitializeResult;
    if (typeof res.protocolVersion !== "string" || !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(res.protocolVersion as (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number])) {
      throw new McpProtocolError(
        `MCP server negotiated unsupported protocol version ${String(res?.protocolVersion)}; this client supports: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }
    await this.notify("notifications/initialized");
    return res;
  }

  request(method: string, params?: unknown, reqOpts?: { signal?: AbortSignal }): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpTimeoutError(`MCP client closed; cannot send ${method}`));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // WP-02 取消面：abort→notifications/cancelled（MCP 标准帧）+本地拒绝；终态撤 listener。
      const signal = reqOpts?.signal;
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        void this.notify("notifications/cancelled", { requestId: id, reason: "user cancelled" }).catch(() => {});
        reject(new Error(`MCP request cancelled: ${method}`));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.transport.send(req).catch((e) => {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    const n: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    return this.transport.send(n);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP client closed"));
    await this.transport.close();
  }

  private route(msg: JsonRpcMessage): void {
    for (const cb of this.activityCbs) cb();
    this.messageCb?.(msg);
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return; // 迟到响应（已超时）：丢弃
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new McpProtocolError(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (isNotification(msg)) {
      this.notificationCb?.(msg);
      for (const l of this.notificationListeners) l(msg);
      return;
    }
    if (isRequest(msg)) void this.handleServerRequest(msg);
  }

  /** 服务器反向请求：ping/roots/list 支持，其余 method-not-found（-32601）。 */
  private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
    let resp: JsonRpcResponse;
    try {
      if (req.method === "ping") {
        resp = { jsonrpc: "2.0", id: req.id, result: {} };
      } else if (req.method === "roots/list") {
        const roots = this.opts.listRoots ? this.opts.listRoots() : [];
        this.obs?.onRootsListed?.(roots);
        resp = { jsonrpc: "2.0", id: req.id, result: { roots } };
      } else {
        resp = { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
    } catch (e) {
      resp = { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
    await this.transport.send(resp).catch(() => {});
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
