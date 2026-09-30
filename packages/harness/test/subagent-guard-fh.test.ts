// S3-2（全仓审查 2026-10-01）：runSubagent guard/fileHistory 透传——子代理工具链与主循环同守
// guard-path 硬闸（stop 硬停）与 file-history 写盘前快照。判别性：不传字段=原语义（执行照常），
// 传 stop 护栏=执行零发生（修复前 SubagentRunContext 无此字段，透传用例整体不可表达）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { runSubagent } from "../src/subagent.ts";
import type { Tool } from "../src/types.ts";

const NORMALIZED: Parameters<typeof runSubagent>[0] = {
  prompt: "do it",
  description: "d",
  agentType: "general-purpose",
  definition: { name: "general-purpose", description: "all tools" },
  background: false,
};

/** 队列 provider：第 1 页发 tool_use，第 2 页收尾文本；捕获每轮请求。 */
function toolThenTextProvider(input: Record<string, unknown>, finalText: string, reqs: LLMRequest[]): ProviderAdapter {
  let round = 0;
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(req: LLMRequest): AsyncGenerator<LLMEvent> {
      reqs.push({ ...req, messages: structuredClone(req.messages) });
      yield { type: "message_start", id: "m", model: "m" } as LLMEvent;
      if (round++ === 0) {
        yield { type: "tool_start", id: "t1", name: "Write" } as LLMEvent;
        yield { type: "tool_input_delta", id: "t1", jsonPartial: JSON.stringify(input) } as LLMEvent;
        yield { type: "tool_end", id: "t1" } as LLMEvent;
        yield { type: "finish", reason: "tool_calls", raw: "tool_use" } as LLMEvent;
      } else {
        yield { type: "text_delta", text: finalText } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      }
    },
  };
}

describe("S3-2：SubagentRunContext guard 透传", () => {
  it("guard stop → 子代理 Write 硬停：工具零执行，tool_result=guard-path stop，第二轮请求可见", async () => {
    let executed = 0;
    const writeTool: Tool = {
      name: "Write",
      description: "d",
      inputSchema: { type: "object" },
      execute: async () => {
        executed++;
        return "written";
      },
    };
    const reqs: LLMRequest[] = [];
    const provider = toolThenTextProvider({ file_path: "x/.git/evil", content: "pwn" }, "done", reqs);
    const r = await runSubagent(NORMALIZED, {
      provider,
      model: "m",
      tools: [writeTool],
      guard: { check: () => ({ action: "stop", rule: "protected-metadata", detail: "write into protected metadata directory" }) },
    });
    expect(r.status).toBe("completed");
    expect(executed).toBe(0); // 修复前：无 guard 字段 → 直接执行落盘
    const round2 = JSON.stringify(reqs[1]!.messages);
    expect(round2).toContain("guard-path stop (protected-metadata)");
    expect(round2).not.toContain('"written"');
  });

  it("guard 缺省（不传）= 原语义：工具正常执行（透传字段非强加行为）", async () => {
    let executed = 0;
    const writeTool: Tool = {
      name: "Write",
      description: "d",
      inputSchema: { type: "object" },
      execute: async () => {
        executed++;
        return "written";
      },
    };
    const reqs: LLMRequest[] = [];
    const provider = toolThenTextProvider({ file_path: "ok.txt", content: "x" }, "done", reqs);
    const r = await runSubagent(NORMALIZED, { provider, model: "m", tools: [writeTool] });
    expect(r.status).toBe("completed");
    expect(executed).toBe(1);
  });
});

describe("S3-2：SubagentRunContext fileHistory 透传", () => {
  it("fileHistory.beforeTool 在工具执行前触发（Write 带 input），执行后透传照旧", async () => {
    const order: string[] = [];
    const writeTool: Tool = {
      name: "Write",
      description: "d",
      inputSchema: { type: "object" },
      execute: async () => {
        order.push("execute");
        return "written";
      },
    };
    const reqs: LLMRequest[] = [];
    const provider = toolThenTextProvider({ file_path: "ok.txt", content: "x" }, "done", reqs);
    const seen: unknown[] = [];
    const r = await runSubagent(NORMALIZED, {
      provider,
      model: "m",
      tools: [writeTool],
      fileHistory: {
        beforeTool: async (name, input) => {
          order.push("snapshot");
          seen.push([name, input]);
        },
      },
    });
    expect(r.status).toBe("completed");
    expect(order).toEqual(["snapshot", "execute"]); // 快照先于写盘
    expect(seen[0]).toEqual(["Write", { file_path: "ok.txt", content: "x" }]);
  });

  it("fileHistory 缺省 = 不触发（原语义）", async () => {
    const writeTool: Tool = { name: "Write", description: "d", inputSchema: { type: "object" }, execute: async () => "w" };
    const reqs: LLMRequest[] = [];
    const provider = toolThenTextProvider({ file_path: "ok.txt", content: "x" }, "done", reqs);
    const r = await runSubagent(NORMALIZED, { provider, model: "m", tools: [writeTool] });
    expect(r.status).toBe("completed");
    expect(reqs).toHaveLength(2);
  });
});
