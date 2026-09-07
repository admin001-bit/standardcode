import { describe, expect, it } from "vitest";
import { ANTHROPIC_STOP_REASON_TO_IR, OPENAI_FINISH_REASON_TO_IR, mapFinishReason } from "../src/finish.ts";

describe("Anthropic stop_reason → IR 映射", () => {
  it("已知枚举逐一映射", () => {
    expect(ANTHROPIC_STOP_REASON_TO_IR.end_turn).toBe("completed");
    expect(ANTHROPIC_STOP_REASON_TO_IR.stop_sequence).toBe("completed");
    expect(ANTHROPIC_STOP_REASON_TO_IR.max_tokens).toBe("truncated");
    expect(ANTHROPIC_STOP_REASON_TO_IR.tool_use).toBe("tool_calls");
    expect(ANTHROPIC_STOP_REASON_TO_IR.pause_turn).toBe("paused");
    expect(ANTHROPIC_STOP_REASON_TO_IR.refusal).toBe("filtered");
  });

  it("表键穷尽协议已知 stop_reason 集合", () => {
    // Anthropic Messages API 已知 stop_reason 全集（官方文档口径）
    expect(Object.keys(ANTHROPIC_STOP_REASON_TO_IR).sort()).toEqual(
      ["end_turn", "max_tokens", "pause_turn", "refusal", "stop_sequence", "tool_use"].sort(),
    );
  });
});

describe("OpenAI finish_reason → IR 映射", () => {
  it("已知枚举逐一映射", () => {
    expect(OPENAI_FINISH_REASON_TO_IR.stop).toBe("completed");
    expect(OPENAI_FINISH_REASON_TO_IR.length).toBe("truncated");
    expect(OPENAI_FINISH_REASON_TO_IR.tool_calls).toBe("tool_calls");
    expect(OPENAI_FINISH_REASON_TO_IR.function_call).toBe("tool_calls");
    expect(OPENAI_FINISH_REASON_TO_IR.content_filter).toBe("filtered");
  });

  it("表键穷尽协议已知 finish_reason 集合", () => {
    expect(Object.keys(OPENAI_FINISH_REASON_TO_IR).sort()).toEqual(
      ["content_filter", "function_call", "length", "stop", "tool_calls"].sort(),
    );
  });
});

describe("mapFinishReason 收敛语义", () => {
  it("未知但存在的 raw → other，且原值透传", () => {
    expect(mapFinishReason(ANTHROPIC_STOP_REASON_TO_IR, "novel_reason")).toEqual({
      reason: "other",
      raw: "novel_reason",
    });
  });

  it("null/undefined → unknown（kosong null 语义）", () => {
    expect(mapFinishReason(OPENAI_FINISH_REASON_TO_IR, null)).toEqual({ reason: "unknown", raw: null });
    expect(mapFinishReason(OPENAI_FINISH_REASON_TO_IR, undefined)).toEqual({ reason: "unknown", raw: null });
  });

  it("已知映射保留 raw 供诊断与差异登记", () => {
    expect(mapFinishReason(ANTHROPIC_STOP_REASON_TO_IR, "pause_turn")).toEqual({ reason: "paused", raw: "pause_turn" });
  });
});
