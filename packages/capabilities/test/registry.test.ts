// L3 注册表与元数据单测：§5.3(4) 六字段齐备 + harness 结构兼容锁形 + 并发安全分组。
import { describe, expect, it } from "vitest";
import { CapabilityRegistry, createStandardTools } from "../src/index.ts";
import { createRegistry } from "@standardcode/harness";

const tools = createStandardTools({ cwd: process.cwd() });

describe("tool metadata (§5.3(4): _440.js:177818 同构)", () => {
  it("six tools, complete metadata fields", () => {
    expect(tools.map((t) => t.name)).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type).toBe("object");
      expect(typeof t.searchHint).toBe("string");
      expect(t.searchHint.length).toBeGreaterThan(0);
      expect(typeof t.isConcurrencySafe).toBe("boolean");
      expect(t.deferred).toBe(false);
      expect(typeof t.execute).toBe("function");
    }
  });

  it("isConcurrencySafe: read-only tools parallel, mutating tools serial", () => {
    const safe = tools.filter((t) => t.isConcurrencySafe).map((t) => t.name).sort();
    expect(safe).toEqual(["Glob", "Grep", "Read"]);
  });
});

describe("CapabilityRegistry", () => {
  it("get/list roundtrip; unknown → undefined", () => {
    const reg = new CapabilityRegistry(tools);
    expect(reg.get("Bash")?.name).toBe("Bash");
    expect(reg.get("NoSuchTool")).toBeUndefined();
    expect(reg.list()).toHaveLength(6);
  });

  it("duplicate name rejected", () => {
    expect(() => new CapabilityRegistry([...tools, tools[0]!])).toThrow(/duplicate tool name/);
  });

  it("structure-compatible with harness Tool/ToolRegistry (compile-time shape lock)", () => {
    const reg: import("@standardcode/harness").ToolRegistry = createRegistry(tools);
    expect(reg.get("Read")?.name).toBe("Read");
  });
});
