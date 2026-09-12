// WP-02（M4）session 装配集成（DoD④ 权限默认 ask=full name 过既有 broker；S-3/§8.3 项目共享层信任门前置；
// ADR-0040 装配链=flagOverrides→loader→connectAll→buildMcpTools→s.tools 原位合并；"总是允许"工具级规则形制）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { createSession, type SessionInit } from "../src/session.ts";
import { alwaysAllowRuleFor } from "../src/confirm.ts";

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
const extraDirs: string[] = [];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp02-"));
  fixturePath = path.join(root, "mcp-echo.mjs");
  writeFileSync(fixturePath, FIXTURE, "utf8");
});
afterAll(async () => {
  // Windows EBUSY/EPERM：子进程收尾与句柄释放异步，统一延迟重试清理（测试内不删）。
  for (const d of [root, ...extraDirs]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* 暂存目录泄漏可接受（OS 随 tmp 清理） */
    }
  }
});

function mcpFlag() {
  return {
    mcpServers: { fx: { type: "stdio", command: process.execPath, args: [fixturePath] } },
  };
}

async function bootedSession(extra: Partial<SessionInit> = {}) {
  const s = createSession({
    provider: fakeProvider(),
    catalog: ["m"],
    model: "m",
    cwd: root,
    projectRoot: root,
    home: root, // 隔离真实家目录
    flagOverrides: mcpFlag(),
    ...extra,
  });
  await s.mcpReady;
  return s;
}

describe("装配链（flag 源）", () => {
  it("mcpReady 后工具面含 mcp__fx__echo（connected/origin=flag）+execute 真回环", async () => {
    const s = await bootedSession();
    const conn = s.mcpConnections.find((c) => c.name === "fx")!;
    expect(conn.status).toBe("connected");
    expect(conn.origin).toBe("flag");
    const tool = s.tools.find((t) => t.name === "mcp__fx__echo");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe("echo text back");
    const ctx = { signal: new AbortController().signal, registerProcess: () => {} };
    expect(await tool!.execute({ text: "hi" }, ctx)).toBe("echo:hi");
    await Promise.all(s.mcpConnections.map((c) => c.close().catch(() => {})));
  }, 20_000);
});

describe("DoD④ 权限面：MCP 工具缺省 ask（S-3）+规则语义", () => {
  it("default 模式无规则=ask；mcp__fx__* 通配 allow 命中；deny 恒赢；bypass=allow", async () => {
    const s = await bootedSession();
    expect(s.broker.evaluate("mcp__fx__echo", {}).decision).toBe("ask"); // Manual：未批不执行
    const allow = await bootedSession({ rules: { allow: ["mcp__fx__*"] } });
    expect(allow.broker.evaluate("mcp__fx__echo", {}).decision).toBe("allow"); // allow 侧 mcp__ 前缀通配（parseRuleset 既禁裸通配，此处合法）
    const both = await bootedSession({ rules: { allow: ["mcp__fx__echo"], deny: ["mcp__*"] } });
    expect(both.broker.evaluate("mcp__fx__echo", {}).decision).toBe("deny"); // deny→ask→allow 首匹配+deny 恒赢
    both.broker.setMode("bypassPermissions");
    expect(both.broker.evaluate("mcp__fx__echo", {}).decision).toBe("deny"); // bypass 不解锁 deny（B-13）
    const auto = await bootedSession();
    auto.broker.setMode("bypassPermissions");
    expect(auto.broker.evaluate("mcp__fx__echo", {}).decision).toBe("allow");
    // "总是允许"=工具级规则形制（无 file_path→全名；经 addAllow 清洗可装载）
    const rule = alwaysAllowRuleFor("mcp__fx__echo", { text: "x" });
    expect(rule).toBe("mcp__fx__echo");
    expect(auto.broker.addAllow(rule)).toBe(rule);
    expect(auto.broker.evaluate("mcp__fx__echo", {}).decision).toBe("allow");
    for (const sess of [s, allow, both, auto]) for (const c of sess.mcpConnections) await c.close().catch(() => {});
  }, 30_000);
});

describe("S-3/§8.3 信任门前置（项目共享层 server 未信任不加载）", () => {
  it("projectShared settings.mcpServers：untrusted→零连接；trusted:true→连接进工具面（origin=projectShared）", async () => {
    // home 与 projectRoot 分离（同源目录会让一份文件双源装载，掩盖门控判定）
    const proj = mkdtempSync(path.join(tmpdir(), "sc-wp02-proj-"));
    const home = mkdtempSync(path.join(tmpdir(), "sc-wp02-home-"));
    mkdirSync(path.join(proj, ".standardcode"), { recursive: true });
    writeFileSync(
      path.join(proj, ".standardcode", "settings.json"),
      JSON.stringify({ schemaVersion: 1, mcpServers: { proj: { type: "stdio", command: process.execPath, args: [fixturePath] } } }),
      "utf8",
    );
    const untrusted = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home, trusted: false });
    await untrusted.mcpReady;
    expect(untrusted.mcpConnections.find((c) => c.name === "proj")).toBeUndefined();
    expect(untrusted.tools.find((t) => t.name.startsWith("mcp__proj__"))).toBeUndefined();
    const trusted = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home, trusted: true });
    await trusted.mcpReady;
    const conn = trusted.mcpConnections.find((c) => c.name === "proj");
    expect(conn?.status).toBe("connected");
    expect(conn?.origin).toBe("projectShared");
    expect(trusted.tools.some((t) => t.name === "mcp__proj__echo")).toBe(true);
    for (const c of trusted.mcpConnections) await c.close().catch(() => {});
    extraDirs.push(proj, home);
  }, 30_000);
});
