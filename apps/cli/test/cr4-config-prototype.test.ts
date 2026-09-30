// S6-2 回归（全仓审查 2026-10-01 批4）：/config 点路径下钻原型链段拒写——原 `cur["__proto__"]`
// 读到 Object.prototype（非 null/对象）不重置，cur 下钻原型后赋值=进程级污染；constructor/prototype 同通。
// 判别性：修复前三个用例均污染/写穿 Object.prototype（断言恒红）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalSetting } from "../src/config-store.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-cr4-proto-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("S6-2 setLocalSetting 原型链拒写", () => {
  it("__proto__ 段 → 抛错，不污染 Object.prototype、不落盘", () => {
    expect(() => setLocalSetting(root, "__proto__.polluted", true)).toThrow(/unsafe settings key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // 进程级零污染
  });

  it("constructor/prototype 段 → 抛错（同链同通）", () => {
    expect(() => setLocalSetting(root, "constructor.prototype.x", 1)).toThrow(/unsafe settings key/);
    expect(() => setLocalSetting(root, "a.prototype.b", 1)).toThrow(/unsafe settings key/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("正常点路径零回归：嵌套写仍落盘（ui.theme 形制）", () => {
    const target = setLocalSetting(root, "ui.theme", "dark");
    const doc = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    expect((doc.ui as { theme: string }).theme).toBe("dark");
    expect(doc.schemaVersion).toBe(1);
  });
});
