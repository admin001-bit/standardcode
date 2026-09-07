// WP-08 broker 单测：四模式映射/循环序（EXE-001）、规则语法与评估序（deny→ask→allow 首匹配）、
// Plan 模式改文件类 Bash 拦截（[CC] 2.1.212 回归）、deny 恒赢 fail-closed（B-13）、allow 禁裸通配。
import { describe, expect, it } from "vitest";
import {
  PERMISSION_MODES,
  createPermissionBroker,
  globMatch,
  isMutatingBash,
  parseRule,
  parseRuleset,
  ruleMatches,
} from "../src/permission-broker/index.ts";

const READ = { file_path: "src/a.ts" };
const CMD = (command: string) => ({ command });

describe("mode mapping & cycle (EXE-001)", () => {
  it("four modes, cycle order default→acceptEdits→plan→bypassPermissions→default (no auto)", () => {
    expect(PERMISSION_MODES).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    const b = createPermissionBroker();
    expect(b.mode()).toBe("default");
    expect(b.cycle()).toBe("acceptEdits");
    expect(b.cycle()).toBe("plan");
    expect(b.cycle()).toBe("bypassPermissions");
    expect(b.cycle()).toBe("default");
  });

  it("default mode → ask everything (Manual)", () => {
    const b = createPermissionBroker();
    expect(b.evaluate("Bash", CMD("echo hi"))).toMatchObject({ decision: "ask" });
  });

  it("bypassPermissions (Auto) → allow", () => {
    const b = createPermissionBroker({ mode: "bypassPermissions" });
    expect(b.evaluate("Bash", CMD("rm -rf x"))).toMatchObject({ decision: "allow", reason: /bypassPermissions/ });
  });

  it("acceptEdits → Write/Edit allow, others ask", () => {
    const b = createPermissionBroker({ mode: "acceptEdits" });
    expect(b.evaluate("Write", { file_path: "a.txt", content: "x" })).toMatchObject({ decision: "allow" });
    expect(b.evaluate("Edit", { file_path: "a.txt", old_string: "a", new_string: "b" })).toMatchObject({ decision: "allow" });
    expect(b.evaluate("Bash", CMD("echo hi"))).toMatchObject({ decision: "ask" });
  });
});

describe("plan mode hard gate ([CC] 2.1.212 regression surface)", () => {
  it("blocks Write/Edit unconditionally", () => {
    const b = createPermissionBroker({ mode: "plan" });
    expect(b.evaluate("Write", { file_path: "a.txt", content: "x" }).decision).toBe("deny");
    expect(b.evaluate("Edit", { file_path: "a.txt", old_string: "a", new_string: "b" }).decision).toBe("deny");
  });

  it("allows read-only tools", () => {
    const b = createPermissionBroker({ mode: "plan" });
    expect(b.evaluate("Read", READ).decision).toBe("allow");
    expect(b.evaluate("Glob", { pattern: "**/*" }).decision).toBe("allow");
    expect(b.evaluate("Grep", { pattern: "x" }).decision).toBe("allow");
    expect(b.evaluate("Bash", CMD("git status")).decision).toBe("allow");
    expect(b.evaluate("Bash", CMD("ls -la && rg foo")).decision).toBe("allow");
  });

  it("isMutatingBash fail-closed: redirects, command substitution, pipes with non-readonly heads, wrappers", () => {
    expect(isMutatingBash("echo hi > out.txt")).toBe(true);
    expect(isMutatingBash("cat a >> b")).toBe(true);
    expect(isMutatingBash("echo $(touch x)")).toBe(true);
    expect(isMutatingBash("ls | rm -rf /")).toBe(true); // 管道段首词白名单外
    expect(isMutatingBash("sudo apt install x")).toBe(true);
    expect(isMutatingBash("git commit -m x")).toBe(true);
    expect(isMutatingBash("git push")).toBe(true);
    expect(isMutatingBash("sed -i s/a/b/ f.txt")).toBe(true);
    // 只读白名单
    expect(isMutatingBash("git log --oneline")).toBe(false);
    expect(isMutatingBash("git diff HEAD~1")).toBe(false);
    expect(isMutatingBash("FOO=1 ls -la")).toBe(false);
    expect(isMutatingBash("rg pattern src/")).toBe(false);
  });

  it("plan mode denies mutating Bash even when an allow rule would match (mode gate before allow rules)", () => {
    const b = createPermissionBroker({ mode: "plan", rules: { allow: ["Bash(rm *)"] } });
    expect(b.evaluate("Bash", CMD("rm -rf /")).decision).toBe("deny");
  });
});

describe("rules: parse & evaluation order (deny → ask → allow, first match wins)", () => {
  it("parseRule Tool(specifier) and bare tool", () => {
    expect(parseRule("Bash(git *)")).toEqual({ tool: "Bash", specifier: "git *" });
    expect(parseRule("Edit(src/**)")).toEqual({ tool: "Edit", specifier: "src/**" });
    expect(parseRule("Read")).toEqual({ tool: "Read", specifier: null });
    expect(() => parseRule("bad tool(x)")).toThrow(/invalid permission rule/);
  });

  it("allow rules reject bare wildcard Bash ([CC] chunk-4svxqcrq)", () => {
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Bash(*)"] }, "allow")).toThrow(/wildcard not supported/);
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Bash"] }, "allow")).toThrow(/wildcard not supported/);
    expect(() => parseRuleset({ deny: ["Bash(*)"], ask: [], allow: [] }, "deny")).not.toThrow(); // deny 允许通配
  });

  it("globMatch: path segments (**, single *) vs bare-command semantics", () => {
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/*", "src/a.ts")).toBe(true);
    expect(globMatch("src/*", "src/a/b.ts")).toBe(false);
    expect(globMatch("git *", "git push origin main")).toBe(true);
    expect(globMatch("git push", "git push origin")).toBe(false);
  });

  it("deny beats ask beats allow regardless of rule order (B-13: deny 恒赢)", () => {
    const b = createPermissionBroker({ rules: { deny: ["Bash(git push*)"], ask: ["Bash(git *)"], allow: ["Bash(git push*)", "Bash(node *)"] } });
    expect(b.evaluate("Bash", CMD("git push origin main"))).toMatchObject({ decision: "deny" });
    expect(b.evaluate("Bash", CMD("git status"))).toMatchObject({ decision: "ask" });
    expect(b.evaluate("Bash", CMD("node -v"))).toMatchObject({ decision: "allow" }); // allow 规则命中
  });

  it("deny wins even in bypassPermissions (deny 恒赢，模式不可解锁)", () => {
    const b = createPermissionBroker({ mode: "bypassPermissions", rules: { deny: ["Edit(src/**)"] } });
    expect(b.evaluate("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" })).toMatchObject({ decision: "deny" });
  });

  it("ruleMatches: specifier subject per tool (Bash command / path tools)", () => {
    expect(ruleMatches(parseRule("Edit(src/**)"), "Edit", { file_path: "src/a.ts" })).toBe(true);
    expect(ruleMatches(parseRule("Edit(src/**)"), "Edit", { file_path: "docs\\a.md" })).toBe(false);
    expect(ruleMatches(parseRule("Read"), "Read", READ)).toBe(true);
  });
});

// —— WP-08×WP-09 集成：guard 通道（runTools 层）——
import { runTools, type Tool } from "../src/index.ts";

function echoTool(name: string): Tool {
  return {
    name,
    description: "test tool",
    inputSchema: { type: "object" },
    isConcurrencySafe: true,
    execute: async () => `${name}-executed`,
  };
}

describe("runTools guard flow (WP-08×WP-09 集成)", () => {
  const registry = { get: (n: string) => (n === "Echo" ? echoTool("Echo") : undefined) };

  it("guard stop → 硬停（先于权限 allow），deny 恒赢（B-13）", async () => {
    const out = await runTools([{ id: "g1", name: "Echo", input: {} }], {
      registry,
      permission: { check: async () => "allow" },
      guard: { check: () => ({ action: "stop", rule: "high-risk-path", detail: "C:\\Windows\\x" }) },
    });
    expect(out[0]).toMatchObject({ isError: true });
    expect(out[0]!.content).toContain("guard-path stop (high-risk-path)");
  });

  it("guard confirm → allow 降为 ask → M1 fail-closed 拒绝（S-9 Auto 不豁免）", async () => {
    const out = await runTools([{ id: "g2", name: "Echo", input: {} }], {
      registry,
      permission: { check: async () => "allow" }, // 模拟 bypassPermissions
      guard: { check: () => ({ action: "confirm", rule: "persistence-path", detail: ".bashrc" }) },
    });
    expect(out[0]!.isError).toBe(true);
    expect(out[0]!.content).toContain("guard-path confirm (persistence-path)");
  });

  it("deny 规则恒赢：deny 后不再被 guard confirm 升降（decision deny 保持）", async () => {
    const out = await runTools([{ id: "g3", name: "Echo", input: {} }], {
      registry,
      permission: { check: async () => "deny" },
      guard: { check: () => ({ action: "confirm", rule: "persistence-path", detail: ".bashrc" }) },
    });
    expect(out[0]!.content).toBe("permission denied: Echo");
  });

  it("guard pass + permission allow → 正常执行", async () => {
    const out = await runTools([{ id: "g4", name: "Echo", input: {} }], {
      registry,
      permission: { check: async () => "allow" },
      guard: { check: () => ({ action: "pass" }) },
    });
    expect(out[0]).toMatchObject({ isError: false, content: "Echo-executed" });
  });
});
