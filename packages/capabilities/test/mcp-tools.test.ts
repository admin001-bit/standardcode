// WP-02（M4）工具注入判据面（卡 DoD 自足抄录）：
// ①命名净化+mcpInfo ②annotations 映射 ③顶层组合器 schema 跳过 ⑤超时矩阵纯函数
// ⑥120s 转后台（生效条件/落账/双路通知/TaskStop 取消/主循环判定）⑦分页 20 页 ⑧list_changed。
import { describe, expect, it } from "vitest";
import { createTaskRegistry } from "@standardcode/harness";
import {
  buildMcpToolsForConnection,
  callMcpToolWithAutoBackground,
  enumerateMcpTools,
  mcpToolFullName,
  resolveIdleTimeoutMs,
  resolveTotalTimeoutMs,
  sanitizeMcpNameSegment,
  skipReasonForCombinators,
  topLevelCombinators,
  McpClient,
  type JsonRpcMessage,
  type McpToolContext,
  type McpTransport,
} from "../src/index.ts";
import type { ToolContext } from "@standardcode/harness";

/** 脚本传输：send 时经 handler 决定应答（microtask 注入），可主动 fire 通知帧。 */
class ScriptTransport implements McpTransport {
  readonly kind = "http" as const;
  sent: JsonRpcMessage[] = [];
  private msgCb: ((m: JsonRpcMessage) => void) | null = null;
  constructor(private handler: (msg: JsonRpcMessage, respond: (r: JsonRpcMessage) => void) => void) {}
  async start(): Promise<void> {}
  async send(msg: JsonRpcMessage): Promise<void> {
    this.sent.push(msg);
    this.handler(msg, (r) => queueMicrotask(() => this.msgCb?.(r)));
  }
  onMessage(cb: (m: JsonRpcMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(): void {}
  async close(): Promise<void> {}
  fire(n: JsonRpcMessage): void {
    this.msgCb?.(n);
  }
}

function scriptClient(handler: (msg: JsonRpcMessage, respond: (r: JsonRpcMessage) => void) => void) {
  const t = new ScriptTransport(handler);
  return { t, client: new McpClient(t, { clientInfo: { name: "standardcode", version: "t" }, requestTimeoutMs: 30_000 }) };
}

const toolsListHandler =
  (tools: unknown[]): ((msg: JsonRpcMessage, respond: (r: JsonRpcMessage) => void) => void) =>
  (msg, respond) => {
    if ("method" in msg && msg.method === "tools/list") respond({ jsonrpc: "2.0", id: (msg as { id: number }).id, result: { tools } });
  };

const fakeToolCtx = (): ToolContext => ({ signal: new AbortController().signal, registerProcess: () => {} });

const baseMctx = (over: Partial<McpToolContext> = {}): McpToolContext => ({
  serverName: "fx",
  transport: "http",
  serverTimeout: undefined,
  env: {},
  isMainLoop: true,
  ...over,
});

describe("DoD① 命名净化（Ir :72740 形状：非法字符→_）", () => {
  it("sanitize+full name；server 名净化、tool 名原样", () => {
    expect(sanitizeMcpNameSegment("my srv!")).toBe("my_srv_");
    expect(sanitizeMcpNameSegment("a-b_C9")).toBe("a-b_C9");
    expect(mcpToolFullName("my srv!", "get.x")).toBe("mcp__my_srv___get.x"); // 净化段尾 _ 与分隔 __ 相连=三下划线（Ir 同构可诊断）
    expect(mcpToolFullName("api", "read_file")).toBe("mcp__api__read_file");
  });
  it("工具对象形状：mcpInfo 四字段+searchHint+description 透传+deferred false", async () => {
    const { t, client } = scriptClient(toolsListHandler([{ name: "echo", description: "echo it", inputSchema: { type: "object", properties: { text: { type: "string" } } } }]));
    void t;
    const { tools } = await buildMcpToolsForConnection(client, baseMctx());
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("mcp__fx__echo");
    expect(tool.description).toBe("echo it");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });
    expect(tool.mcpInfo).toEqual({ serverName: "fx", serverType: "http", displayName: "echo", toolName: "echo" });
    expect(tool.deferred).toBe(false);
  });
});

describe("DoD② annotations 映射", () => {
  it("readOnlyHint:true→isConcurrencySafe；annotations 原样挂工具元数据；title→displayName", async () => {
    const { client } = scriptClient(
      toolsListHandler([
        { name: "r", annotations: { readOnlyHint: true, openWorldHint: false }, title: "Reader" },
        { name: "w", annotations: { destructiveHint: true } },
      ]),
    );
    const { tools } = await buildMcpToolsForConnection(client, baseMctx());
    const r = tools.find((x) => x.name === "mcp__fx__r")!;
    expect(r.isConcurrencySafe).toBe(true);
    expect(r.mcpInfo.displayName).toBe("Reader");
    expect(r.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find((x) => x.name === "mcp__fx__w")!.isConcurrencySafe).toBe(false);
  });
});

describe("DoD③ 顶层组合器 schema 门（文案 :296293 形状）", () => {
  it("anyOf/oneOf/allOf 顶层=跳过+提示；嵌套层放行", async () => {
    const { client } = scriptClient(
      toolsListHandler([
        { name: "bad", inputSchema: { anyOf: [], title: "x" } },
        { name: "both", inputSchema: { oneOf: [], allOf: [] } },
        { name: "fine", inputSchema: { type: "object", properties: { p: { anyOf: [] } } } },
      ]),
    );
    const { tools, skipped } = await buildMcpToolsForConnection(client, baseMctx());
    expect(tools.map((t) => t.name)).toEqual(["mcp__fx__fine"]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toBe("its input schema uses top-level anyOf, which the Anthropic API does not accept");
    expect(skipped[1]!.reason).toContain("oneOf/allOf");
    expect(topLevelCombinators("nope")).toEqual([]);
    expect(skipReasonForCombinators(["allOf"])).toContain("allOf");
  });
});

describe("DoD⑦ tools/list 分页上限 20 页（c9r :298442）", () => {
  it("游标链 25 页→取 20 页封顶 pageCapReached；正常末页 cursor 透传", async () => {
    let requests: { cursor?: string }[] = [];
    const { client } = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/list") {
        const params = (msg.params ?? {}) as { cursor?: string };
        requests.push(params);
        const page = params.cursor ? Number(params.cursor.slice(1)) : 0; // "pN"→N；首页=0
        const tools = [{ name: `t${page}` }];
        respond({
          jsonrpc: "2.0",
          id: (msg as { id: number }).id,
          result: page < 24 ? { tools, nextCursor: `p${page + 1}` } : { tools },
        });
      }
    });
    const res = await enumerateMcpTools(client);
    expect(res.tools).toHaveLength(20); // 20 页封顶（t0..t19），第 21 页不再拉取
    expect(res.pageCapReached).toBe(true);
    expect(requests).toHaveLength(20);
    expect(requests[1]!.cursor).toBe("p1");
    requests = [];
    const ok = scriptClient(toolsListHandler([{ name: "z" }]));
    const r2 = await enumerateMcpTools(ok.client);
    expect(r2.pageCapReached).toBe(false);
    expect(r2.tools.map((t) => t.name)).toEqual(["z"]);
  });
});

describe("DoD⑤ 超时矩阵纯函数（形状 :294965-294979/:298452）", () => {
  it("总超时：per-server≥1000 > env > 缺省 1e8；钳位 [1000,2^31-1]", () => {
    expect(resolveTotalTimeoutMs(undefined, {})).toBe(100_000_000);
    expect(resolveTotalTimeoutMs(500, {})).toBe(100_000_000); // <1000 不生效
    expect(resolveTotalTimeoutMs(5000, {})).toBe(5000);
    expect(resolveTotalTimeoutMs(1e12, {})).toBe(2_147_483_647);
    expect(resolveTotalTimeoutMs(undefined, { STANDARD_CODE_MCP_TOOL_TIMEOUT: "9000" })).toBe(9000);
    expect(resolveTotalTimeoutMs(undefined, { STANDARD_CODE_MCP_TOOL_TIMEOUT: "abc" })).toBe(100_000_000);
    expect(resolveTotalTimeoutMs(2000, { STANDARD_CODE_MCP_TOOL_TIMEOUT: "9000" })).toBe(2000); // per-server 优先
  });
  it("idle=min(max(基准,perServer≥1000,1000),total)；env=0 禁用；基准 stdio 1800000/其他 300000", () => {
    expect(resolveIdleTimeoutMs("stdio", undefined, {})).toBe(1_800_000);
    expect(resolveIdleTimeoutMs("http", undefined, {})).toBe(300_000);
    expect(resolveIdleTimeoutMs("stdio", undefined, { STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" })).toBe(0);
    expect(resolveIdleTimeoutMs("http", undefined, { STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "500" })).toBe(1000); // 地板 1000
    expect(resolveIdleTimeoutMs("http", 60_000, { STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "500" })).toBe(60_000); // per-server 抬升
    expect(resolveIdleTimeoutMs("http", undefined, { STANDARD_CODE_MCP_TOOL_TIMEOUT: "2000", STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "9000" })).toBe(2000); // 封顶=total
    expect(resolveIdleTimeoutMs("stdio", undefined, { STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "x" })).toBe(1_800_000); // 无效值=基准
  });
  it("执行面触发：total 超时→可操作提示文案（:298032 形状，env 名本仓前缀）", async () => {
    const { client } = scriptClient(() => {}); // 永不应答
    const ctx = { ...baseMctx({ env: { STANDARD_CODE_MCP_TOOL_TIMEOUT: "1200", STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" } }) };
    await expect(callMcpToolWithAutoBackground(client, "mcp__fx__slow", "slow", {}, fakeToolCtx(), ctx)).rejects.toThrow(
      /timed out after 1200ms.*per-server "timeout".*STANDARD_CODE_MCP_TOOL_TIMEOUT/,
    );
  }, 10_000);
  it("idle 触发：无活动→idle 文案；活动（任意入站帧）复位计时", async () => {
    const { t, client } = scriptClient(() => {}); // 不自动应答
    const ctx = baseMctx({ env: { STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT: "600", STANDARD_CODE_MCP_TOOL_TIMEOUT: "30000" } });
    const p = callMcpToolWithAutoBackground(client, "mcp__fx__s", "s", {}, fakeToolCtx(), ctx);
    const start = Date.now();
    setTimeout(() => t.fire({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "x" } }), 400);
    // env 600 经地板抬升=1000ms；400ms 活动复位→拒绝应在 ~1400ms 而非 1000ms
    await expect(p).rejects.toThrow(/received no response or progress notification for 1000ms.*STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT \(ms\) globally \(0 disables\)/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1300);
  }, 10_000);
});

describe("DoD⑥ 120s 超时转后台（:293505 形状+registry 落账）", () => {
  it("env 数字阈值+主循环：翻转文本四要素；终态 completed 落账+通知", async () => {
    const registry = createTaskRegistry({ evictAfterMs: 0 });
    const notes: string[] = [];
    let callRespond: ((r: JsonRpcMessage) => void) | null = null;
    const { client } = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/call") callRespond = respond;
      else if ("method" in msg && msg.method === "tools/list") respond({ jsonrpc: "2.0", id: (msg as { id: number }).id, result: { tools: [] } });
    });
    const ctx = baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "30" }, registry, notifications: notes });
    const text = await callMcpToolWithAutoBackground(client, "mcp__fx__work", "work", { a: 1 }, fakeToolCtx(), ctx);
    expect(text).toMatch(/is still running after 0s/); // 30ms→0s（Math.round 口径）
    expect(text).toMatch(/moved to the background as task (task-\d+) and keeps running/);
    expect(text).toMatch(/you'll receive a notification with the result when it completes/);
    expect(text).toMatch(/To stop it, use TaskStop with task_id "task-\d+"/);
    expect(text).toMatch(/does not survive exiting this session/);
    const task = registry.list()[0]!;
    expect(task.type).toBe("mcp_tool");
    expect(task.isBackgrounded).toBe(true);
    expect(task.status).toBe("running");
    expect(task.agentId).toBe("mcp:fx:work");
    callRespond!({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done!" }] } });
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.get(task.taskId)!.status).toBe("completed");
    expect(registry.get(task.taskId)!.result!.content).toBe("done!");
    expect(notes[0]).toBe(`MCP task ${task.taskId} completed. Tool "work" on server "fx":\ndone!`);
    void toolsListHandler;
  }, 15_000);

  it("失败路通知+registry.fail；env 缺席=恒同步；子代理 agentKind 排除", async () => {
    const registry = createTaskRegistry({ evictAfterMs: 0 });
    const notes: string[] = [];
    let callRespond: ((r: JsonRpcMessage) => void) | null = null;
    const { client } = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/call") callRespond = respond;
    });
    const ctx = baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" }, registry, notifications: notes });
    const p = callMcpToolWithAutoBackground(client, "mcp__fx__work", "work", {}, fakeToolCtx(), ctx);
    await p; // 翻转即返
    const task = registry.list()[0]!;
    callRespond!({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.get(task.taskId)!.status).toBe("failed");
    expect(notes.at(-1)).toContain("failed");
    // env 缺席=恒同步（响应后直接返回内容）
    const sync = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/call") respond({ jsonrpc: "2.0", id: (msg as { id: number }).id, result: { content: [{ type: "text", text: "sync" }] } });
    });
    expect(await callMcpToolWithAutoBackground(sync.client, "mcp__fx__t", "t", {}, fakeToolCtx(), baseMctx({ env: {}, registry: createTaskRegistry({ evictAfterMs: 0 }) }))).toBe("sync");
    // 子代理执行侧：agentKind=subagent → 不翻转（恒同步等待）
    const sub = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/call") setTimeout(() => respond({ jsonrpc: "2.0", id: (msg as { id: number }).id, result: { content: [{ type: "text", text: "sub" }] } }), 60);
    });
    const r2 = await callMcpToolWithAutoBackground(sub.client, "mcp__fx__t", "t", {}, { ...fakeToolCtx(), agentKind: "subagent" as const }, baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" }, registry: createTaskRegistry({ evictAfterMs: 0 }) }));
    expect(r2).toBe("sub");
  }, 15_000);

  it("R1 回归：翻转后前台中断（ctx.signal abort）不得杀后台调用；TaskStop 仍可停（§8.4）", async () => {
    const registry = createTaskRegistry({ evictAfterMs: 0 });
    const notes: string[] = [];
    let callRespond: ((r: JsonRpcMessage) => void) | null = null;
    const { client } = scriptClient((msg, respond) => {
      if ("method" in msg && msg.method === "tools/call") callRespond = respond;
    });
    const abort = new AbortController();
    const ctx = baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" }, registry, notifications: notes });
    const text = await callMcpToolWithAutoBackground(client, "mcp__fx__bg", "bg", {}, { signal: abort.signal, registerProcess: () => {} }, ctx);
    const taskId = text.match(/task_id "(task-\d+)"/)![1]!;
    abort.abort(); // 前台中断——已后台化调用必须无动于衷
    expect(registry.get(taskId)!.status).toBe("running");
    callRespond!({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "survived" }] } });
    await new Promise((r) => setTimeout(r, 150));
    expect(registry.get(taskId)!.status).toBe("completed");
    expect(registry.get(taskId)!.result!.content).toBe("survived");
    expect(notes.at(-1)).toContain("completed");
    // 未翻转的前台中断路径仍有效（翻转前 abort=取消）
    const a2 = new AbortController();
    const ctx2 = baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "200" }, registry: createTaskRegistry({ evictAfterMs: 0 }), notifications: [] });
    const p2 = callMcpToolWithAutoBackground(client, "mcp__fx__fg", "fg", {}, { signal: a2.signal, registerProcess: () => {} }, ctx2);
    a2.abort();
    await expect(p2).rejects.toThrow(/cancelled/);
  }, 15_000);

  it("TaskStop 取消链：runtime.abort→notifications/cancelled 发出+fail 落账", async () => {
    const registry = createTaskRegistry({ evictAfterMs: 0 });
    const notes: string[] = [];
    const { t, client } = scriptClient(() => {}); // 永不响应 tools/call
    const ctx = baseMctx({ env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" }, registry, notifications: notes });
    const text = await callMcpToolWithAutoBackground(client, "mcp__fx__long", "long", {}, fakeToolCtx(), ctx);
    const taskId = text.match(/task_id "(task-\d+)"/)![1]!;
    registry.getRuntime(taskId)!.abort.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(t.sent.some((m) => "method" in m && m.method === "notifications/cancelled" && (m.params as { requestId?: number }).requestId !== undefined)).toBe(true);
    expect(registry.get(taskId)!.status).toBe("failed");
    expect(notes.at(-1)).toMatch(/cancelled/);
  }, 15_000);
});

describe("DoD⑧ list_changed→刷新回调", () => {
  it("notifications/tools/list_changed 触发 onToolsChanged(serverName)；其余通知不误触", async () => {
    const fired: string[] = [];
    const { t, client } = scriptClient(toolsListHandler([{ name: "x" }]));
    await buildMcpToolsForConnection(client, baseMctx({ onToolsChanged: (s) => fired.push(s) }));
    t.fire({ jsonrpc: "2.0", method: "notifications/message", params: {} });
    expect(fired).toEqual([]);
    t.fire({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(fired).toEqual(["fx"]);
  });
});

describe("tools/call 结果收敛（isError/非文本块）", () => {
  it("多 text 块拼接；image 标注省略；isError=true→抛错带内容", async () => {
    const mk = (result: unknown) =>
      scriptClient((msg, respond) => {
        if ("method" in msg && msg.method === "tools/call") respond({ jsonrpc: "2.0", id: (msg as { id: number }).id, result });
      });
    const c1 = mk({ content: [{ type: "text", text: "a" }, { type: "image", data: "..." }, { type: "text", text: "b" }] });
    expect(await callMcpToolWithAutoBackground(c1.client, "mcp__fx__t", "t", {}, fakeToolCtx(), baseMctx())).toBe("a\n[mcp image content omitted]\nb");
    const c2 = mk({ content: [{ type: "text", text: "bad input" }], isError: true });
    await expect(callMcpToolWithAutoBackground(c2.client, "mcp__fx__t", "t", {}, fakeToolCtx(), baseMctx())).rejects.toThrow("bad input");
  });
});
