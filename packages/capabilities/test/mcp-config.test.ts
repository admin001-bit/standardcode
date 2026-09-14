// WP-01（M4）MCP 配置载体（ADR-0040 决策 1/2 + DoD①②⑤）。判据自足抄录卡 DoD：
// ① ADR-0040 落盘 ② 传输解析缺省 stdio/streamable-http 别名/非法值拒绝（文案形状 dig-05 §6 :153511）
// ⑤ ${VAR}/${VAR:-default} 插值断言（stdio command/args/env + http url/headers）。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMcpServerConfigs, MCP_SOURCE_ORDER, parseTransportType } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("ADR-0040 在位（DoD①）", () => {
  it("docs/adr/0040 存在且声明 settings 内嵌载体+自研实现", () => {
    const p = `${repoRoot}docs/adr/0040-mcp-config-carrier-and-client.md`;
    expect(existsSync(p)).toBe(true);
  });
  it("MCP_SOURCE_ORDER 低→高【勘误 2026-09-14：WP-09 plugin 源位插入 projectLocal 之上、flag 之下——settings 五源镜像+plugin 非 settings 源】", () => {
    expect(MCP_SOURCE_ORDER).toEqual(["user", "projectShared", "projectLocal", "plugin", "flag", "managed"]);
  });
});

describe("传输解析（DoD②）", () => {
  it("缺省=stdio；streamable-http=别名→http；大小写敏感（非法值拒绝）", () => {
    expect(parseTransportType(undefined)).toEqual({ kind: "stdio" });
    expect(parseTransportType("stdio")).toEqual({ kind: "stdio" });
    expect(parseTransportType("streamable-http")).toEqual({ kind: "http" });
    expect(parseTransportType("sse")).toEqual({ kind: "sse" });
    expect(parseTransportType("http")).toEqual({ kind: "http" });
    // 文案形状 dig-05 §6 :153511-153519。
    expect(parseTransportType("ws")).toEqual({
      error: "Invalid transport type: ws. Must be one of: stdio, sse, http (or streamable-http)",
    });
    const upper = parseTransportType("STDIO");
    expect("error" in upper ? upper.error : "").toContain("Invalid transport type");
    const num = parseTransportType(42);
    expect("error" in num ? num.error : "").toContain("Invalid transport type: 42");
  });
});

describe("单服务器校验（DoD②/DoD④ errorCode 形状）", () => {
  it("stdio 缺 command→UNCONFIGURED；url 型缺 url→UNCONFIGURED", () => {
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { a: { type: "stdio" }, b: { type: "http" } } } },
      {},
    );
    expect(r.servers).toEqual([]);
    expect(r.issues.map((i) => [i.name, i.code])).toEqual([
      ["a", "UNCONFIGURED"],
      ["b", "UNCONFIGURED"],
    ]);
  });
  it("非法 URL→INVALID_CONFIG；args/env/headers 形状错→INVALID_CONFIG", () => {
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { u: { type: "sse", url: "ht!tp://bad" }, a: { type: "stdio", command: "c", args: "no" }, e: { type: "stdio", command: "c", env: { k: { nested: 1 } } }, h: { type: "http", url: "https://ok.dev", headers: "x" } } } },
      {},
    );
    expect(r.issues.map((i) => [i.name, i.code])).toEqual([
      ["a", "INVALID_CONFIG"],
      ["e", "INVALID_CONFIG"],
      ["h", "INVALID_CONFIG"],
      ["u", "INVALID_CONFIG"],
    ]);
    expect(r.issues.find((i) => i.name === "u")!.message).toContain("is not a valid URL");
  });
  it("非对象条目/非对象 mcpServers→告警跳过（坏件继续形制，[CC] 同构）", () => {
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { bad: "string-entry" } }, projectLocal: { mcpServers: ["array"] } },
      {},
    );
    expect(r.servers).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(r.warnings.some((w) => w.reason.includes("not an object"))).toBe(true);
    expect(r.warnings.some((w) => w.reason.includes("entry is not an object"))).toBe(true);
  });
});

describe("插值（DoD⑤）", () => {
  it("${VAR} 与 ${VAR:-default} 展开进 command/args/env/url/header；未解析保留字面+告警", () => {
    const r = loadMcpServerConfigs(
      {
        user: {
          mcpServers: {
            s: { type: "stdio", command: "run-${TOOL}", args: ["--token=${TOK}", "--d=${MISSING:-fallback}"], env: { X: "${X_SRC}" } },
            h: { type: "http", url: "https://api.dev/${NS}/mcp", headers: { Authorization: "Bearer ${BEARER}" } },
          },
        },
      },
      { TOOL: "node", TOK: "abc", X_SRC: "xv" },
    );
    expect(r.servers).toHaveLength(2);
    const s = r.servers.find((x) => x.name === "s")!.config;
    expect(s).toMatchObject({ type: "stdio", command: "run-node", args: ["--token=abc", "--d=fallback"], env: { X: "xv" } });
    expect(r.servers.find((x) => x.name === "h")!.config).toMatchObject({
      url: "https://api.dev/${NS}/mcp",
      headers: { Authorization: "Bearer ${BEARER}" },
    });
    const reasons = r.warnings.filter((w) => w.reason.includes("unresolved")).map((w) => `${w.server}:${w.reason}`);
    expect(reasons.some((x) => x.includes("h:") && x.includes("NS"))).toBe(true);
    expect(reasons.some((x) => x.includes("h:") && x.includes("BEARER"))).toBe(true);
  });
});

describe("服务器粒度合并（ADR-0040 决策 2）", () => {
  it("同名跨层=高来源整对象胜+抑制告警；不混叶子（user {command,args} vs project {url,type}）", () => {
    const r = loadMcpServerConfigs(
      {
        user: { mcpServers: { dup: { type: "stdio", command: "low", args: ["x"] } } },
        projectLocal: { mcpServers: { dup: { type: "http", url: "https://high.dev" } } },
      },
      {},
    );
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toEqual({ name: "dup", origin: "projectLocal", config: { type: "http", url: "https://high.dev" } });
    expect(r.warnings.some((w) => w.server === "dup" && w.reason.includes("redefined by higher source"))).toBe(true);
  });
  it("同名同配置=仅告警（x0l 形状不改名）", () => {
    const same = { type: "stdio", command: "c" };
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { d: same } }, managed: { mcpServers: { d: same } } },
      {},
    );
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].origin).toBe("managed");
    expect(r.warnings.some((w) => w.reason.includes("duplicated identically"))).toBe(true);
  });
  it("高来源坏定义=终态 issue（首中即返口径，不回落低层好定义）", () => {
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { d: { type: "stdio", command: "ok" } } }, flag: { mcpServers: { d: { type: "stdio" } } } },
      {},
    );
    expect(r.servers).toHaveLength(0);
    expect(r.issues).toEqual([{ name: "d", origin: "flag", code: "UNCONFIGURED", message: 'stdio MCP server "d" requires command' }]);
  });
  it("异名并集+排序稳定输出；null/缺席 doc 跳过不炸", () => {
    const r = loadMcpServerConfigs(
      { user: { mcpServers: { beta: { command: "b" } } }, projectShared: null, managed: { mcpServers: { alpha: { command: "a" } } } },
      {},
    );
    expect(r.servers.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(r.servers[0].config).toMatchObject({ type: "stdio", command: "a" });
    expect(r.servers[0].origin).toBe("managed");
    expect(r.servers[1].origin).toBe("user");
  });
});
