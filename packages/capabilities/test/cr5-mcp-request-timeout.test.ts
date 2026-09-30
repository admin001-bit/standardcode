// S2-1 回归（全仓审查 2026-10-01 批5）：connectServer 生产构造 McpClient 必须传 requestTimeoutMs——
// 原不传 → client 内部 ??30_000 硬兜底，per-server "timeout" 与 STANDARD_CODE_MCP_TIMEOUT
// （ADR-0040 决策 7）对 >30s 配置全部架空，tools/call 第 31 秒必死于内部 timer。
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage, McpTransport } from "../src/index.ts";
import { connectServer } from "../src/mcp/connect.ts";

class AutoInitTransport implements McpTransport {
  readonly kind = "stdio" as const;
  private msgCb: ((m: JsonRpcMessage) => void) | null = null;
  async start(): Promise<void> {}
  async send(msg: JsonRpcMessage): Promise<void> {
    if ("method" in msg && msg.method === "initialize" && "id" in msg) {
      // 立即回协商成功（形状与 mcp-client 夹具同源）
      queueMicrotask(() =>
        this.msgCb?.({
          jsonrpc: "2.0",
          id: (msg as { id: number }).id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fx", version: "1" } },
        }),
      );
    }
  }
  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(): void {}
  async close(): Promise<void> {}
}

function clientRequestTimeout(conn: Awaited<ReturnType<typeof connectServer>>): number | undefined {
  const c = conn.client as unknown as { opts?: { requestTimeoutMs?: number } } | undefined;
  return c?.opts?.requestTimeoutMs;
}

describe("S2-1 connectServer→McpClient requestTimeoutMs 接通", () => {
  it("per-server timeout 优先（45s 不再被 30s 兜底架空）", async () => {
    const conn = await connectServer(
      { name: "s", origin: "user", config: { type: "stdio", command: "x", timeout: 45_000 } },
      { cwd: "/", sessionId: "s1", transportFactory: () => new AutoInitTransport() },
    );
    expect(conn.status).toBe("connected");
    expect(clientRequestTimeout(conn)).toBe(45_000); // 修复前：undefined → client 内部 30_000
  });

  it("无 per-server → connectTimeoutMs 解析值透传（env/入参面同源）", async () => {
    const conn = await connectServer(
      { name: "s", origin: "user", config: { type: "stdio", command: "x" } },
      { cwd: "/", sessionId: "s2", connectTimeoutMs: 60_000, transportFactory: () => new AutoInitTransport() },
    );
    expect(conn.status).toBe("connected");
    expect(clientRequestTimeout(conn)).toBe(60_000);
  });

  it("缺省=30_000（与原兜底同值，零行为漂移）", async () => {
    const conn = await connectServer(
      { name: "s", origin: "user", config: { type: "stdio", command: "x" } },
      { cwd: "/", sessionId: "s3", transportFactory: () => new AutoInitTransport() },
    );
    expect(conn.status).toBe("connected");
    expect(clientRequestTimeout(conn)).toBe(30_000);
  });
});
