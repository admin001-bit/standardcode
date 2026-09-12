// WP-01 客户端握手契约回放（DoD③/④：initialize 三步+协议版本拒绝+roots/list+反向路由；
// 帧夹具=内存脚本传输，零子进程确定性回放）。
import { describe, expect, it } from "vitest";
import { McpClient, McpProtocolError, McpTimeoutError, type JsonRpcMessage, type McpTransport } from "../src/index.ts";

class MemTransport implements McpTransport {
  readonly kind = "stdio" as const;
  sent: JsonRpcMessage[] = [];
  private msgCb: ((m: JsonRpcMessage) => void) | null = null;
  private closeCb: ((e?: Error) => void) | null = null;
  started = false;
  closed = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async send(msg: JsonRpcMessage): Promise<void> {
    this.sent.push(msg);
  }
  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (e?: Error) => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  inject(msg: JsonRpcMessage): void {
    this.msgCb?.(msg);
  }
  kill(err?: Error): void {
    this.closeCb?.(err);
  }
  lastRequest(): { id: number; method: string; params?: Record<string, unknown> } {
    const r = this.sent.find((m) => "method" in m && "id" in m)!;
    return r as never;
  }
}

function client(transport: MemTransport, roots?: () => { uri: string; name?: string }[]) {
  return new McpClient(
    transport,
    { clientInfo: { name: "standardcode", version: "test" }, ...(roots ? { listRoots: roots } : {}), requestTimeoutMs: 2000 },
  );
}

describe("initialize 握手三步（DoD③）", () => {
  it("request(protocolVersion 最新+roots capability+clientInfo)→响应校验→initialized 恰一次+记录 server 面", async () => {
    const t = new MemTransport();
    const c = client(t, () => [{ uri: "file:///ws/root" }]);
    const p = c.initialize();
    const req = t.lastRequest();
    expect(req.method).toBe("initialize");
    expect(req.params!.protocolVersion).toBe("2025-06-18");
    expect(req.params!.capabilities).toEqual({ roots: {} });
    expect(req.params!.clientInfo).toEqual({ name: "standardcode", version: "test" });
    t.inject({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "9.9" }, instructions: "be nice" },
    });
    const r = await p;
    expect(r.protocolVersion).toBe("2025-03-26");
    expect(r.serverInfo!.name).toBe("fixture");
    expect(r.instructions).toBe("be nice");
    const notes = t.sent.filter((m) => "method" in m && !("id" in m));
    expect(notes.map((n) => (n as { method: string }).method)).toEqual(["notifications/initialized"]);
  });
  it("server 回不支持修订版=拒绝（era 协商不做，ADR-0040 决策 3）", async () => {
    const t = new MemTransport();
    const c = client(t);
    const p = c.initialize();
    t.inject({ jsonrpc: "2.0", id: t.lastRequest().id, result: { protocolVersion: "2026-07-28" } });
    await expect(p).rejects.toThrow(McpProtocolError);
    await expect(p).rejects.toThrow(/unsupported protocol version 2026-07-28/);
    expect(t.sent.filter((m) => "method" in m && !("id" in m))).toEqual([]); // 拒绝后不发 initialized
  });
  it("server 返回 JSON-RPC error→拒绝", async () => {
    const t = new MemTransport();
    const c = client(t);
    const p = c.initialize();
    t.inject({ jsonrpc: "2.0", id: t.lastRequest().id, error: { code: -32600, message: "Invalid Request" } });
    await expect(p).rejects.toThrow(/MCP error -32600: Invalid Request/);
  });
});

describe("反向请求路由（DoD③ roots/list；:299101 同构）", () => {
  it("server 发 roots/list→client 答工作区根", async () => {
    const t = new MemTransport();
    let seen: { uri: string }[] | null = null;
    const c = new McpClient(
      t,
      { clientInfo: { name: "standardcode", version: "test" }, listRoots: () => [{ uri: "file:///workspace" }], requestTimeoutMs: 2000 },
      { onRootsListed: (roots) => (seen = roots) },
    );
    t.inject({ jsonrpc: "2.0", id: "s1", method: "roots/list" });
    await new Promise((r) => setImmediate(r));
    const answer = t.sent.find((m) => "id" in m && "result" in m) as { id: string; result: { roots: unknown[] } };
    expect(answer.id).toBe("s1");
    expect(answer.result.roots).toEqual([{ uri: "file:///workspace" }]);
    expect(seen).toEqual([{ uri: "file:///workspace" }]);
  });
  it("ping→{}；未知方法→-32601 应答（协议不悬空）", async () => {
    const t = new MemTransport();
    const c = client(t);
    t.inject({ jsonrpc: "2.0", id: "p1", method: "ping" });
    t.inject({ jsonrpc: "2.0", id: "x1", method: "completion/unknown" });
    await new Promise((r) => setImmediate(r));
    const ping = t.sent.find((m) => "id" in m && (m as { id: string }).id === "p1") as { result: unknown };
    expect(ping.result).toEqual({});
    const unk = t.sent.find((m) => "id" in m && (m as { id: string }).id === "x1") as { error?: { code: number } };
    expect(unk.error?.code).toBe(-32601);
  });
  it("通知路由 onNotification；迟到响应（已超时）静默丢弃不炸", async () => {
    const t = new MemTransport();
    const c = client(t);
    const got: string[] = [];
    c.onNotification((n) => got.push(n.method));
    t.inject({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    expect(got).toEqual(["notifications/message"]);
    expect(() => t.inject({ jsonrpc: "2.0", id: 9999, result: "late" })).not.toThrow();
  });
});

describe("超时与终态（DoD④ 失败降级基座）", () => {
  it("请求超时→McpTimeoutError 且不悬挂", async () => {
    const t = new MemTransport();
    const c = new McpClient(t, { clientInfo: { name: "standardcode", version: "test" }, requestTimeoutMs: 20 });
    await expect(c.request("tools/list")).rejects.toThrow(McpTimeoutError);
  });
  it("传输 kill→在途请求全拒（连接失败不阻塞由 connectServer 兜底）", async () => {
    const t = new MemTransport();
    const c = client(t);
    const p = c.request("x");
    t.kill(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
  });
  it("close 后拒绝新请求", async () => {
    const t = new MemTransport();
    const c = client(t);
    await c.close();
    await expect(c.request("x")).rejects.toThrow(/closed/);
    expect(t.closed).toBe(true);
  });
});
