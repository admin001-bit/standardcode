// WP-03（M4）集成：S-3 per-server 批准制装配（DoD① pending 不进合并/DoD② 状态机+留痕/DoD③ enable/disable
// 持久化+重装配/DoD③ /mcp 命令面）；回放 echo fixture 同 WP-02 形制（真子进程 stdio，零网络）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { recordMcpTrust } from "@standardcode/platform";
import { CLI_COMMANDS } from "../src/commands.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { createSession, type SessionInit } from "../src/session.ts";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    async *stream() {
      throw new Error("nope");
    },
    countTokens: async () => 0,
  };
}

const FIXTURE = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const t = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!t) continue;
    const m = JSON.parse(t);
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fx-echo" }, capabilities: { tools: {} } } }) + "\\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } }) + "\\n");
    } else if (m.method === "tools/call") {
      const text = (m.params.arguments ?? {}).text ?? "";
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + text }] } }) + "\\n");
    }
  }
});
`;

let root: string;
let fixturePath: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp03-"));
  fixturePath = path.join(root, "mcp-echo.mjs");
  writeFileSync(fixturePath, FIXTURE, "utf8");
});
afterAll(async () => {
  // Windows EBUSY/EPERM：子进程收尾与句柄释放异步，统一延迟重试清理（测试内不删）。
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 暂存目录泄漏可接受（OS 随 tmp 清理） */
  }
});

function projWithMcp(name = "proj"): string {
  const proj = mkdtempSync(path.join(tmpdir(), "sc-wp03-proj-"));
  mkdirSync(path.join(proj, ".standardcode"), { recursive: true });
  writeFileSync(
    path.join(proj, ".standardcode", "settings.json"),
    JSON.stringify({ schemaVersion: 1, mcpServers: { [name]: { type: "stdio", command: process.execPath, args: [fixturePath] } } }),
    "utf8",
  );
  return proj;
}

function makeSession(proj: string, over: Partial<SessionInit> = {}) {
  return createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, ...over });
}

async function closeAll(s: { mcpConnections: { close(): Promise<void> }[] }): Promise<void> {
  for (const c of s.mcpConnections) await c.close().catch(() => {});
}

describe("S-3 per-server 批准制装配（DoD①②）", () => {
  it("DoD①：untrusted 无记录=projectShared server 默认 pending，不进合并（零连接零工具），视图可见 pending", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: false });
    await s.mcpReady;
    expect(s.mcpConnections.find((c) => c.name === "proj")).toBeUndefined();
    expect(s.tools.find((t) => t.name.startsWith("mcp__proj__"))).toBeUndefined();
    const v = s.mcpServers().find((x) => x.name === "proj");
    expect(v).toMatchObject({ name: "proj", transport: "stdio", origin: "projectShared", state: "pending" });
    expect(v?.status).toBeUndefined();
    await closeAll(s);
  });

  it("DoD②：approve（untrusted）信任无关生效（DQn 形状）——实时装载+工具进面+local 层留痕含 server 名/传输/命令（S-3 来源持久记录）", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: false });
    await s.mcpReady;
    await s.mcpRecord("approve", "proj");
    const conn = s.mcpConnections.find((c) => c.name === "proj");
    expect(conn?.status).toBe("connected");
    expect(s.tools.some((t) => t.name === "mcp__proj__echo")).toBe(true);
    const v = s.mcpServers().find((x) => x.name === "proj");
    expect(v).toMatchObject({ state: "approved", status: "connected" });
    const doc = JSON.parse(readFileSync(path.join(proj, ".standardcode", "settings.local.json"), "utf8")) as { mcpTrust?: Record<string, { decision?: string; transport?: string; command?: string; confirmedAt?: string }> };
    const rec = doc.mcpTrust?.proj;
    expect(rec?.decision).toBe("approved");
    expect(rec?.transport).toBe("stdio");
    expect(rec?.command).toBe(`${process.execPath} ${fixturePath}`); // raw 定义快照（插值前）
    expect(typeof rec?.confirmedAt).toBe("string");
    await closeAll(s);
  });

  it("DoD②：reject 名单恒赢——trusted:true + rejected 留痕仍不进合并（视图 rejected）", async () => {
    const proj = projWithMcp();
    recordMcpTrust(proj, "proj", { decision: "rejected", confirmedAt: "t0" });
    const s = makeSession(proj, { trusted: true });
    await s.mcpReady;
    expect(s.mcpConnections.find((c) => c.name === "proj")).toBeUndefined();
    expect(s.mcpServers().find((x) => x.name === "proj")?.state).toBe("rejected");
    await closeAll(s);
  });

  it("DoD②：enableAllProjectMcpServers=true（flag 层）批准——untrusted 亦装载", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: false, flagOverrides: { enableAllProjectMcpServers: true } });
    await s.mcpReady;
    expect(s.mcpConnections.find((c) => c.name === "proj")?.status).toBe("connected");
    await closeAll(s);
  });
});

describe("enable/disable 持久化+重装配（DoD③）", () => {
  it("disable 实时摘除连接与工具面；enable 恢复；留痕落 local 层", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: true });
    await s.mcpReady;
    expect(s.mcpConnections.find((c) => c.name === "proj")?.status).toBe("connected");
    await s.mcpRecord("disable", "proj");
    expect(s.mcpConnections.find((c) => c.name === "proj")).toBeUndefined();
    expect(s.tools.find((t) => t.name.startsWith("mcp__proj__"))).toBeUndefined();
    expect(s.mcpServers().find((x) => x.name === "proj")?.state).toBe("disabled");
    const doc = JSON.parse(readFileSync(path.join(proj, ".standardcode", "settings.local.json"), "utf8")) as { mcpTrust?: Record<string, { disabled?: boolean }> };
    expect(doc.mcpTrust?.proj?.disabled).toBe(true);
    await s.mcpRecord("enable", "proj");
    expect(s.mcpConnections.find((c) => c.name === "proj")?.status).toBe("connected");
    expect(s.tools.some((t) => t.name === "mcp__proj__echo")).toBe(true);
    await closeAll(s);
  });

  it("未知 server 名拒绝（fail-closed 防手滑）", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: true });
    await s.mcpReady;
    await expect(s.mcpRecord("approve", "nope")).rejects.toThrow(/no MCP server named "nope"/);
    await closeAll(s);
  });
});

describe("/mcp 命令面（DoD③：子命令集+命令清单 26）", () => {
  it("无参=list：状态/传输/来源/连接态逐行；pending 给 approve 指路", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: false });
    await s.mcpReady; // 视图数据在首装配后即位
    const out: string[] = [];
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: (l) => out.push(l), close: () => {} } } as ReplDeps);
    const cmd = CLI_COMMANDS.find((c) => c.name === "mcp")!;
    await cmd.execute("", ctx);
    const text = out.join("\n");
    expect(text).toContain("[mcp] 1 server(s)");
    expect(text).toContain("proj  stdio  projectShared  pending");
    expect(text).toContain("/mcp approve <name>");
    await closeAll(s);
  });

  it("approve/reject/enable/disable 未知子命令与缺参拒绝", async () => {
    const proj = projWithMcp();
    const s = makeSession(proj, { trusted: false });
    await s.mcpReady;
    const out: string[] = [];
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: (l) => out.push(l), close: () => {} } } as ReplDeps);
    const cmd = CLI_COMMANDS.find((c) => c.name === "mcp")!;
    await expect(cmd.execute("restart", ctx)).rejects.toThrow(/unknown \/mcp subcommand: restart/);
    await expect(cmd.execute("approve", ctx)).rejects.toThrow(/server name required/);
    await expect(cmd.execute("list extra", ctx)).rejects.toThrow(/unexpected argument/);
    await expect(cmd.execute("approve nope", ctx)).rejects.toThrow(/no MCP server named "nope"/);
    // approve 真名走通（经 ctx 全链：留痕+重装配+回显状态）
    await cmd.execute("approve proj", ctx);
    expect(out.join("\n")).toContain("[mcp] approved proj");
    expect(out.join("\n")).toContain("connected");
    await closeAll(s);
  });
});
