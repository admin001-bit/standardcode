// WP-13 E2E（v2.8 §12.2 E2E 行、§2 行 M2 DoD③）：边界场景 ①——20+ 文件重构中途装依赖。
// 卡边界："以'无后台任务时的等价断言'执行"（后台任务 M3 才有，B-03）——本场景在单前台 agent-loop 内
// 完成重构+依赖安装穿插，断言无后台任务机制下的等价性：①全部工具轮串行完成无遗留 ②终态 20+ 文件内容
// =预期重构结果（逐文件） ③依赖产物在位 ④"中途装依赖"不打断重构连续性（无悬空 tool_use、会话可续）。
// Provider 全回放（可复现性优先，M1 WP-13 先例形制）；工具/子进程/fs 真实；协议不变量断言全程开启（默认开）。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent, type Tool } from "@standardcode/harness";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-e2e1-"));
});
afterAll(() => {
  // npm 产物（node_modules/package-lock）随临时目录整体清理
});

// —— 夹具 ——

const FILE_COUNT = 22; // "20+ 文件"卡判据
const V1 = (i: number): string => `// module-${i}: v1\nexport function legacy${i}(x: number): number {\n  return x + 1; // TODO refactor\n}\n`;
const V2 = (i: number): string => `// module-${i}: v2 (refactored)\nexport function refactored${i}(x: number): number {\n  return x + 1;\n}\n`;

function seedProject(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "pkg-dep"), { recursive: true });
  for (let i = 1; i <= FILE_COUNT; i++) writeFileSync(join(root, "src", `module-${i}.ts`), V1(i), "utf8");
  // 本地 file: 依赖——npm install 零网络（CI 三平台可复现）
  writeFileSync(join(root, "pkg-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0", main: "index.js" }), "utf8");
  writeFileSync(join(root, "pkg-dep", "index.js"), "module.exports = () => 'dep-ok';\n", "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "refactor-target", version: "0.0.0", private: true, dependencies: { "local-dep": "file:pkg-dep" } }), "utf8");
}

function replay(rounds: LLMEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      for (const ev of rounds[Math.min(i, rounds.length - 1)]) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

// 真实 Write/Edit/Bash 工具面（capabilities 工厂；E2E③ 先例=工具真实，provider 回放）
async function realTools(root: string): Promise<Tool[]> {
  const { createStandardTools } = await import("@standardcode/capabilities");
  return createStandardTools({ cwd: root }) as unknown as Tool[];
}

const writeRound = (id: string, file: string, content: string): LLMEvent[] => [
  { type: "message_start", id: "m", model: "test" },
  { type: "tool_start", id, name: "Write" },
  { type: "tool_input_delta", id, jsonPartial: JSON.stringify({ file_path: file, content }) },
  { type: "tool_end", id },
  { type: "finish", reason: "tool_calls", raw: "tool_use" },
];

const bashRound = (id: string, command: string): LLMEvent[] => [
  { type: "message_start", id: "m", model: "test" },
  { type: "tool_start", id, name: "Bash" },
  { type: "tool_input_delta", id, jsonPartial: JSON.stringify({ command }) },
  { type: "tool_end", id },
  { type: "finish", reason: "tool_calls", raw: "tool_use" },
];

const DONE: LLMEvent[] = [
  { type: "message_start", id: "m", model: "test" },
  { type: "text_delta", text: "refactor complete: 22 modules rewritten, dependency installed mid-way" },
  { type: "finish", reason: "completed", raw: "end_turn" },
];

/** 编排重构轮次：文件 1..N 逐文件 Write 重写；installAfterRound 指定在写完第几个文件后插入装依赖轮（0=不插）。 */
function buildRounds(withInstall: boolean): LLMEvent[][] {
  const rounds: LLMEvent[][] = [];
  let toolId = 0;
  const next = () => `t${++toolId}`;
  for (let i = 1; i <= FILE_COUNT; i++) {
    rounds.push(writeRound(next(), `src/module-${i}.ts`, V2(i)));
    if (withInstall && i === Math.floor(FILE_COUNT / 2)) {
      // 中途装依赖：--loglevel=error 降噪；--no-audit/--no-fund 免网络元数据（本地 file: 依赖零网络）
      rounds.push(bashRound(next(), "npm install --loglevel=error --no-audit --no-fund --no-progress"));
    }
  }
  rounds.push(DONE);
  return rounds;
}

async function collect(gen: AsyncGenerator<AgentEvent, { messages: import("@standardcode/providers").LLMMessage[]; usage: import("@standardcode/providers").TokenUsage | null }>): Promise<{ events: AgentEvent[]; final: { messages: import("@standardcode/providers").LLMMessage[] } }> {
  const events: AgentEvent[] = [];
  let final!: { messages: import("@standardcode/providers").LLMMessage[] };
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      final = r.value;
      break;
    }
    events.push(r.value);
  }
  return { events, final };
}

async function runScenario(root: string, withInstall: boolean): Promise<{ events: AgentEvent[]; finalMessages: import("@standardcode/providers").LLMMessage[] }> {
  const provider = replay(buildRounds(withInstall));
  const tools = await realTools(root);
  const gen = runAgentLoop({
    provider,
    model: "m",
    system: "refactor e2e",
    messages: [{ role: "user", content: [{ type: "text", text: `refactor all ${FILE_COUNT} modules${withInstall ? " and install dependencies mid-way" : ""}` }] }],
    tools,
    maxToolRounds: 40,
  });
  const { events, final } = await collect(gen as never);
  return { events, finalMessages: final.messages };
}

function assertRefactorComplete(root: string): void {
  for (let i = 1; i <= FILE_COUNT; i++) {
    const p = join(root, "src", `module-${i}.ts`);
    expect(readFileSync(p, "utf8")).toBe(V2(i)); // 逐文件终态=预期重构结果
  }
}

// —— 场景本体 ——

describe("E2E ① 20+ 文件重构中途装依赖（无后台任务等价断言，M2 DoD③）", () => {
  it("单前台 agent-loop：22 文件 Write 重写+第 11 轮后真实 npm install（本地 file: 依赖零网络）→ 全部工具轮串行完成、无悬空 tool_use、逐文件终态=重构结果、依赖产物在位", async () => {
    const root = join(dir, "with-install");
    seedProject(root);
    const { events, finalMessages } = await runScenario(root, true);

    // ① 全部工具轮串行完成：22 Write+1 Bash=23 tool_result，全部非 error
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results).toHaveLength(FILE_COUNT + 1);
    expect(results.filter((r) => r.isError)).toHaveLength(0);
    // 无后台任务面（B-03）：不存在任何"转后台/任务注册"事件形态——事件流只含前台已知类型
    for (const e of events) expect(["turn_start", "text_delta", "tool_start", "tool_result", "usage", "finish", "done"]).toContain(e.type);

    // ② 无悬空 tool_use（协议硬不变量，全程开启）——基于 loop 终态历史全量核对（E2E③ countDangling 同口径）
    const toolUseIds = finalMessages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c): c is Extract<typeof c, { type: "tool_use" }> => (c as { type: string }).type === "tool_use").map((c) => c.id) : []));
    const resultIds = new Set(results.map((r) => r.id));
    expect(toolUseIds).toHaveLength(FILE_COUNT + 1); // 22 Write+1 Bash
    for (const id of toolUseIds) expect(resultIds.has(id)).toBe(true);

    // ③ 依赖产物在位（npm install 真实子进程产物）
    expect(existsSync(join(root, "node_modules", "local-dep", "index.js"))).toBe(true);

    // ④ 逐文件终态=预期重构结果（装依赖穿插不打断重构连续性）
    assertRefactorComplete(root);

    // ⑤ 会话终态 done 且助手收尾文本入 loop 终态历史（TurnState.messages=收尾 assistant 在列）
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end" });
    const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
    expect(JSON.stringify(lastAssistant)).toContain("refactor complete");
  }, 60_000);

  it("等价断言：同构重构无装依赖插入（对照）→ 22 文件终态与'中途装依赖'版逐文件一致（无后台任务机制的等价性）", async () => {
    const rootA = join(dir, "with-install-equiv");
    const rootB = join(dir, "no-install-equiv");
    seedProject(rootA);
    seedProject(rootB);
    await runScenario(rootA, true);
    await runScenario(rootB, false); // 对照组：纯重构不装依赖
    // 等价性：两条路径的重构产物逐文件一致（依赖安装不改变重构结果）；对照组无 node_modules
    for (let i = 1; i <= FILE_COUNT; i++) {
      const a = readFileSync(join(rootA, "src", `module-${i}.ts`), "utf8");
      const b = readFileSync(join(rootB, "src", `module-${i}.ts`), "utf8");
      expect(a).toBe(b);
      expect(a).toBe(V2(i));
    }
    expect(existsSync(join(rootA, "node_modules", "local-dep"))).toBe(true);
    expect(existsSync(join(rootB, "node_modules"))).toBe(false);
  }, 90_000);
});
