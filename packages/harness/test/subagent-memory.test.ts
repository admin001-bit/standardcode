// WP-06（M4）MEM-030：agent 定义 memory 键消费——只读三件套自动补（DoD⑤）+primed 预热注入（messages 首条载体）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { parseAgentMarkdown } from "../src/agent-definitions.ts";
import { runSubagent } from "../src/subagent.ts";
import type { Tool } from "../src/types.ts";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    async *stream() {
      yield { type: "message_start", id: "m", model: "test" };
      yield { type: "text_delta", text: "done" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } };
      yield { type: "finish", reason: "completed", raw: "end_turn" };
    },
    countTokens: async () => 0,
  };
}

const readTool: Tool = { name: "Read", inputSchema: { type: "object" }, description: "t", execute: async () => "r", isConcurrencySafe: true };
const bashTool: Tool = { name: "Bash", inputSchema: { type: "object" }, description: "t", execute: async () => "b", isConcurrencySafe: true };

describe("MEM-030（WP-06 DoD⑤）", () => {
  it("memory 键解析入 def（三值合法；非法告警）", () => {
    const ok = parseAgentMarkdown("---\nname: a\ndescription: d\nmemory: project\n---\nbody", "a.md");
    expect(ok.def?.memory).toBe("project");
    expect(ok.warnings.some((w) => w.includes("not consumed"))).toBe(false);
    const bad = parseAgentMarkdown("---\nname: a\ndescription: d\nmemory: secret\n---\nbody", "a.md");
    expect(bad.def?.memory).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes("memory 'secret' not in"))).toBe(true);
  });

  it("启用 memory 的 agent=只读三件套自动补（def.tools 白名单外也补；WP-09 O2 回补）", async () => {
    const parsed = parseAgentMarkdown("---\nname: a\ndescription: d\nmemory: project\ntools:\n  - Bash\n---\nbody", "a.md");
    const r = await runSubagent({ definition: parsed.def!, prompt: "p", description: "d", agentType: "a", background: false }, {
      provider: fakeProvider(),
      model: "m",
      tools: [bashTool, readTool],
      newAgentId: () => "a1",
    });
    expect(r.status).toBe("completed");
    void r;
  });

  it("primedAgentMemory 注入=messages 首条 <agent-memory> 载体（Golden 面零影响）", async () => {
    const parsed = parseAgentMarkdown("---\nname: a\ndescription: d\nmemory: project\n---\nbody", "a.md");
    let seen: unknown = null;
    const provider: ProviderAdapter = {
      ...fakeProvider(),
      async *stream(req) {
        seen = req.messages;
        yield { type: "message_start", id: "m", model: "test" };
        yield { type: "text_delta", text: "done" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } };
        yield { type: "finish", reason: "completed", raw: "end_turn" };
      },
    };
    await runSubagent({ definition: parsed.def!, prompt: "p", description: "d", agentType: "a", background: false }, { provider, model: "m", tools: [readTool], primedAgentMemory: "PRIMED-CONTENT", newAgentId: () => "a2" });
    const first = (seen as { 0: { content: { text?: string }[] } })[0];
    expect(JSON.stringify(first)).toContain("<agent-memory>PRIMED-CONTENT</agent-memory>");
  });
});
