// WP-01 Streamable HTTP 与 legacy SSE（DoD⑦：404/400+过期正则→重建会话后**重试恰一次**；
// 双 Accept 头/会话头回传=形状 dig-05 §6 kGs :298468）。本地 node:http 夹具 server，零外网。
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpTransport, connectServer, MCP_SESSION_EXPIRED_RE, type JsonRpcMessage, type McpServerEntry } from "../src/index.ts";

function readBody(req: { on: (e: string, cb: (c: Buffer) => void) => void }): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString("utf8")));
    req.on("end", () => resolve(s));
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return `http://127.0.0.1:${a.port}/mcp`;
}

const entry = (url: string): McpServerEntry => ({ name: "h", origin: "user", config: { type: "http", url } });

describe("过期判据正则（DoD⑦ 形状 :294700 逐字）", () => {
  it("三形态命中；正常 body 不误伤", () => {
    expect(MCP_SESSION_EXPIRED_RE.test("Server not initialized")).toBe(true);
    expect(MCP_SESSION_EXPIRED_RE.test("No valid session ID")).toBe(true);
    expect(MCP_SESSION_EXPIRED_RE.test("Mcp-Session-Id header is required")).toBe(true);
    expect(MCP_SESSION_EXPIRED_RE.test("Internal Server Error")).toBe(false);
  });
});

describe("Streamable HTTP（DoD③握手+⑦会话恢复）", () => {
  let srv: Server;
  let url: string;
  let sessions: string[] = [];
  let expiresAfterInit = false; // 置真=握手后所有带旧会话请求 404
  let requests: { method: string; sessionHeader: string | null }[] = [];
  let initCount = 0;

  beforeAll(async () => {
    srv = createServer(async (req, res) => {
      const body = await readBody(req);
      const msg = JSON.parse(body) as JsonRpcMessage & { method?: string; id?: number };
      const sid = req.headers["mcp-session-id"] ?? null;
      requests.push({ method: String(msg.method), sessionHeader: sid === null ? null : String(sid) });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (msg.method === "initialize") {
        initCount++;
        const s = `S${initCount}`;
        sessions.push(s);
        headers["mcp-session-id"] = s;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fx-http" }, capabilities: {}, instructions: "http-fx" } }));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      const current = sessions[sessions.length - 1];
      if (expiresAfterInit && sid !== current) {
        res.writeHead(404, headers);
        res.end("Server not initialized");
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t1" }] } }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    });
    url = await listen(srv);
  });
  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("缺省会话头回传+双 Accept；通知 202 无 body", async () => {
    requests = [];
    sessions = [];
    expiresAfterInit = false;
    initCount = 0;
    const conn = await connectServer(entry(url), { cwd: "/", sessionId: "s1" });
    expect(conn.status).toBe("connected");
    expect(conn.instructions).toBe("http-fx");
    await conn.client!.request("tools/list");
    expect(conn.client).toBeDefined();
    const toolReq = requests.at(-1)!;
    expect(toolReq.method).toBe("tools/list");
    expect(toolReq.sessionHeader).toBe(sessions[0]); // 从 initialize 响应头捕获并回传
    await conn.close();
    // 双 Accept 头经真实 transport 断言：
    const t = new HttpTransport({ config: { type: "http", url } });
    void t; // 头断言在下一用例经 fetchImpl 注入
  });

  it("双 Accept 头形状（kGs :298468）", async () => {
    let seenAccept = "";
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAccept = h.get("accept") ?? "";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "X" } });
    }) as unknown as typeof fetch;
    const t = new HttpTransport({ config: { type: "http", url: "https://api.dev/mcp" }, fetchImpl: fakeFetch });
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(seenAccept).toBe("application/json, text/event-stream");
  });

  it("会话过期→重建（重握手）后重试恰一次成功（DoD⑦）", async () => {
    requests = [];
    sessions = [];
    initCount = 0;
    expiresAfterInit = false;
    const conn = await connectServer(entry(url), { cwd: "/", sessionId: "s2" });
    expect(conn.status).toBe("connected");
    const client = conn.client!;
    const transport = (client as unknown as { transport: HttpTransport }).transport;
    // 模拟服务端会话轮转：旧 sid 全部失效（server 侧现以哨兵为"最新会话"）。
    expiresAfterInit = true;
    sessions.push("server-side-rotation-sentinel");
    const res = await client.request("tools/list");
    expect(res).toEqual({ tools: [{ name: "t1" }] });
    expect(initCount).toBe(2); // 重建=第二次握手
    const toolsReqs = requests.filter((r) => r.method === "tools/list");
    expect(toolsReqs).toHaveLength(2); // 首发+恰一次重试
    expect(toolsReqs[1].sessionHeader).toBe(sessions.at(-1)); // 重试携带重建后新会话
    await conn.close();
    void transport;
  });

  it("重建后再过期=不可恢复→失败（重试上限恰一次）", async () => {
    let attempts = 0;
    const alwaysExpired = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; id?: number | string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      attempts++;
      return new Response("No valid session ID", { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const t = new HttpTransport({ config: { type: "http", url: "https://x.dev/mcp" }, fetchImpl: alwaysExpired });
    t.onSessionExpired = async () => {}; // 重建成功但会话仍过期
    await expect(t.send({ jsonrpc: "2.0", id: 7, method: "tools/list" })).rejects.toThrow(/again after one recovery attempt/);
    expect(attempts).toBe(2); // 首发+一次重试=2，无第三次
  });
});

describe("legacy SSE（DoD② sse 型+全链回环）", () => {
  let srv: Server;
  let url: string;
  let streamRes: { writeHead: (c: number, h: Record<string, string>) => void; write: (s: string) => void } | null = null;
  const pending: ((msg: JsonRpcMessage) => void)[] = [];
  let ssePosts: { method?: string }[] = [];

  beforeAll(async () => {
    srv = createServer(async (req, res) => {
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        streamRes = res as never;
        req.on("close", () => (streamRes = null));
        return;
      }
      if (req.url === "/messages") {
        const body = await readBody(req);
        const msg = JSON.parse(body) as JsonRpcMessage & { method?: string; id?: number; params?: { protocolVersion?: string } };
        ssePosts.push({ method: msg.method });
        res.writeHead(202);
        res.end();
        const reply =
          msg.method === "initialize"
            ? { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fx-sse" }, capabilities: { prompts: {} } } }
            : msg.method === "tools/list"
              ? { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "s1" }] } }
              : null;
        if (reply && streamRes) streamRes.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    url = await listen(srv).then((u) => u.replace("/mcp", "/sse"));
  });
  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    void pending;
  });

  it("endpoint 事件→POST 回程；握手+tools/list 经流回帧", async () => {
    ssePosts = [];
    const conn = await connectServer({ name: "s", origin: "user", config: { type: "sse", url } }, { cwd: "/", sessionId: "sse1" });
    expect(conn.status).toBe("connected");
    expect(conn.serverCapabilities).toEqual({ prompts: {} });
    const res = await conn.client!.request("tools/list");
    expect(res).toEqual({ tools: [{ name: "s1" }] });
    expect(ssePosts.map((p) => p.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    await conn.close();
  }, 10000);
});
