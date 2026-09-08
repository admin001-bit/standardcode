// WP-09（M2）harness fileHistory 钩子测试（判据自足：板 WP-09 DoD① 时序与 DoD⑤ 失败语义）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, Tool } from "../src/types.ts";

function queueProvider(pages: LLMEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    async *stream(_req: LLMRequest) {
      const page = pages[Math.min(i++, pages.length - 1)];
      for (const ev of page) yield ev;
    },
  };
}

const STOP: LLMEvent[] = [{ type: "finish", reason: "completed", raw: "end_turn" }];

const WRITE_TOOL: Tool = {
  name: "Write",
  description: "write",
  inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  isConcurrencySafe: true,
  execute: async (input) => `wrote ${(input as { file_path: string }).file_path}`,
};

const TOOL_RESULT_END: LLMEvent[] = [
  { type: "tool_start", id: "t1", name: "Write" },
  { type: "tool_input_delta", id: "t1", jsonPartial: '{"file_path":"a.txt"}' },
  { type: "tool_end", id: "t1" },
  ...STOP,
];

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    out.push(r.value);
    r = await gen.next();
  }
  return out;
}

describe("WP-09 harness fileHistory 钩子", () => {
  it("门禁全过后执行前触发；快照失败→error tool_result（不静默继续）", async () => {
    const calls: string[] = [];
    const p = queueProvider([TOOL_RESULT_END, STOP]);
    const events = await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [WRITE_TOOL],
        fileHistory: {
          beforeTool: async (name, input) => {
            calls.push(`${name}:${(input as { file_path: string }).file_path}`);
            // 目标态：快照发生在工具执行前——记录器此刻看到文件内容尚为旧值
          },
        },
      }),
    );
    expect(calls).toEqual(["Write:a.txt"]);
    const tr = events.filter((e) => e.type === "tool_result")[0] as any;
    expect(tr.isError).toBe(false); // 正常路径

    const p2 = queueProvider([TOOL_RESULT_END, STOP]);
    const events2 = await collect(
      runAgentLoop({
        provider: p2,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [WRITE_TOOL],
        fileHistory: {
          beforeTool: async () => {
            throw new Error("disk error");
          },
        },
      }),
    );
    const tr2 = events2.filter((e) => e.type === "tool_result")[0] as any;
    expect(tr2.isError).toBe(true);
    expect(tr2.content).toContain("file-history snapshot failed");
  });

  it("deny 的工具不触发快照（门禁先于快照）", async () => {
    const calls: string[] = [];
    const p = queueProvider([TOOL_RESULT_END, STOP]);
    await collect(
      runAgentLoop({
        provider: p,
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [WRITE_TOOL],
        permission: { check: async () => "deny" },
        fileHistory: { beforeTool: async (name) => void calls.push(name) },
      }),
    );
    expect(calls).toEqual([]); // 被拒工具不产生快照
  });
});
