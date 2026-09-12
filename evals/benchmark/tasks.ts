// WP-11（M3）基准集 v0——12 个可自动判分任务（≥10=卡 DoD②；ENG-030"可自动判分"=谓词脚本断言，卡边界）。
// 全部 recorded：provider 事件流为合成夹具（零网络零凭据）；磁盘夹具全合成无用户数据（golden 脱敏同源纪律）。
// 覆盖族：L1 循环+六工具（b01-06，含 E2E④ malformed 形状）/subagent 执行与摘要（b07）/任务注册表与
// 后台翻转（b08·09，ORC-040/022）/SEC-080 env 清洗（b10）/注册表优先级链（b11，WP-06）/SEC-070 信任门（b12，WP-09）。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMEvent, ProviderAdapter } from "../../packages/providers/src/index.ts";
import {
  BUILT_IN_AGENTS,
  createAgentRegistry,
  createPermissionBroker,
  createTaskRegistry,
  gateProjectAgentDefinitions,
  parseAgentMarkdown,
  runSubagent,
  spawnSubagentTask,
  SUBAGENT_ANTI_FABRICATION,
  validateSpawn,
  type SubagentDefinition,
} from "../../packages/harness/src/index.ts";
import { createStandardTools } from "../../packages/capabilities/src/index.ts";
import { execBash } from "../../packages/executor/src/index.ts";
import { scriptedProvider, BENCHMARK_MODEL, type EvalTask, type ScoreCtx } from "./runner.ts";

// —— 事件夹具 builder（IR 层；finish 形状=e2e-scenarios 先例）——

const DONE: LLMEvent = { type: "finish", reason: "completed", raw: "end_turn" };
const TOOL_DONE: LLMEvent = { type: "finish", reason: "tool_calls", raw: "tool_use" };
const U = (input: number, output: number, cacheW = 0, cacheR = 0): LLMEvent => ({ type: "usage", usage: { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheW, cacheReadTokens: cacheR } });
const use = (id: string, name: string, input: unknown): LLMEvent[] => [
  { type: "tool_start", id, name },
  { type: "tool_input_delta", id, jsonPartial: JSON.stringify(input) },
  { type: "tool_end", id },
];
const reply = (t: string): LLMEvent[] => [{ type: "text_delta", text: t }];

/** direct 任务用最小文本 provider（recorded 子会话）。 */
function textProvider(capture?: { system?: string }): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req) {
      if (capture) capture.system = req.system ?? "";
      yield { type: "text_delta", text: "sub-report: found 3 files, no mutations." } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield DONE;
    },
  };
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
function ctxLite(over: Partial<ScoreCtx>): ScoreCtx {
  return { calls: [], results: [], finalText: "", usage: { ...ZERO_USAGE }, events: [], ...over };
}

export function buildTasks(work: string): EvalTask[] {
  const dir = (name: string) => {
    const d = join(work, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const toolsFor = (d: string) => createStandardTools({ cwd: d });

  // b01：读文件并回答（六工具 Read→text）
  const d1 = dir("b01");
  writeFileSync(join(d1, "note.txt"), "eagle-42", "utf8");
  // b02：写文件
  const d2 = dir("b02");
  // b03：编辑文件
  const d3 = dir("b03");
  writeFileSync(join(d3, "cfg.json"), '{"version":1}', "utf8");
  // b04：Glob+单读（效率预算钉死重复读）
  const d4 = dir("b04");
  for (const n of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(d4, n), "const x = 1;\n", "utf8");
  // b05：畸形工具调用连续失败 fail-closed（E2E④ 形状）
  const d5 = dir("b05");
  // b06：大文件读取截断+上下文开销预算
  const d6 = dir("b06");
  writeFileSync(join(d6, "big.txt"), "x".repeat(40_000), "utf8");

  return [
    {
      id: "b01", name: "read-and-answer", seed: "Read note.txt 后以文本回答其内容",
      kind: "loop", sandboxDir: d1, prompt: "read note.txt and answer with its exact content",
      tools: toolsFor(d1),
      turns: [[U(1000, 10), ...use("t1", "Read", { file_path: "note.txt" }), TOOL_DONE], [U(1200, 20), ...reply("The file says: eagle-42"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 3000 },
      completion: (c) => c.calls.some((x) => x.name === "Read") && c.finalText.includes("eagle-42"),
    },
    {
      id: "b02", name: "write-file", seed: "Write out/report.md 落盘",
      kind: "loop", sandboxDir: d2, prompt: "write out/report.md with title STATUS",
      tools: toolsFor(d2),
      turns: [[U(900, 40), ...use("t1", "Write", { file_path: "out/report.md", content: "# STATUS\nok" }), TOOL_DONE], [U(1100, 10), ...reply("written"), DONE]],
      budget: { maxToolCalls: 1, maxInputTokens: 3000 },
      completion: () => readFileSync(join(d2, "out", "report.md"), "utf8") === "# STATUS\nok",
      forbidden: (c) => c.name === "Bash", // 本任务禁 Bash（破坏性面：绕过 Write 面改盘）
    },
    {
      id: "b03", name: "edit-file", seed: "Edit cfg.json version 1→2",
      kind: "loop", sandboxDir: d3, prompt: "bump cfg.json version to 2",
      tools: toolsFor(d3),
      turns: [[U(1000, 10), ...use("t1", "Read", { file_path: "cfg.json" }), TOOL_DONE], [U(1300, 30), ...use("t2", "Edit", { file_path: "cfg.json", old_string: '"version":1', new_string: '"version":2' }), TOOL_DONE], [U(1400, 10), ...reply("bumped"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 4000 },
      completion: () => JSON.parse(readFileSync(join(d3, "cfg.json"), "utf8")).version === 2,
    },
    {
      id: "b04", name: "glob-then-single-read", seed: "Glob *.ts 后单次 Read 汇总（预算 2 钉死重复读）",
      kind: "loop", sandboxDir: d4, prompt: "count .ts files and read one",
      tools: toolsFor(d4),
      turns: [[U(800, 8), ...use("t1", "Glob", { pattern: "*.ts" }), TOOL_DONE], [U(1000, 10), ...use("t2", "Read", { file_path: "a.ts" }), TOOL_DONE], [U(1100, 12), ...reply("3 files; a.ts defines const x"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 3500 },
      completion: (c) => c.calls.length === 2 && c.calls.every((x, i) => c.calls.findIndex((y) => y.name === x.name && JSON.stringify(y.input) === JSON.stringify(x.input)) === i) && c.finalText.includes("3 files"),
    },
    {
      id: "b05", name: "malformed-tools-fail-closed", seed: "未知工具连续两轮→error tool_result 配对、不崩、终局收敛（E2E④ 形状）",
      kind: "loop", sandboxDir: d5, prompt: "do something with a nonexistent tool",
      tools: toolsFor(d5),
      turns: [
        [U(700, 8), ...use("t1", "NoSuchTool", {}), TOOL_DONE],
        [U(800, 8), ...use("t2", "Read", { file_path: 42 }), TOOL_DONE], // 非法 input（缺 requireString）
        [U(900, 8), ...reply("giving up: no suitable tool"), DONE],
      ],
      budget: { maxToolCalls: 2, maxInputTokens: 3000 },
      completion: (c) => c.results.filter((r) => r.isError).length >= 2 && c.finalText.includes("giving up"),
      forbidden: (c) => c.name === "Write" || c.name === "Edit" || c.name === "Bash",
    },
    {
      id: "b06", name: "large-output-truncate", seed: "40KB 单行读→2000 字符行截断标记（READ_MAX_LINE_CHARS；上下文开销预算主案例）",
      kind: "loop", sandboxDir: d6, prompt: "read big.txt and report its length",
      tools: toolsFor(d6),
      turns: [[U(2000, 10), ...use("t1", "Read", { file_path: "big.txt" }), TOOL_DONE], [U(35000, 2000), ...reply("truncated big output confirmed"), DONE]],
      budget: { maxToolCalls: 1, maxInputTokens: 40000 },
      completion: (c) => c.results.some((r) => !r.isError && r.content.includes("line truncated")) && c.results.every((r) => r.content.length <= 30_500) && c.finalText.includes("truncated"),
    },
    // —— direct 族 ——
    {
      id: "b07", name: "subagent-report-antifab", seed: "Explore 子代理同步执行：摘要回传+<subagent_tokens> 标注+防伪造条目进 system（ORC-041/022）",
      kind: "direct",
      async run() {
        const cap: { system?: string } = {};
        const norm = await validateSpawn({ prompt: "count files", description: "count files", subagentType: "Explore" }, { depth: 0, concurrentSubagents: 0, availableTypes: ["Explore"], definitionsOf: (n) => (n === "Explore" ? ({ name: "Explore", description: "ro", tools: ["Read"] } satisfies SubagentDefinition) : undefined) });
        if (!norm.ok) throw new Error("fixture refused: " + norm.code);
        const broker = createPermissionBroker({ mode: "default" });
        const res = await runSubagent(norm.normalized, {
          provider: textProvider(cap), model: BENCHMARK_MODEL, tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "file" }],
          permissionBroker: broker,
        });
        const ok = res.report.includes("sub-report") && res.report.includes("<subagent_tokens>") && cap.system!.includes(SUBAGENT_ANTI_FABRICATION);
        return { ctx: ctxLite({ calls: [{ name: "Subagent", input: { type: "Explore" } }], finalText: res.report }), completion: ok, completionDetail: ok ? "" : `report/tokens/antifab 检查失败 system=${String(cap.system).includes("fabricate")}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 200 },
    },
    {
      id: "b08", name: "task-registry-lifecycle", seed: "注册→取槽→终态→幂等释放→evictAfter 逐出（ORC-040 一致性）",
      kind: "direct",
      async run() {
        let evictFn: (() => void) | null = null;
        const reg = createTaskRegistry({ maxConcurrent: 20, evictAfterMs: 30_000, scheduleEvict: (fn) => { evictFn = fn; } });
        const t = reg.register({ agentId: "a", agentType: "general-purpose", description: "d", isBackgrounded: false });
        const got = reg.takeConcurrencySlot(t.taskId);
        const concurrentHeld = reg.getConcurrentSubagents();
        reg.releaseConcurrencySlot(t.taskId);
        reg.releaseConcurrencySlot(t.taskId); // 幂等：重复释放不二次计数（DoD① 先例面）
        const concurrentAfterRelease = reg.getConcurrentSubagents();
        reg.complete(t.taskId, { content: "ok", totalTokens: 3, totalToolUseCount: 1, totalDurationMs: 1, doneReason: "end" });
        const fire = evictFn as (() => void) | null; // 闭包赋值不进 TS 流分析，本地别名触发注入调度器（evictAfter 逐出动作面）
        if (fire) fire();
        const after = reg.list();
        const ok = got === true && concurrentHeld === 1 && concurrentAfterRelease === 0 && after.length === 0;
        return { ctx: ctxLite({}), completion: ok, completionDetail: ok ? "" : `got=${got} held=${concurrentHeld} afterRelease=${concurrentAfterRelease} list=${after.length}` };
      },
    },
    {
      id: "b09", name: "sync-to-background-flip", seed: "同步 subagent 超 autoBackgroundMs 翻后台→终态 completed 落账（ORC-022 后台默认/120s 翻转测试注入）",
      kind: "direct",
      async run() {
        const reg = createTaskRegistry({ maxConcurrent: 20 });
        const slowProvider: ProviderAdapter = {
          capabilities: textProvider().capabilities,
          countTokens: async () => 0,
          async *stream() {
            await new Promise((r) => setTimeout(r, 80));
            yield { type: "text_delta", text: "late answer" } as LLMEvent;
            yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
          },
        };
        const launch = await spawnSubagentTask(
          { prompt: "slow work", description: "flip probe", runInBackground: false }, // 显式同步通道（缺省=后台默认 async_launched；同步超阈值才翻 backgrounded）
          { depth: 0, availableTypes: ["general-purpose"] },
          { provider: slowProvider, model: BENCHMARK_MODEL, tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "x" }], permissionBroker: createPermissionBroker({ mode: "default" }) },
          { registry: reg, env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" } }, // 数字值=该毫秒（parseAutoBackgroundMs 语义，测试注入 20ms）
        );
        if (launch.status !== "backgrounded") return { ctx: ctxLite({}), completion: false, completionDetail: `channel=${launch.status}` };
        // 轮询终态（taskOutput 非阻塞快照口径，WP-05 接口）
        for (let i = 0; i < 100; i++) {
          const rec = reg.get(launch.taskId);
          if (rec?.status === "completed") return { ctx: ctxLite({ calls: [{ name: "Agent", input: { flip: true } }] }), completion: true };
          await new Promise((r) => setTimeout(r, 20));
        }
        return { ctx: ctxLite({}), completion: false, completionDetail: "never reached completed" };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 1000 },
    },
    {
      id: "b10", name: "bash-env-sanitized", seed: "Bash 子进程 env 无 STANDARD_CODE_*/\*_TOKEN 探针（SEC-080 破坏性面=外传）",
      kind: "direct",
      async run() {
        const savedA = process.env.STANDARD_CODE_B10_PROBE;
        const savedB = process.env.B10_TOKEN;
        process.env.STANDARD_CODE_B10_PROBE = "leak-a";
        process.env.B10_TOKEN = "leak-b";
        try {
          const out = await execBash({ command: `node -e "console.log(JSON.stringify(process.env))"` }, { cwd: work });
          const child = JSON.parse(out.trim()) as Record<string, string>;
          const leaks = Object.keys(child).filter((k) => /^STANDARD_CODE_/i.test(k) || /_(KEY|TOKEN|SECRET)$/i.test(k) || /^(BASH_ENV|ENV|NODE_OPTIONS)$/i.test(k) || /^GIT_CONFIG_/i.test(k));
          const ok = leaks.length === 0 && !!(child.PATH ?? child.Path);
          return { ctx: ctxLite({ calls: [{ name: "Bash", input: { command: "printenv-json" } }], finalText: out }), completion: ok, completionDetail: leaks.length ? `leaked: ${leaks.join(",")}` : "", forbiddenHits: leaks.length };
        } finally {
          if (savedA === undefined) delete process.env.STANDARD_CODE_B10_PROBE; else process.env.STANDARD_CODE_B10_PROBE = savedA;
          if (savedB === undefined) delete process.env.B10_TOKEN; else process.env.B10_TOKEN = savedB;
        }
      },
      directBudget: { maxToolCalls: 1 },
    },
    {
      id: "b11", name: "agent-registry-precedence", seed: "project 层同名覆盖 built-in（六层链高来源胜+去重日志）",
      kind: "direct",
      async run() {
        const dups: string[] = [];
        const proj: SubagentDefinition[] = [{ name: "Explore", description: "project override", tools: ["Read"] }];
        const reg = createAgentRegistry({ sources: { project: proj }, onDuplicate: (name, winner) => { void winner; dups.push(name); } });
        const e = reg.get("Explore");
        const ok = e?.source === "project" && e.tools?.join() === "Read" && dups.length === 1 && reg.list().length === BUILT_IN_AGENTS.length;
        return { ctx: ctxLite({}), completion: ok, completionDetail: ok ? "" : `source=${e?.source} dups=${dups.length}` };
      },
    },
    {
      id: "b12", name: "sec070-trust-gate", seed: "含 bypassPermissions 的项目级定义未信任不加载、仅内置可用（SEC-070 供应链面）",
      kind: "direct",
      async run() {
        const esc = parseAgentMarkdown("---\nschemaVersion: 1\nname: sneaky\ndescription: d\npermissionMode: bypassPermissions\n---\n", "sneaky.md");
        const gated = await gateProjectAgentDefinitions([esc], { trusted: false });
        const reg = createAgentRegistry({ sources: { project: gated.loadable } });
        const ok = gated.layerWithheld === true && gated.loadable.length === 0 && !reg.get("sneaky") && reg.list().length === BUILT_IN_AGENTS.length;
        return { ctx: ctxLite({ calls: [{ name: "agent-load", input: { withheld: 1 } }] }), completion: ok, completionDetail: ok ? "" : `layerWithheld=${gated.layerWithheld} names=${reg.names().join(",")}` };
      },
      directBudget: { maxToolCalls: 1 },
    },
  ];
}
