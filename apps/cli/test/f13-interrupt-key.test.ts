// F13（2026-09-29 真机实测）修复回归：中断键判定（单源谓词 isInterruptKey）。
// 关键形制：node readline 对**孤立 ESC** 的 keypress 形＝`{ name: undefined, meta: true }`（实测，
// 裸 ESC 被当 meta 前缀）——按 name==="escape" 判会漏（初版即此错，真机转红后修）。
import { describe, expect, it } from "vitest";
import { isInterruptKey } from "../src/keybindings.ts";

describe("isInterruptKey（F7 ctrl+c / F13 裸 Esc）", () => {
  it("Ctrl+C 命中（保留键语义）", () => {
    expect(isInterruptKey({ name: "c", ctrl: true })).toBe(true);
    expect(isInterruptKey({ name: "c", ctrl: true, shift: true } as never)).toBe(true);
  });

  it("孤立 ESC 命中（真机实测形：name 缺失、meta=true）", () => {
    expect(isInterruptKey({ name: undefined, meta: true, ctrl: false, alt: false })).toBe(true);
  });

  it("宿主给 name=\"escape\" 的形也命中", () => {
    expect(isInterruptKey({ name: "escape" })).toBe(true);
    expect(isInterruptKey({ name: "escape", ctrl: false })).toBe(true);
  });

  it("不误触：方向键 / Alt+字母 / Ctrl+Esc / 普通字符", () => {
    expect(isInterruptKey({ name: "up" })).toBe(false);
    expect(isInterruptKey({ name: "down", meta: false })).toBe(false);
    expect(isInterruptKey({ name: "x", meta: true })).toBe(false); // Alt+x
    expect(isInterruptKey({ name: "escape", ctrl: true })).toBe(false);
    expect(isInterruptKey({ name: "a" })).toBe(false);
    expect(isInterruptKey({})).toBe(false);
  });
});
