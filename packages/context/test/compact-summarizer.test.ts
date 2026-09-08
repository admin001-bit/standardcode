// WP-04（M2）9 段压缩摘要测试（v2.8 §7.2 CTX-036；判据自足：板 WP-04 DoD①-⑦）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import {
  COMPACT_SECTIONS,
  PARTIAL_SECTION_8,
  PARTIAL_SECTION_9,
  buildCompactPrompt,
  buildCompactRequest,
  assertRequestSize,
  stripAnalysis,
  splitForPartial,
  runCompaction,
  COMPACT_REQUEST_MAX_BYTES,
} from "../src/compact/summarizer.ts";

function echoSummaryProvider(summary: string): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async (req) => Math.ceil(JSON.stringify(req.messages).length / 4),
    async *stream(req: LLMRequest) {
      if (req.tools !== undefined) throw new Error("tools must be absent during compaction");
      yield { type: "text_delta", text: summary } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

const CONVO: LLMRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "q1" }] },
  { role: "assistant", content: [{ type: "text", text: "a1" }] },
];

describe("DoD① 9 段结构齐全且顺序=CTX-036 原文", () => {
  it("COMPACT_SECTIONS 九段名与顺序；prompt 内按序出现", () => {
    expect(COMPACT_SECTIONS).toEqual([
      "Primary Request and Intent",
      "Key Technical Concepts",
      "Files and Code Sections",
      "Errors and fixes",
      "Problem Solving",
      "All user messages",
      "Pending Tasks",
      "Current Work",
      "Optional Next Step",
    ]);
    const p = buildCompactPrompt();
    let last = -1;
    for (const name of COMPACT_SECTIONS) {
      const idx = p.indexOf(name, last + 1);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
    expect(p).toContain("<analysis>"); // 分析包裹指令
    expect(p.toLowerCase()).toContain("verbatim"); // 安全相关指令逐字保留指令在位
    expect(p).toContain("Tool use is not allowed during compaction"); // 禁工具指令
  });
});

describe("DoD② partial 变体 8/9 段", () => {
  it("partial prompt：第 8/9 段=Work Completed/Context for Continuing Work；splitForPartial 边界", () => {
    const p = buildCompactPrompt({ partial: true });
    expect(p).toContain(`8. ${PARTIAL_SECTION_8}`);
    expect(p).toContain(`9. ${PARTIAL_SECTION_9}`);
    expect(p).not.toContain("8. Current Work");
    const { toSummarize, kept } = splitForPartial(CONVO, 1);
    expect(toSummarize).toHaveLength(1);
    expect(kept).toEqual(CONVO.slice(1));
  });
});

describe("DoD③/⑥/⑦ 请求构造：禁工具/前缀共享/≤32MB", () => {
  it("③ 压缩请求无 tools 字段", () => {
    const { request } = buildCompactRequest({ messages: CONVO });
    expect(request.tools).toBeUndefined();
  });

  it("⑥ 前缀共享：原消息逐字节保留在前缀（cache sharing 结构前提）；thinking 经接缝继承", () => {
    const { request, prefix } = buildCompactRequest({ messages: CONVO, thinking: { type: "adaptive" } });
    expect(JSON.stringify(request.messages.slice(0, CONVO.length))).toBe(JSON.stringify(CONVO));
    expect(request.messages).toHaveLength(CONVO.length + 1);
    expect(request.messages[request.messages.length - 1]!.role).toBe("user"); // 末条 user=cache_control 挂点（Anthropic 侧自动）
    expect(request.thinking).toEqual({ type: "adaptive" }); // CTX-021 ②继承
  });

  it("⑦ ≤32MB：正常请求通过；超限请求 assertRequestSize 拒绝（CTX-036）", () => {
    const { request } = buildCompactRequest({ messages: CONVO });
    expect(() => assertRequestSize(request)).not.toThrow();
    const huge: LLMRequest["messages"] = [{ role: "user", content: [{ type: "text", text: "x".repeat(COMPACT_REQUEST_MAX_BYTES + 1) }] }];
    const { request: big } = buildCompactRequest({ messages: huge });
    expect(() => assertRequestSize(big)).toThrow(/too large/);
  });
});

describe("DoD④/⑤ 执行管线：<analysis> 剥离+安全指令逐字保留", () => {
  it("⑤ stripAnalysis：成对标签整段移除；未闭合剥到尾；正文无损", () => {
    expect(stripAnalysis("<analysis>notes</analysis>SUMMARY")).toBe("SUMMARY");
    expect(stripAnalysis("A<analysis>partial")).toBe("A");
    expect(stripAnalysis("keep <b>bold</b>")).toBe("keep <b>bold</b>");
  });

  it("④ 安全指令逐字保留：摘要含安全文本原样透传（管线不加工）", async () => {
    const safety = "Never delete .standardcode directory.";
    const summary = `${safety}\n\n1. Primary Request and Intent`;
    const r = await runCompaction({ provider: echoSummaryProvider(summary), model: "m", messages: CONVO });
    expect(r.summary).toContain(safety); // 逐字
    expect(r.summary).toContain("1. Primary Request and Intent");
  });

  it("runCompaction：pre/post 估算+摘要替换历史+坏流抛错", async () => {
    const r = await runCompaction({
      provider: echoSummaryProvider("<analysis>internal</analysis>1. Primary Request and Intent"),
      model: "m",
      messages: CONVO,
    });
    expect(r.summary).toBe("1. Primary Request and Intent"); // analysis 剥离
    expect(r.preTokens).toBeGreaterThan(0);
    expect(r.postTokens).toBeGreaterThan(0);
    expect(r.newMessages).toEqual([{ role: "user", content: [{ type: "text", text: "1. Primary Request and Intent" }] }]);
    const bad = echoSummaryProvider(""); // 空摘要
    await expect(runCompaction({ provider: bad, model: "m", messages: CONVO })).rejects.toThrow("empty summary");
  });
});

// R-G 修复（2026-09-09 V 退回）：Golden 对比纪律入 CI（v2.8 §12.2 CTX-100"每加一段跑 Golden 对比"）。
// 模板↔基线相等钉死：改模板（如加段）必先重采基线（pnpm golden:capture:compact）再过 golden:compare——
// 本测试变红即纪律闸口，防止"声明跑了对比而实际无记录"复现。【勘误 2026-09-09：3626476 曾重复追加两块同型
// describe（追加式编辑未读回核验），复验发现后删一处，实增 1 例】
describe("Golden 对比纪律（CTX-100；基线=evals/golden/baselines/compact-claude-sonnet-4-6.json）", () => {
  const baselinePath = fileURLToPath(new URL("../../../evals/golden/baselines/compact-claude-sonnet-4-6.json", import.meta.url));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  it("基线 schema/段名/两变体全文与现行模板逐字节一致", () => {
    expect(baseline.schema).toBe("standardcode-golden-compact-snapshot@1");
    expect(baseline.sections).toEqual([...COMPACT_SECTIONS]);
    expect(baseline.partialSections).toEqual([PARTIAL_SECTION_8, PARTIAL_SECTION_9]);
    expect(baseline.variants.full).toBe(buildCompactPrompt());
    expect(baseline.variants.partial).toBe(buildCompactPrompt({ partial: true }));
  });
});

