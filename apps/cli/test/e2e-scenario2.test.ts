// WP-12 E2E（v2.8 §12.2 E2E 行）：边界场景 ②——单工具输出 >50K tokens（30K 截断+落盘回传+摘要引用）。
// 行为载体=WP-12 卡内实现（proc.ts spill+[CC] _440.js:5279-5300 stdoutToFile 同构）：30K 字符截断（BASH_OUTPUT_TRUNCATE_CHARS，
// M1 实装锚）+全量输出落盘+返回文本附 "Output truncated (NKB total). Full output saved to: <path>" 引用行。
// 体积换算注记 [自定]：300K ASCII 字符 ≈ 75K tokens（≈4 chars/token 口径）>50K——"输出 >50K tokens"判据以
// 该夹具体积满足；Provider 全回放，工具/子进程/fs 真实（E2E① 先例形制）；协议不变量全程开启。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEvent, type Tool } from "@standardcode/harness";
import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";

let dir: string;
let spillDir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-e2e2-"));
  spillDir = join(dir, "spill");
  mkdirSync(spillDir, { recursive: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BIG_CHARS = 300_000; // ≈75K tokens（>50K，[自定] 4 chars/token 换算注记）
const BIG_CMD = `node -e "process.stdout.write('X'.repeat(${BIG_CHARS}))"`;

function replay(seen: LLMMessage[][]): ProviderAdapter {
  let i = 0;
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      seen.push(structuredClone(req.messages)); // 摘要引用断言面：模型下一轮收到的 tool_result 原文
      for (const ev of (
        [
          [
            { type: "tool_start", id: "tu1", name: "Bash" },
            { type: "tool_input_delta", id: "tu1", jsonPartial: JSON.stringify({ command: BIG_CMD }) },
            { type: "tool_end", id: "tu1" },
            { type: "finish", reason: "tool_calls", raw: "tool_use" },
          ],
          [{ type: "text_delta", text: "Output exceeded the cap; full output saved to file as referenced in the tool result." }, { type: "finish", reason: "completed", raw: "end_turn" }],
        ] as LLMEvent[][]
      )[Math.min(i, 1)])
        yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

async function realTools(root: string, spill: string): Promise<Tool[]> {
  const { createStandardTools } = await import("@standardcode/capabilities");
  const tools = createStandardTools({ cwd: root, spillDir: spill }) as unknown as Tool[];
  return tools;
}

// createStandardTools 不透传 spillDir 到 ExecEnv？——透传面检查：tool-factory 的 ExecEnv 构造
// （env/spillDir 均为会话级字段）；此处若未透传由下方断言失败暴露（fail-visible，不留静默）。

describe("E2E② 单工具输出 >50K tokens：30K 截断+落盘回传+摘要引用", () => {
  it("真实 Bash 子进程：result 截断≤30K+引用行在位+spill 文件=全量输出+下一轮请求含引用（协议不变量开启）", async () => {
    const seen: LLMMessage[][] = [];
    const tools = await realTools(dir, spillDir);
    const events: AgentEvent[] = [];
    let final: { messages: LLMMessage[] } | null = null;
    const gen = runAgentLoop({
      provider: replay(seen),
      model: "claude-test-1",
      messages: [{ role: "user", content: [{ type: "text", text: "run the big output command and summarize" }] }],
      tools,
    });
    for (;;) {
      const step = await gen.next();
      if (step.done === true) {
        final = step.value as { messages: LLMMessage[] };
        break;
      }
      events.push(step.value);
    }

    // ① 30K 截断面：tool_result 事件≤30K 上限内且带截断标记（bash 30_000 chars+标记+引用行）
    const toolResult = events.find((e) => e.type === "tool_result") as { type: "tool_result"; content: string; isError: boolean; name: string };
    expect(toolResult).toBeDefined();
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content.length).toBeLessThanOrEqual(30_500); // 30K+标记+引用行
    expect(toolResult.content).toContain("[output truncated]");
    // ② [CC] :5300 逐字形状引用行（KB 汇总+Full output saved to:）
    const refLine = toolResult.content.split("\n").find((l) => l.startsWith("Output truncated ("));
    expect(refLine).toBeDefined();
    expect(refLine).toMatch(/^Output truncated \(\d+KB total\)\. Full output saved to: .+/);
    const spillPath = refLine!.slice("Output truncated (".length, refLine!.indexOf("KB total)")) && refLine!.replace(/^Output truncated \(\d+KB total\)\. Full output saved to: /, "");
    // ③ 落盘=全量输出（300000 X；截断头部+余部完整）
    expect(existsSync(spillPath)).toBe(true);
    const spilled = readFileSync(spillPath, "utf8");
    expect(spilled.length).toBe(BIG_CHARS); // 全文=全量 stdout（无 stderr，混流序=到达序）
    expect(spilled).toMatch(/^X+$/);
    // ④ 摘要引用断言：下一轮模型请求中的 tool_result 块含引用行（回传面进入对话）
    const nextTurn = seen.at(-1)!;
    const toolResultBlocks = nextTurn.filter((m) => m.role === "user").flatMap((m) => m.content.filter((b) => b.type === "tool_result")) as { content: string }[];
    expect(toolResultBlocks.some((b) => String(b.content).includes("Full output saved to: "))).toBe(true);
    // ⑤ 协议不变量：tool_use 恰配 tool_result（1↔1，无悬空）
    const toolUses = final!.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use") : []));
    expect(toolUses.length).toBe(1);
    expect(events.filter((e) => e.type === "tool_result").length).toBe(1);
    // ⑥ 终态收敛（无 fail-closed 中断面）
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

// —— 落盘全文不变式（V R2 退回补齐：三缺陷形状确定性钉死；初版均匀 300000 夹具对乱序/丢头/窗口三态免疫）——

import { runProcess } from "../../../packages/executor/src/index.ts";

describe("E2E② spill 全文不变式（文件字节=全量 stdout，序=到达序；[CC] #f 单流语义）", () => {
  const CAP = 30_000;
  async function spillOf(args: string[]): Promise<string> {
    const d = mkdtempSync(join(dir, "inv-"));
    const r = await runProcess({ command: process.execPath, args, maxOutputChars: CAP, spill: { dir: d } });
    expect(r.truncated).toBe(true);
    expect(r.spillFile).toBeDefined();
    return readFileSync(r.spillFile!, "utf8");
  }

  // 注：内容在子进程内 .repeat() 构造（非字面量入 -e 参数——Windows spawn 命令行 32K 上限 ENAMETOOLONG）。
  const stdoutScript = (expr: string) => ["-e", `process.stdout.write(${expr})`];

  it("异构跨块：H×40000 + T×260000（首块即越界）→ 文件逐字节=全量且序正确（乱序缺陷回归位）", async () => {
    const full = "H".repeat(40_000) + "T".repeat(260_000);
    const got = await spillOf(stdoutScript(`"H".repeat(40000)+"T".repeat(260000)`));
    expect(got).toBe(full);
  }, 30_000);

  it("单块越界：cap+1000 一块写出 → 头部 30K 不得丢（丢头缺陷回归位）", async () => {
    const full = "E".repeat(31_000);
    const got = await spillOf(stdoutScript(`"E".repeat(31000)`));
    expect(got).toBe(full);
  }, 30_000);

  it("跨 cap 窗口：A×20000+B×20000 → 窗口 (cap−len(cur)) 不得截空（窗口缺陷回归位）", async () => {
    const full = "A".repeat(20_000) + "B".repeat(20_000);
    const got = await spillOf(stdoutScript(`"A".repeat(20000)+"B".repeat(20000)`));
    expect(got).toBe(full);
  }, 30_000);

  it("stderr 越界流全量+[CC] #f 前缀（注：未越界的小流不进 spill=by-design，文件承载=越界流全量）", async () => {
    const got = await spillOf(["-e", `process.stderr.write("E".repeat(31000)+"e1\\n");process.stdout.write("tiny")`]);
    // 溢出的 stderr 流：完整窗口在档（头部 30K 段+溢出段）+整块 [stderr] 前缀（[CC] #f append 形状）
    expect(got.startsWith("[stderr] ")).toBe(true);
    expect(got).toContain("E".repeat(30_000)); // 头窗口完整（丢头/窗口缺陷在此现形）
    expect(got).toContain("e1");
    expect(got.length).toBeGreaterThanOrEqual(31_000 + "[stderr] ".length); // 全量在档
  }, 30_000);
});
