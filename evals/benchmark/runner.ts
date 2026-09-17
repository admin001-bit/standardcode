// WP-11（M3）evals 基建：recorded 模式 runner + 判分四维度（v2.8 §12.2 ENG-030~032 原文：
// "CI recorded 模式、发布前 live 模式；判分维度含完成度/工具效率/上下文开销/破坏性操作数；
// 基准集独立版本化，结论附模型版本号"——live=M5 不实现=卡边界）。
// 任务模型 [自定]（参考设施未在本地材料定位，ENG-030 自建注记）：
//   kind=loop：scripted provider 事件流（recorded 夹具，零网络）驱动 runAgentLoop，判分从事件/终态/磁盘派生；
//   kind=direct：能力函数级任务（注册表/门控/后台翻转等），run() 自报 ScoreCtx，四维度统一判分。
// 本文件同时被 evals/benchmark/benchmark.test.ts（vitest，CI 面）与 report 生成消费——纯函数零副作用。

import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter, TokenUsage } from "../../packages/providers/src/index.ts";
import { runAgentLoop, type AgentEvent, type Tool } from "../../packages/harness/src/index.ts";

/** 夹具模型版本（结论附模型版本号——v0 全部任务跑在此标定的 scripted 夹具上，无 live 调用）。 */
export const BENCHMARK_MODEL = "claude-sonnet-4-6";

export interface ScoreCtx {
  /** 工具调用序列（名+input，自终态 assistant tool_use 块聚合）。 */
  calls: { name: string; input: unknown }[];
  /** 工具结果（isError 面）。 */
  results: { name: string; content: string; isError: boolean }[];
  /** 最终 assistant 文本（末条）。 */
  finalText: string;
  /** usage 四列合计（recorded=夹具值；零 usage 任务=全零）。 */
  usage: Required<TokenUsage>;
  /** loop 事件流（含 finish/done 判别面）。 */
  events: AgentEvent[];
}

export interface DimScore {
  pass: boolean;
  detail: string;
}

export interface TaskResult {
  id: string;
  name: string;
  model: string;
  dims: { completion: DimScore; toolEfficiency: DimScore; contextOverhead: DimScore; destructiveOps: DimScore };
  pass: boolean;
}

export type EvalTask = LoopTask | DirectTask;

/** loop 形态：recorded 事件流驱动 runAgentLoop，四维度自 ctx 派生。 */
export interface LoopTask {
  id: string;
  name: string;
  seed: string;
  kind: "loop";
  sandboxDir: string;
  prompt: string;
  turns: LLMEvent[][];
  tools: Tool[];
  /** 预算面：工具调用数上限 / input+cache_creation token 上限（上下文开销维度）。 */
  budget: { maxToolCalls: number; maxInputTokens: number };
  /** 破坏性操作集：命中即计（destructiveOps 维度=0 判）。缺省=无禁项。 */
  forbidden?: (c: { name: string; input: unknown }) => boolean;
  /** 完成度谓词。 */
  completion: (ctx: ScoreCtx) => boolean;
}

/** direct 形态（能力函数级任务）：run 自报 ctx+completion+可选 forbiddenHits，四维度统一判分。 */
export interface DirectTask {
  id: string;
  name: string;
  seed: string;
  kind: "direct";
  run: () => Promise<{ ctx: ScoreCtx; completion: boolean; completionDetail?: string; forbiddenHits?: number }>;
  directBudget?: { maxToolCalls?: number; maxInputTokens?: number };
}

/** scripted provider（recorded 回放；每轮取对应事件流，usage 快照语义与 render 一致）。 */
export function scriptedProvider(turns: LLMEvent[][]): ProviderAdapter & { seen: LLMMessage[][] } {
  let i = 0;
  const seen: LLMMessage[][] = [];
  return {
    seen,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req: LLMRequest) {
      seen.push(structuredClone(req.messages));
      for (const ev of turns[Math.min(i, turns.length - 1)]) yield ev;
      i++;
    },
  };
}

function usageSum(turns: LLMEvent[][]): Required<TokenUsage> {
  const acc: Required<TokenUsage> = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  // render 口径=轮内末条 usage observe：逐轮取该轮最后一条 usage 事件求和（recorded 确定性聚合）。
  for (const turn of turns) {
    let last: TokenUsage | null = null;
    for (const ev of turn) if (ev.type === "usage") last = ev.usage;
    if (last) {
      acc.inputTokens += last.inputTokens ?? 0;
      acc.outputTokens += last.outputTokens ?? 0;
      acc.cacheCreationTokens += last.cacheCreationTokens ?? 0;
      acc.cacheReadTokens += last.cacheReadTokens ?? 0;
    }
  }
  return acc;
}

export async function runEvalTask(task: EvalTask): Promise<TaskResult> {
  if (task.kind === "direct") {
    const r = await task.run();
    const s = score(task, r.ctx, r.completion, r.completionDetail ?? "");
    if (r.forbiddenHits !== undefined) {
      s.dims.destructiveOps = { pass: r.forbiddenHits === 0, detail: `${r.forbiddenHits} forbidden ops` };
      s.pass = Object.values(s.dims).every((d) => d.pass);
    }
    return s;
  }
  const events: AgentEvent[] = [];
  const provider = scriptedProvider(task.turns);
  const gen = runAgentLoop({
    provider,
    model: BENCHMARK_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: task.prompt }] }],
    tools: task.tools,
  });
  let state = null as null | { messages: LLMMessage[] };
  for (;;) {
    const step = await gen.next();
    if (step.done === true) {
      state = step.value as { messages: LLMMessage[] };
      break;
    }
    events.push(step.value as AgentEvent);
  }
  const calls: ScoreCtx["calls"] = [];
  for (const m of state!.messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") calls.push({ name: b.name, input: b.input });
    }
  }
  const results: ScoreCtx["results"] = [];
  for (const e of events) if (e.type === "tool_result") results.push({ name: e.name, content: e.content, isError: e.isError });
  const finalText = (state!.messages.at(-1)?.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const ctx: ScoreCtx = { calls, results, finalText, usage: usageSum(task.turns), events };
  return score(task, ctx, task.completion(ctx));
}

/** 判分四维度（ENG-030 原文维度名逐一对位）。 */
function score(task: EvalTask, ctx: ScoreCtx, completionPass: boolean, completionDetail = ""): TaskResult {
  const isLoop = task.kind === "loop";
  const forbiddenHits = isLoop ? ctx.calls.filter((c) => (task as LoopTask).forbidden?.(c) ?? false).length : 0;
  const budget = isLoop ? (task as LoopTask).budget : (task as DirectTask).directBudget;
  const dims: TaskResult["dims"] = {
    completion: { pass: completionPass, detail: completionPass ? task.seed : completionDetail || `完成度谓词未过：calls=${ctx.calls.length} final="${ctx.finalText.slice(0, 40)}"` },
    toolEfficiency: {
      pass: !budget || ctx.calls.length <= (budget.maxToolCalls ?? Infinity),
      detail: `${ctx.calls.length}/${budget?.maxToolCalls ?? "-"} tool calls`,
    },
    contextOverhead: {
      pass: !budget || ctx.usage.inputTokens + ctx.usage.cacheCreationTokens <= (budget.maxInputTokens ?? Infinity),
      detail: `${ctx.usage.inputTokens + ctx.usage.cacheCreationTokens}/${budget?.maxInputTokens ?? "-"} input+cacheW tokens`,
    },
    destructiveOps: { pass: forbiddenHits === 0, detail: `${forbiddenHits} forbidden ops` },
  };
  return { id: task.id, name: task.name, model: BENCHMARK_MODEL, dims, pass: Object.values(dims).every((d) => d.pass) };
}

/** 报告题头系谱（WP-09 O2 清偿：派生式取代 v1 硬编码；v0/v1 串=存档题头逐字保留，v2 起新系谱）。 */
function lineageFor(version: string): string {
  if (version === "v0") return "WP-11，M3 DoD②";
  if (version === "v1") return "WP-11；M3 v0 基座+M4 DoD② 扩列";
  return "WP-09；M3 v0 基座+M4 DoD② 扩列+M5 能力族（沙箱/SEC/遥测）扩列+live 门禁";
}

/** 报告渲染（docs/evals/<VERSION>.md 内容面；无时间戳/路径——字节级守卫可比对，日期随 git 留痕）。 */
export function renderReport(results: TaskResult[], version: string): string {
  const passed = results.filter((r) => r.pass).length;
  const pct = ((passed / results.length) * 100).toFixed(1);
  const liveNote = version === "v0" || version === "v1" ? "live 模式=M5 门禁（B-03 不进本板）。" : `live 模式=WP-09 落地（release evals-gate；live 报告 docs/evals/live-${version}.md）。`;
  const lines = [
    `# evals 基准集 ${version} 出分记录（${lineageFor(version)}）`,
    "",
    `> 生成法：\`npm run evals:run\`（recorded 模式，零网络）。本报告由 evals/benchmark/benchmark.test.ts 与运行结果逐字节守卫（漂移=红，重采集=UPDATE_EVALS=1）。`,
    `> 结论模型版本号（ENG-030"结论附模型版本号"）：**${BENCHMARK_MODEL}**（recorded 夹具标定面）；基准集独立版本化=\`evals/benchmark/VERSION\`=${version}。${liveNote}`,
    "",
    `| 任务 | 名称 | 完成度 | 工具效率 | 上下文开销 | 破坏性操作 | 总判 |`,
    `| :-- | :-- | :-- | :-- | :-- | :-- | :-- |`,
  ];
  for (const r of results) {
    const d = (x: DimScore) => (x.pass ? "✓" : `✗(${x.detail})`);
    lines.push(`| ${r.id} | ${r.name} | ${d(r.dims.completion)} | ${d(r.dims.toolEfficiency)} | ${d(r.dims.contextOverhead)} | ${d(r.dims.destructiveOps)} | ${r.pass ? "✓" : "✗"} |`);
  }
  lines.push("", `**得分：${passed}/${results.length}（${pct}%）** 通过面（recorded 四维度全 ✓ 计一分）。`, "");
  return lines.join("\n");
}
