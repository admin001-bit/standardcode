// M8-WP-06（ADR-0053）：/update 源选择解析（显式 env 逃逸舱；缺省 npm；非法值 fail-closed 不静默回落）。
import { describe, expect, it } from "vitest";
import { UPDATE_SOURCE_ENV_KEY, parseUpdateSource } from "../src/updater.ts";

describe("M8-WP-06 源选择解析（parseUpdateSource）", () => {
  it("env 键名逐字（ADR-0053 决策 1）", () => {
    expect(UPDATE_SOURCE_ENV_KEY).toBe("STANDARD_CODE_UPDATE_SOURCE");
  });

  it("缺省形（undefined/空串/纯空白）→ npm（向后兼容：未设＝旧行为）", () => {
    expect(parseUpdateSource(undefined)).toBe("npm");
    expect(parseUpdateSource("")).toBe("npm");
    expect(parseUpdateSource("   ")).toBe("npm");
  });

  it("非缺省形与大小写/空白归一：npm／github 各形", () => {
    expect(parseUpdateSource("npm")).toBe("npm");
    expect(parseUpdateSource("NPM")).toBe("npm");
    expect(parseUpdateSource(" npm ")).toBe("npm");
    expect(parseUpdateSource("github")).toBe("github");
    expect(parseUpdateSource("GitHub")).toBe("github");
    expect(parseUpdateSource("\tGitHub\n")).toBe("github");
  });

  it("非法值 → null（调用方 fail-closed 点名原值，不静默回落）", () => {
    for (const bad of ["gh", "git", "npm@latest", "1", "npm github", "releases"]) {
      expect(parseUpdateSource(bad), bad).toBeNull();
    }
  });
});
