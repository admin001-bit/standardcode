// WP-03（M4）：S-3 local 层留痕读写（settings.local.json `mcpTrust` 映射；ADR-0037 形制=坏 JSON 拒覆盖+
// 追加式合并+schemaVersion:1；agentTrust 同构 M3 WP-09 先例）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMcpTrust, recordMcpTrust } from "../src/index.ts";

const dirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sc-mcp-trust-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("readMcpTrust（读侧 fail-open，agentTrust 同构）", () => {
  it("无文件=空记录", () => {
    const root = fixture();
    expect(readMcpTrust(root)).toEqual({});
    expect(existsSync(path.join(root, ".standardcode", "settings.local.json"))).toBe(false);
  });

  it("坏 JSON=空记录（不抛）；键小写归一；非对象值跳过", () => {
    const root = fixture();
    const file = path.join(root, ".standardcode", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken", "utf8");
    expect(readMcpTrust(root)).toEqual({});
    writeFileSync(file, JSON.stringify({ mcpTrust: { GitHub: { decision: "approved" }, bad: "not-an-object", worse: null } }), "utf8");
    const r = readMcpTrust(root);
    expect(Object.keys(r)).toEqual(["github"]);
    expect(r.github).toEqual({ decision: "approved" });
  });
});

describe("recordMcpTrust（ADR-0037 形制）", () => {
  it("追加式合并：兄弟键与 agentTrust 保留；schemaVersion:1；键小写；文件缺目录自建", () => {
    const root = fixture();
    const file = path.join(root, ".standardcode", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, agentTrust: { "code-x": { confirmedAt: "t0" } }, mcpTrust: { old: { decision: "approved" } } }), "utf8");
    recordMcpTrust(root, "Gh-Proj", { decision: "rejected", transport: "stdio", command: "npx -y srv", confirmedAt: "t1" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.agentTrust).toEqual({ "code-x": { confirmedAt: "t0" } });
    const mt = doc.mcpTrust as Record<string, unknown>;
    expect(Object.keys(mt).sort()).toEqual(["gh-proj", "old"]);
    expect(mt["gh-proj"]).toEqual({ decision: "rejected", transport: "stdio", command: "npx -y srv", confirmedAt: "t1" });
    // 读回一致（round-trip）
    expect(readMcpTrust(root)["gh-proj"]).toEqual({ decision: "rejected", transport: "stdio", command: "npx -y srv", confirmedAt: "t1" });
  });

  it("坏 JSON 拒覆盖（写侧保守，抛错不写）；mcpTrust 非对象=重建映射不砸兄弟键", () => {
    const root = fixture();
    const file = path.join(root, ".standardcode", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken", "utf8");
    expect(() => recordMcpTrust(root, "x", { decision: "approved" })).toThrow(/refusing to overwrite/);
    expect(readFileSync(file, "utf8")).toBe("{ broken");
    writeFileSync(file, JSON.stringify({ mcpTrust: "garbage", keep: 1 }), "utf8");
    recordMcpTrust(root, "x", { decision: "approved" });
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(doc.keep).toBe(1);
    expect(doc.mcpTrust).toEqual({ x: { decision: "approved" } });
  });
});
