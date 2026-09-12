// MCP server 连接编排：状态机 pending→connected/failed（needs-auth 留位，ORC-050 OAuth=M5 复审）；
// 单 server 失败=降级不阻塞（dig-05 §2.3 红队全路径无 fail-fast 实证）；连接超时 30s（形状 :156230-156234）。
import { pathToFileURL } from "node:url";
import type { McpServerConfig, McpServerEntry, McpConfigIssue } from "./config.ts";
import { McpClient, type InitializeResult, type McpTransport } from "./client.ts";
import { makeTransport, HttpTransport } from "./transport.ts";

export type McpServerStatus = "pending" | "connected" | "failed" | "needs-auth";

export interface McpConnection {
  name: string;
  origin: McpServerEntry["origin"];
  /** WP-02：server 解析后配置（per-server timeout/transport 消费面）。 */
  config?: McpServerEntry["config"];
  status: McpServerStatus;
  error?: string;
  /** 前置校验错误码（UNCONFIGURED/INVALID_CONFIG——未发起连接即落 failed 的形状位）。 */
  errorCode?: McpConfigIssue["code"];
  serverInfo?: InitializeResult["serverInfo"];
  serverCapabilities?: Record<string, unknown>;
  instructions?: string;
  protocolVersion?: string;
  client?: McpClient;
  close(): Promise<void>;
}

export interface ConnectOptions {
  cwd: string;
  sessionId: string;
  version?: string;
  envBase?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** stdio 帧上限注入（测试）；缺省 16MB。 */
  maxLineBytes?: number;
  /** 连接（含握手）超时 ms；缺省 env STANDARD_CODE_MCP_TIMEOUT>0 → 否则 30000（clamp ≤2147483647，形状 :156230-156234）。 */
  connectTimeoutMs?: number;
  transportFactory?: (config: McpServerConfig) => McpTransport;
}

export function resolveConnectTimeout(opts?: { envBase?: NodeJS.ProcessEnv; connectTimeoutMs?: number }): number {
  const capped = (n: number): number => Math.max(1, Math.min(n, 2_147_483_647));
  if (opts?.connectTimeoutMs !== undefined) return capped(opts.connectTimeoutMs);
  const fromEnv = Number((opts?.envBase ?? process.env).STANDARD_CODE_MCP_TIMEOUT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return capped(fromEnv);
  return 30_000;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP connect timeout (${label}) after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 连接单 server（永不抛出——失败落状态；DoD④"单 server 连接失败只降级不阻塞会话"）。 */
export async function connectServer(entry: McpServerEntry, opts: ConnectOptions): Promise<McpConnection> {
  const timeoutMs = resolveConnectTimeout(opts);
  const conn: McpConnection = {
    name: entry.name,
    origin: entry.origin,
    config: entry.config,
    status: "pending",
    close: async () => {},
  };
  let transport: McpTransport | null = null;
  try {
    transport = opts.transportFactory
      ? opts.transportFactory(entry.config)
      : makeTransport(entry.config, { cwd: opts.cwd, sessionId: opts.sessionId, baseEnv: opts.envBase, fetchImpl: opts.fetchImpl, maxLineBytes: opts.maxLineBytes });
    const client = new McpClient(transport, {
      clientInfo: { name: "standardcode", version: opts.version ?? "0.1.0" },
      listRoots: () => [{ uri: pathToFileURL(opts.cwd).href }],
    });
    const record = (r: InitializeResult): void => {
      conn.serverInfo = r.serverInfo;
      conn.serverCapabilities = r.capabilities;
      conn.instructions = r.instructions;
      conn.protocolVersion = r.protocolVersion;
    };
    if (transport instanceof HttpTransport) {
      // 会话过期→重握手重建（DoD⑦；重试恰一次的执行在 transport.send 内）。
      transport.onSessionExpired = async () => record(await client.initialize());
    }
    await withTimeout(transport.start(), timeoutMs, entry.config.type);
    record(await withTimeout(client.initialize(), timeoutMs, "initialize"));
    conn.status = "connected";
    conn.client = client;
    conn.close = () => client.close();
  } catch (e) {
    conn.status = "failed";
    conn.error = e instanceof Error ? e.message : String(e);
    await conn.close().catch(() => {});
    // V 核销观察①清偿：失败路径（版本拒绝/握手超时/spawn 后异常）已 spawn 的子进程必须回收——
    // conn.close 只在 connected 成功后被替换为真实实现，此处 transport.close 兜底（StdioTransport.close 幂等）。
    await transport?.close().catch(() => {});
  }
  return conn;
}

/** 装载结果→全部连接（issues 直接落 failed 未发起位；并行，互不阻塞）。 */
export async function connectAll(
  result: { servers: McpServerEntry[]; issues: McpConfigIssue[] },
  opts: ConnectOptions,
): Promise<McpConnection[]> {
  const connected = await Promise.all(result.servers.map((s) => connectServer(s, opts)));
  const issueConns: McpConnection[] = result.issues.map((i) => ({
    name: i.name,
    origin: i.origin,
    status: "failed" as const,
    errorCode: i.code,
    error: i.message,
    close: async () => {},
  }));
  return [...issueConns, ...connected];
}
