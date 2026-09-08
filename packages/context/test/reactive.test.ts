// WP-05（M2）reactive+/context 对账测试（v2.8 §7.2 CTX-037/038；判据自足：板 WP-05 DoD①-④）。
import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@standardcode/providers";
import {
  cleanupToolResults,
  contextCollapse,
  nextReactiveStep,
  buildContextGrid,
  renderContextGrid,
  reconcileGrid,
  type ReactiveStep,
} from "../src/context-store/reactive.ts";
import { AUTOCOMPACT_BUFFER, AUTOCOMPACT_WARN_MARGIN } from "../src/context-store/autocompact.ts";

describe("DoD② 瀑布序三级（前者未解决才走后者）", () => {
  it("nextReactiveStep 多级 step 升级：cleanup→collapse→compact→exhausted", () => {
    const seq: Array<ReactiveStep | null> = [null, "tool-result-cleanup", "context-collapse", "auto-compact"];
    expect(nextReactiveStep(null).next).toBe("tool-result-cleanup");
    expect(nextReactiveStep("tool-result-cleanup").next).toBe("context-collapse");
    expect(nextReactiveStep("context-collapse").next).toBe("auto-compact");
    expect(nextReactiveStep("auto-compact").exhausted).toBe(true);
    void seq;
  });
});

describe("DoD① reactive：prompt-too-long 触发面+tokenGap 指标", () => {
  it("瀑布① cleanup：大 tool_result 截断占位+freed 统计；小结果不动", () => {
    const msgs: LLMMessage[] = [
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "x".repeat(20_000) }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t2", content: "small" }] },
    ];
    const r = cleanupToolResults(msgs);
    expect(r.cleaned).toBe(1);
    expect(r.freedChars).toBeGreaterThan(0); // R2 修复：freedTokens→freedChars（字符口径，名实一致）
    const cleaned = r.messages[0]!.content[0] as Extract<LLMMessage["content"][number], { type: "tool_result" }>;
    expect(cleaned.content).toContain("[tool_result truncated: original 20000 chars]");
    expect(msgs[0]!.content[0] as { content: string }).toBeTruthy(); // 原数组未变（新数组）
    expect((msgs[0]!.content[0] as { content: string }).content.length).toBe(20_000);
  });

  it("瀑布② collapse：assistant thinking 块丢弃（文本/tool_use 保留）", () => {
    const msgs: LLMMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "deep thoughts" }, { type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ];
    const r = contextCollapse(msgs);
    expect(r.dropped).toBe(1);
    expect(r.freedChars).toBe("deep thoughts".length);
    expect(r.messages[0]!.content).toEqual([{ type: "text", text: "answer" }]);
  });
});

describe("DoD③ /context 输出与 usage meter 对账（复用 M1 WP-05 口径）", () => {
  it("网格分类占用+buffer 33k 互证+free space；usage 四列对账行", () => {
    const grid = buildContextGrid({
      window: 200_000,
      systemChars: 8_000,
      toolsChars: 12_000,
      memoryChars: 4_000,
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      usage: { inputTokens: 10_000, outputTokens: 500, cacheCreationTokens: 100, cacheReadTokens: 2_000 },
    });
    expect(grid.autocompactBuffer).toBe(AUTOCOMPACT_BUFFER + AUTOCOMPACT_WARN_MARGIN); // 33000（附录 A 互证）
    expect(grid.sections.map((s) => s.name)).toEqual([
      "System prompt",
      "System tools",
      "Custom agents",
      "Memory files",
      "Skills",
      "Messages",
    ]);
    expect(grid.sections.find((s) => s.name === "Custom agents")!.tokens).toBe(0); // M2 占位
    expect(grid.freeSpace).toBe(200_000 - (2_000 + 3_000 + 0 + 1_000 + 0 + grid.sections[5]!.tokens) - 33_000);
    const text = renderContextGrid(grid);
    expect(text).toContain("usage(api): in=10000 out=500 cache_w=100 cache_r=2000 total=12600");
    expect(text).toContain("estimate vs api:"); // O1：误差标注尾行（ADR-0027 决策 3 MUST）
    expect(text).toContain("API usage is authoritative");
    const rec = reconcileGrid(grid);
    expect(rec.actualInput).toBe(10_000);
    expect(rec.errorRatio).not.toBeNull();
  });

  it("DoD④ schema 字段对照 _670.js 清单（对照口径入测试）：sections/free/usage 齐全", () => {
    const grid = buildContextGrid({ window: 100_000, systemChars: 0, toolsChars: 0, memoryChars: 0, messages: [], usage: null });
    expect(grid).toHaveProperty("sections");
    expect(grid).toHaveProperty("freeSpace");
    expect(grid).toHaveProperty("window");
    expect(reconcileGrid(grid).actualInput).toBeNull(); // 无 usage → 对账列空
  });
});
