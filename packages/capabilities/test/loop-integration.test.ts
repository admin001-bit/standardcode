// 集成测试（WP-07 DoD ②③）：六工具各一真实调用经主循环（runAgentLoop，协议不变量断言默认开）回灌成功；
// 畸形输入（缺 required）被 schema 校验拒绝 fail-closed；未知工具名 fail-closed。
// Provider 为脚本化回放（事件 IR 直喂），工具执行是真实的（真实 fs/子进程）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent } from "@standardcode/harness";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createStandardTools } from "../src/index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-cap-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function toolRound(id: string, name: string, input: unknown): LLMEvent[] {
  return [
    { type: "message_start", id: "msg", model: "test" },
    { type: "tool_start", id, name },
    { type: "tool_input_delta", id, jsonPartial: JSON.stringify(input) },
    { type: "tool_end", id },
    { type: "finish", reason: "tool_calls", raw: "tool_use" },
  ];
}

const FINAL_ROUND: LLMEvent[] = [
  { type: "message_start", id: "msg", model: "test" },
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "completed", raw: "end_turn" },
];

function scriptedProvider(rounds: LLMEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => ({
      contextWindow: 200_000,
      maxOutputTokens: { default: 8192, upper: 8192 },
      thinking: "none",
      input: ["text"],
      streaming: true,
      toolCalling: true,
      cache: { ttlLevels: ["5m"], explicitBreakpoints: false },
    }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      void req;
      for (const ev of rounds[Math.min(i, rounds.length - 1)]) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

async function runLoop(rounds: LLMEvent[][]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runAgentLoop({ provider: scriptedProvider(rounds), model: "test", messages: [], tools: createStandardTools({ cwd: dir }) })) {
    events.push(ev);
  }
  return events;
}

afterEach(() => {
  delete process.env.STANDARD_CODE_SHELL;
});

describe("six tools through the real main loop (DoD ②)", () => {
  it("chains Bash→Write→Read→Edit→Grep→Glob, each tool_result error-free, loop ends cleanly", async () => {
    const events = await runLoop([
      toolRound("c1", "Bash", { command: `node -e "process.stdout.write('loop-bash-ok')"` }),
      toolRound("c2", "Write", { file_path: "a.txt", content: "hello standardcode\n" }),
      toolRound("c3", "Read", { file_path: "a.txt" }),
      toolRound("c4", "Edit", { file_path: "a.txt", old_string: "standardcode", new_string: "standardcode v2" }),
      toolRound("c5", "Grep", { pattern: "v2" }),
      toolRound("c6", "Glob", { pattern: "**/*.txt" }),
      FINAL_ROUND,
    ]);

    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => r.name)).toEqual(["Bash", "Write", "Read", "Edit", "Grep", "Glob"]);
    for (const r of results) expect(`${r.name}:${r.isError}`).toBe(`${r.name}:false`);

    const byName = new Map(results.map((r) => [r.name, r.content]));
    expect(byName.get("Bash")).toContain("loop-bash-ok");
    expect(byName.get("Read")).toContain("hello standardcode");
    expect(byName.get("Grep")).toContain("a.txt:1: hello standardcode v2");
    expect(byName.get("Glob")).toContain("a.txt");

    // 文件真实落盘且 Edit 生效
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello standardcode v2\n");

    const done = events.filter((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done").at(-1);
    expect(done?.reason).toBe("end");
  }, 30000);
});

describe("fail-closed inputs (DoD ③)", () => {
  it("missing required property rejected by schema validation, loop continues to clean end", async () => {
    const events = await runLoop([toolRound("f1", "Read", {}), FINAL_ROUND]);
    const result = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")[0]!;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("input failed schema validation");
    expect(result.content).toContain("file_path");
    const done = events.filter((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done").at(-1);
    expect(done?.reason).toBe("end");
  });

  it("unknown tool name rejected without execution", async () => {
    const events = await runLoop([toolRound("f2", "NoSuchTool", {}), FINAL_ROUND]);
    const result = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")[0]!;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool: NoSuchTool");
  });
});
