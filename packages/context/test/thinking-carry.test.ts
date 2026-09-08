// WP-06（M2）压缩继承+session 解析测试（判据自足：板 WP-06 DoD②③）。
import { describe, expect, it } from "vitest";
import { carryThinkingConfig } from "../src/compact/thinking-carry.ts";

describe("WP-06 压缩继承接缝（DoD②）", () => {
  it("会话 thinking 配置原样进压缩请求配置（adaptive/budget/off）", () => {
    expect(carryThinkingConfig({ type: "adaptive" })).toEqual({ type: "adaptive" });
    expect(carryThinkingConfig({ type: "budget", budgetTokens: 4096 })).toEqual({ type: "budget", budgetTokens: 4096 });
    expect(carryThinkingConfig(undefined)).toBeUndefined(); // 会话未配置=压缩同样不携带（一致）
  });
});
