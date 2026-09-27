// F1（2026-09-28）修复回归：shift+tab 残片（ESC[Z）清洗。
// 真机残留两形态：完整序列（\u001b[Z，transcript 实证）与丢 ESC 的行首残形（[Z）；
// 清洗位＝REPL 派发前（main.ts io.lines），因残片在**下一数据块**才被插进行缓冲（键事件时刻不及）。
import { describe, expect, it } from "vitest";
import { stripKeyResidue } from "../src/keybindings.ts";

describe("stripKeyResidue（F1 修复）", () => {
  it("完整残片（ESC[Z）任意位置清除", () => {
    expect(stripKeyResidue("\u001b[Z/usage")).toBe("/usage"); // 真机实测形（/usage 被当聊天）
    expect(stripKeyResidue("\u001b[Z")).toBe(""); // 只按一次 shift+tab 后直接回车（原=白送一个模型轮次）
    expect(stripKeyResidue("a\u001b[Zb")).toBe("ab");
  });

  it("丢 ESC 的残形：仅清行首前缀（不误伤正文中的 [Z）", () => {
    expect(stripKeyResidue("[Z/help")).toBe("/help");
    expect(stripKeyResidue("[Z[Z/help")).toBe("/help");
    expect(stripKeyResidue("见 [Z] 区间")).toBe("见 [Z] 区间");
    expect(stripKeyResidue("用 ABCD[Z 表示")).toBe("用 ABCD[Z 表示");
  });

  it("常规输入零变化（恒等性）", () => {
    expect(stripKeyResidue("/help")).toBe("/help");
    expect(stripKeyResidue("请解释这段代码")).toBe("请解释这段代码");
    expect(stripKeyResidue("")).toBe("");
  });
});
