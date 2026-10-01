// S6-2 回归（全仓审查 2026-10-01 批4）：/config 点路径下钻原型链段拒写——原 `cur["__proto__"]`
// 读到 Object.prototype（非 null/对象）不重置，cur 下钻原型后赋值=进程级污染；constructor/prototype 同通。
// 判别性：修复前三个用例均污染/写穿 Object.prototype（断言恒红）。
// S6-5（批10）：读-改-写加同步锁（O_EXCL+陈旧抢占）＋temp+rename 原子替换——原直写：双实例并发丢
// 更新、写中断留截断 JSON 使后续全部 refusing to overwrite。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("S6-5 锁＋原子替换", () => {
  it("写后无 .tmp 残留、锁已释放（temp+rename 形）", () => {
    const proj = path.join(root, "s65");
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, "settings.local.json");
    setLocalSetting(proj, "a.b", 1, file);
    expect(readFileSync(file, "utf8")).toContain('"b": 1');
    const leftovers = readdirSync(proj).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]); // 修复前无 tmp（直写）；修复后 tmp 已 rename 消费
    expect(existsSync(`${file}.lock`)).toBe(false); // 锁 finally 释放
  });

  it("新鲜锁持有时拒写（fail-closed busy）；陈旧锁抢占后正常写", () => {
    const proj = path.join(root, "s65b");
    mkdirSync(proj, { recursive: true });
    const file = path.join(proj, "settings.local.json");
    const lock = `${file}.lock`;
    // 新鲜锁（他人正在写）
    writeFileSync(lock, `pid=999999\nts=${Date.now()}`, "utf8");
    expect(() => setLocalSetting(proj, "x.y", 1, file)).toThrow(/settings busy/); // 自旋 ~2s 后 fail-closed
    expect(existsSync(file)).toBe(false); // 未写穿
    // 陈旧锁（>30s，进程已死）→ 抢占成功
    writeFileSync(lock, `pid=999999\nts=${Date.now() - 60_000}`, "utf8");
    setLocalSetting(proj, "x.y", 2, file);
    expect(JSON.parse(readFileSync(file, "utf8")).x).toEqual({ y: 2 });
    expect(existsSync(lock)).toBe(false);
  }, 10_000);
});
