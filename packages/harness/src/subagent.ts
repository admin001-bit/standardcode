// L1 subagent spawn 校验序列 + 执行器（v2.8 §6 ORC-022、§5.2 session-orchestrator 行；M3 WP-03）。
// 校验序列按序（ORC-022 原文；逐段锚点=A 级 claude-code-subagent.md §4.1，_440.js:177849-178087）：
//   深度上限 3 → description 归一化 → 权限规则 → 预算 → 并发 20 → 类型解析
//   → requiredMCP 30s（M4 前恒跳过：无 MCP 客户端面，钩子留接口）→ isolation → 后台判定。
//   （CC §4.1 的 teammate 规则/插件 hook 段=M6/M4 范围，B-03 不进首版。）
// 执行器（CC §6.2 Kk 运行器同构收敛面）：全新上下文（不携带父会话消息）+独立会话栈（独立 runAgentLoop
//   turn 状态）+权限继承（父 broker 规则共享、agent 定义 permissionMode 覆盖=broker.derive）+结果摘要回传
//   （最后一条 assistant 文本，CC §7.1 Gxt 同构）+<subagent_tokens> 用量标注（CC §7.2 completed 尾注同构）。
// 防伪造条目（ORC-040~042）只落提示词常量（Golden 化=WP-11）。
// 后台通道与 120s 翻转=WP-04（本卡执行器恒同步执行，background 判定结果随归一化输出携带）。

import { runAgentLoop } from "./agent-loop.ts";
import type { PermissionBroker } from "./permission-broker/index.ts";
import type { AgentEvent, ContentBlock, LoopOptions, TokenUsage, Tool, TurnState } from "./types.ts";

/** 结果回传防伪造（ORC-040~042 原文引句；进提示词=WP-03 常量落地，Golden 化=WP-11）。 */
export const SUBAGENT_ANTI_FABRICATION =
  "Never fabricate or predict a pending agent's results.";

/** 缺省 subagent 类型（类型省略时解析为此名；M8-WP-03/ADR-0052：deny 判定取**生效类型**，与段⑥解析同源）。 */
const DEFAULT_SUBAGENT_TYPE = "general-purpose";

/** 默认深度上限 3（ORC-022 原文；CC CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH 的 STANDARD_CODE_ 同构，ADR-0007）。 */
export const MAX_SUBAGENT_DEPTH = 3;
/** 默认并发上限 20（ORC-022 原文；CC MAX_CONCURRENT_SUBAGENTS 同构）。 */
export const MAX_CONCURRENT_SUBAGENTS = 20;

/** agent 定义最小消费面（frontmatter 全量解析=WP-09；注册表发现链=WP-06——本卡只消费 spawn 所需键）。 */
export interface SubagentDefinition {
  name: string;
  description: string;
  /** 子 agent 系统提示词；缺省=仅防伪造条目的最小提示词。 */
  systemPrompt?: string;
  /** 工具白名单（名字列）；缺省=继承父会话全工具（general-purpose 语义）。解析为空 → zero-tool 拒绝（CC §6.2 step3）。 */
  tools?: string[];
  /** agent 定义模式覆盖（DoD④：父 broker 规则共享+本键覆盖模式；CC §6.2 step2）。 */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** agent 定义后台偏好（后台判定输入之一；CC §4.1 H.background 同构）。 */
  background?: boolean;
  /** 单 turn 工具轮数上限透传（LoopOptions.maxToolRounds）。 */
  maxTurns?: number;
  /**
   * WP-06（ORC-022 omit 规则）：true=子 agent 系统提示词组装省略主记忆段
   * （CC §6.1 omitClaudeMd :156607-156609 同构；Explore/Plan/内置只读型置 true）。
   */
  omitClaudeMd?: boolean;
  /** WP-06：true=省略 gitStatus 段（CC §6.1 `Ke = agentType==="Explore"||"Plan" ? ct : et` :156611 同构，落为显式位）。 */
  omitGitStatus?: boolean;
  /** 模型位（CC §5.1 model 字段；"inherit"=随父会话；WP-06 built-in 消费，运行面接线=后续卡）。 */
  model?: string;
  /**
   * WP-06（ORC-022"非最新模型压到中等档"）：true=model:"inherit" 且父会话非最新模型时压到中等档
   * （CC Explore iP/g6t "opus" cap 同构语义，档位落点本仓 [自定]；env 关断=STANDARD_CODE_DISABLE_EXPLORE_INHERIT_CAP）。
   */
  inheritCap?: boolean;
  /**
   * WP-09（A 级 §5.3 isolation 70407-70415）：定义级隔离标记透传（worktree=标记实现；
   * remote 拒绝=WP-03 校验序列既有段消费面；.md 解析产此位，spawn 接线=后续卡）。
   */
  isolation?: "worktree" | "remote";
  /** WP-09（A 级 §5.3 initialPrompt 70443-70444；SEC-070 列举字段）：定义级初始提示透传位（消费接线=后续卡）。 */
  initialPrompt?: string;
  /**
   * WP-09（A 级 §5.3 hooks `PAo` 70251-70259；SEC-070 提权字段之一）：hooks 键在场标记。
   * WP-10（ADR-0043 决策 6）：frontmatter 单行 JSON 可达实体时另落 def.hooks（本位仍为 SEC-070 判定输入）；
   * 值不可达实体=仅本标记（提权语义不变）。
   */
  hooksRequested?: boolean;
  /**
   * WP-10（ADR-0043 决策 6）：定义级 hooks 实体（settings.hooks 事件映射同形，单行 JSON 声明）——
   * 经 SEC-070 确认/留痕后由接线层注入子代理执行面引擎；未确认=gate 剥离本键。
   */
  hooks?: Record<string, unknown>;
  /**
   * WP-10（ADR-0043 决策 5；dig-05 §2.4 :156421 字符串名最小形）：requiredMCP 服务器名引用
   * （磁盘配置解析——ORC-022 校验序列 requiredMCP 30s 段消费）。
   */
  mcpServers?: string[];
  /**
   * WP-06（MEM-030；[CC] memory 键 :70398-70406 三值）：agent 记忆启用——只读三件套自动补
   * （DoD⑤）+primed 预热注入（SubagentRunContext.primedAgentMemory）+独立记忆目录（三作用域，cli 侧定位）。
   */
  memory?: "user" | "project" | "local";
}

export interface SubagentSpawnInput {
  prompt: string;
  /** 类型名；缺省解析 general-purpose（不可用 → type_missing）。 */
  subagentType?: string;
  /** 3–5 词摘要；\s+ 归一化（CC §4.1 step2 逐字语义）。 */
  description: string;
  /** 后台偏好；缺省=后台（ORC-022"后台为默认"；显式 false=同步，CC §4.1 step10 公式去 teammate 项）。 */
  runInBackground?: boolean;
  /** worktree=标记实现（M5 沙箱前不建真 worktree）；remote=拒绝（卡边界 M5+）。 */
  isolation?: "worktree" | "remote";
  model?: string;
}

/** 校验序列上下文（纯函数注入面——并发计数/注册表/预算的实体在 WP-04/05/06 接线）。 */
export interface SpawnValidationContext {
  /** 父会话当前嵌套深度（顶层=0）。 */
  depth: number;
  maxDepth?: number;
  /** 当前并发子 agent 数（WP-04 注册表供给）。 */
  concurrentSubagents: number;
  maxConcurrentSubagents?: number;
  /** 可用 agent 类型名（WP-06 注册表供给；大小写不敏感解析）。 */
  availableTypes: Iterable<string>;
  /** 类型名 → 定义（缺省对 general-purpose 合成空壳：全工具+最小提示词；WP-06 注册表接线）。 */
  definitionsOf?(name: string): SubagentDefinition | undefined;
  /** 权限规则已拒绝的类型（调用方自 broker Agent(X) deny 规则提取）。 */
  deniedAgentTypes?: string[];
  /** 预算面（spentUsd ≥ maxBudgetUsd → 拒绝；未提供=不设限）。 */
  budget?: { spentUsd: number; maxBudgetUsd: number };
  /** 后台任务禁用否决位（CC §4.1 D=dc() 同构；缺省 false）。 */
  backgroundDisabled?: boolean;
  /**
   * requiredMCP 等待钩子（WP-10/ADR-0043 决策 5 真接）：入参=定义要求的服务器名，返回仍 pending 者。
   * 定义有要求而钩子缺席=拒绝（fail-closed）；提供时最多等 30s（500ms 轮询，CC §4.1 step8 同构），
   * 超时缺服务器 → mcp_required_missing。
   */
  pendingRequiredMcp?: (required: string[]) => string[];
  /** 测试注入（轮询 sleep/时钟）。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SpawnRefusalCode =
  | "depth_limit"
  | "description_invalid"
  | "agent_denied"
  | "budget_exhausted"
  | "concurrency_limit"
  | "type_ambiguous"
  | "type_not_found"
  | "type_missing"
  | "mcp_required_missing"
  | "remote_unsupported";

export type SpawnValidationResult =
  | {
      ok: true;
      /** 已执行步骤序（按 ORC-022 序；DoD① 顺序断言面）。 */
      trace: string[];
      normalized: {
        prompt: string;
        description: string;
        /** 解析后的定义名（归一化大小写）。 */
        agentType: string;
        definition: SubagentDefinition;
        isolation?: "worktree";
        background: boolean;
      };
    }
  | { ok: false; trace: string[]; code: SpawnRefusalCode; message: string };

/** 校验序列（按序执行，拒绝即停；trace 末位=触发拒绝的步骤）。 */
export async function validateSpawn(
  input: SubagentSpawnInput,
  ctx: SpawnValidationContext,
): Promise<SpawnValidationResult> {
  const trace: string[] = [];
  const maxDepth = ctx.maxDepth ?? MAX_SUBAGENT_DEPTH;
  const maxConcurrent = ctx.maxConcurrentSubagents ?? MAX_CONCURRENT_SUBAGENTS;

  // ① 深度上限 3（CC §4.1 step1 逐字消息，env 名 STANDARD_CODE_ 同构）
  trace.push("depth");
  if (ctx.depth >= maxDepth) {
    return {
      ok: false,
      trace,
      code: "depth_limit",
      message:
        `Subagent nesting limit reached (depth ${ctx.depth} of ${maxDepth}). Complete this task directly using your tools instead of spawning another agent. ` +
        `If the user explicitly requested deeper nesting, ask them to raise STANDARD_CODE_MAX_SUBAGENT_SPAWN_DEPTH.`,
    };
  }

  // ② description 归一化（CC §4.1 step2 逐字：\s+→单空格+trim）
  trace.push("description");
  const description = input.description.replace(/\s+/g, " ").trim();
  if (description === "") {
    return { ok: false, trace, code: "description_invalid", message: "description is required (3-5 word summary of the task)." };
  }

  // ③ 权限规则（CC §4.1 step4：Agent(X) deny 规则拒绝；M8-WP-03/ADR-0052：X＝**生效类型**——
  //     类型省略时按缺省解析 general-purpose 同过 deny；显式形消息逐字不变，缺省形加 (default) 标注）
  trace.push("permission");
  const denied = new Set((ctx.deniedAgentTypes ?? []).map((t) => t.toLowerCase()));
  const effectiveType = input.subagentType ?? DEFAULT_SUBAGENT_TYPE;
  if (denied.has(effectiveType.toLowerCase())) {
    return {
      ok: false,
      trace,
      code: "agent_denied",
      message: `Agent type '${effectiveType}'${input.subagentType === undefined ? " (default)" : ""} has been denied by permission rule 'Agent(${effectiveType})'.`,
    };
  }

  // ④ 预算（CC §4.1 step5：maxBudgetUsd 超限）
  trace.push("budget");
  if (ctx.budget && ctx.budget.spentUsd >= ctx.budget.maxBudgetUsd) {
    return {
      ok: false,
      trace,
      code: "budget_exhausted",
      message: `Budget limit reached ($${ctx.budget.spentUsd} spent of the $${ctx.budget.maxBudgetUsd} maximum). New agents cannot be started.`,
    };
  }

  // ⑤ 并发 20（CC §4.1 step6：槽满拒，提示 Do not retry）
  trace.push("concurrency");
  if (ctx.concurrentSubagents >= maxConcurrent) {
    return {
      ok: false,
      trace,
      code: "concurrency_limit",
      message: `Concurrent subagent limit reached. You can run ${maxConcurrent} subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase STANDARD_CODE_MAX_CONCURRENT_SUBAGENTS.`,
    };
  }

  // ⑥ 类型解析（CC §4.1 step7：大小写不敏感；歧义/缺失/未提供且无 general-purpose 各自拒绝）
  trace.push("type");
  const available = [...ctx.availableTypes];
  const byLower = new Map<string, string[]>();
  for (const t of available) {
    const k = t.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), t]);
  }
  let resolvedName: string;
  if (input.subagentType === undefined) {
    if (!byLower.has(DEFAULT_SUBAGENT_TYPE)) {
      return { ok: false, trace, code: "type_missing", message: "No subagent type resolved: subagent_type was omitted and no general-purpose agent is available." };
    }
    resolvedName = DEFAULT_SUBAGENT_TYPE;
  } else {
    const matches = byLower.get(input.subagentType.toLowerCase()) ?? [];
    if (matches.length > 1) {
      return { ok: false, trace, code: "type_ambiguous", message: `Agent type '${input.subagentType}' is ambiguous — matches ${matches.join(", ")}.` };
    }
    if (matches.length === 0) {
      return { ok: false, trace, code: "type_not_found", message: `Agent type '${input.subagentType}' not found. Available types: ${available.join(", ") || "(none)"}.` };
    }
    resolvedName = matches[0]!;
  }
  const definition: SubagentDefinition =
    ctx.definitionsOf?.(resolvedName) ?? {
      name: resolvedName,
      description: "general-purpose agent that can use all tools",
    };

  // ⑦ requiredMCP 30s（WP-10 真接，ADR-0043 决策 5——不弱化为恒跳过：required 非空无钩子=fail-closed 拒绝）
  trace.push("requiredMcp");
  const requiredMcp = definition.mcpServers ?? [];
  if (requiredMcp.length > 0) {
    if (!ctx.pendingRequiredMcp) {
      return {
        ok: false,
        trace,
        code: "mcp_required_missing",
        message: `Agent '${resolvedName}' requires MCP server(s): ${requiredMcp.join(", ")} — no MCP client is available in this session to wait on them.`,
      };
    }
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = ctx.now ?? Date.now;
    const deadline = now() + 30_000;
    let pending = ctx.pendingRequiredMcp(requiredMcp);
    while (pending.length > 0 && now() < deadline) {
      await sleep(500);
      pending = ctx.pendingRequiredMcp(requiredMcp);
    }
    if (pending.length > 0) {
      return { ok: false, trace, code: "mcp_required_missing", message: `Required MCP server(s) not connected: ${pending.join(", ")}.` };
    }
  }

  // ⑧ isolation（卡边界：worktree=标记实现；remote=M5+ 拒绝）
  trace.push("isolation");
  if (input.isolation === "remote") {
    return { ok: false, trace, code: "remote_unsupported", message: "isolation: 'remote' is not supported until M5 (sandbox milestone)." };
  }

  // ⑨ 后台判定（CC §4.1 step10 公式去 teammate/coordinator/fork-gate 项；D=backgroundDisabled 否决）
  trace.push("background");
  const o = input.runInBackground;
  const background = (o === true || definition.background === true || o !== false) && ctx.backgroundDisabled !== true;

  return {
    ok: true,
    trace,
    normalized: {
      prompt: input.prompt,
      description,
      agentType: resolvedName,
      definition,
      ...(input.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      background,
    },
  };
}

/** 执行器选项（runAgentLoop 编排面注入）。 */
export interface SubagentRunContext {
  provider: LoopOptions["provider"];
  model: string;
  /** 父会话工具集（按 agent 定义 tools 白名单过滤；缺省全量）。 */
  tools?: Tool[];
  /** 父权限 broker（规则共享；agent 定义 permissionMode 覆盖=derive，父模式不受影响）。 */
  permissionBroker?: PermissionBroker;
  /** 窄权限闸（broker 不可得时的回退面；此时 agent 定义模式覆盖不生效——无法在不改父的情况下改模式）。 */
  permission?: LoopOptions["permission"];
  signal?: AbortSignal;
  /** WP-05（ORC-032 TaskStop）：工具派生子进程上报（透传 agent-loop——任务级追踪面）。 */
  onProcess?(child: import("node:child_process").ChildProcess): void;
  /** WP-10（ADR-0043 决策 6/DoD⑤）：定义级 hooks 执行面（接线层经 SEC-070 确认/留痕后构造注入；透传 runAgentLoop——子代理工具链过 agent 级引擎）。 */
  hooks?: LoopOptions["hooks"];
  /**
   * WP-06（ORC-022 omit 规则消费面）：父会话可传入记忆/gitStatus 段进子 agent 系统提示词组装；
   * 定义位 omitClaudeMd/omitGitStatus 置真时对应段省略（子代理上下文本就隔离，omit 作用于提示词组装）。
   */
  parentContext?: { memory?: string; gitStatus?: string };
  /** WP-06（MEM-030 DoD⑤）：primed 预热注入（agent 记忆内容；cli 装配读记忆目录填入——messages 首条 user 载体）。 */
  primedAgentMemory?: string;
  /** agentId 工厂（测试确定性注入；缺省递增 subagent-N）。 */
  newAgentId?: () => string;
}

export interface SubagentRunResult {
  status: "completed";
  agentId: string;
  agentType: string;
  /** 结果摘要=最后一条 assistant 的 text 块拼接（CC §7.1 Gxt 同构；空输出兜底逐字）。 */
  content: string;
  /** 回传文本=content+<subagent_tokens> 标注（DoD③ 断言面；CC §7.2 completed 尾注同构）。 */
  report: string;
  totalTokens: number;
  totalToolUseCount: number;
  totalDurationMs: number;
  usage: TokenUsage | null;
  doneReason: string;
}

let subagentCounter = 0;

/**
 * 同步执行一个 subagent（后台通道=WP-04；background=true 的分流在其接线）。
 * 独立上下文：messages 仅含本次 prompt（DoD②）；独立会话栈：独立 runAgentLoop 状态。
 */
/**
 * 子 agent 系统提示词装配（WP-03 装配序原样）：定义提示词（缺省最小壳）→ 主记忆段（omitClaudeMd 省略）
 * → gitStatus 段（omitGitStatus 省略）→ 防伪造条目（ORC-041 常量进每个 agent 提示词——嵌套 spawn 同受约束）。
 * WP-11 Golden 化：导出使生产（runSubagent :340）/采集（evals/golden/capture-antifab.mjs）/CI 守卫
 * 三者同源——装配顺序或文本漂移即守卫红，重采基线必须显式 `npm run golden:capture:antifab`。
 */
export function buildSubagentSystem(def: SubagentDefinition, parentContext?: { memory?: string; gitStatus?: string }): string {
  const sections: string[] = [];
  if (def.systemPrompt) sections.push(def.systemPrompt);
  if (parentContext?.memory && !def.omitClaudeMd) sections.push(parentContext.memory);
  if (parentContext?.gitStatus && !def.omitGitStatus) sections.push(parentContext.gitStatus);
  sections.push(SUBAGENT_ANTI_FABRICATION);
  return sections.join("\n\n");
}

export async function runSubagent(
  normalized: Extract<SpawnValidationResult, { ok: true }>["normalized"],
  run: SubagentRunContext,
): Promise<SubagentRunResult> {
  const agentId = run.newAgentId?.() ?? `subagent-${++subagentCounter}`;
  const def = normalized.definition;

  // 工具解析：定义白名单过滤父工具集；空 → zero-tool 拒绝（CC §6.2 step3 同构）
  const resolvedTools = def.tools ? (run.tools ?? []).filter((t) => def.tools!.includes(t.name)) : run.tools ?? [];
  // MEM-030（WP-06 DoD⑤；WP-09 O2 回补）：启用 memory 的 agent 自动补只读三件套（写归主会话）
  if (def.memory) {
    for (const t of ["Read", "Grep", "Glob"]) {
      if (!resolvedTools.some((x) => x.name === t)) {
        const tool = (run.tools ?? []).find((x) => x.name === t);
        if (tool) resolvedTools.push(tool);
      }
    }
  }
  if (resolvedTools.length === 0) {
    throw new Error(
      `Agent '${def.name}' would be spawned with zero tools — refusing. Its tools list resolved to nothing: [${(def.tools ?? []).join(", ")}]. Fix the agent's tools frontmatter or pass a different subagent_type.`,
    );
  }

  // 权限解析（DoD④）：agent 定义 permissionMode 覆盖=broker.derive（规则共享、模式独立）
  let gate: LoopOptions["permission"] | undefined;
  if (run.permissionBroker) {
    const broker = def.permissionMode ? run.permissionBroker.derive(def.permissionMode) : run.permissionBroker;
    gate = { check: async (name, input) => broker.evaluate(name, input).decision };
  } else {
    gate = run.permission;
  }

  // 系统提示词组装（WP-06 omit 规则消费面；WP-11 Golden 化=提取 buildSubagentSystem 导出，
  // 生产/capture/CI 守卫三者同源——装配序或常量文本变化即守卫红，重采基线须显式 golden:capture:antifab）
  const system = buildSubagentSystem(def, run.parentContext);

  // 独立上下文（DoD②）：不携带父会话任何消息；MEM-030 primed 预热注入（agent 记忆摘要面——
  // cli 装配读目录填 run.primedAgentMemory；不进 buildSubagentSystem=Golden 基线零影响 [自定]）；
  // WP-10（DoD④）initialPrompt 消费=首轮预热注入（primed 之后、任务 prompt 之前的 user 载体——同形制不进系统提示词面）
  const messages = [
    ...(run.primedAgentMemory ? [{ role: "user" as const, content: [{ type: "text" as const, text: `<agent-memory>${run.primedAgentMemory}</agent-memory>` }] }] : []),
    ...(def.initialPrompt !== undefined && def.initialPrompt !== "" ? [{ role: "user" as const, content: [{ type: "text" as const, text: def.initialPrompt }] }] : []),
    { role: "user" as const, content: [{ type: "text" as const, text: normalized.prompt }] },
  ];

  const startedAt = Date.now();
  let totalTokens = 0;
  let totalToolUseCount = 0;
  let usage: TokenUsage | null = null;
  let doneReason = "end";
  const stateRef: { current?: TurnState } = {};

  for await (const ev of runAgentLoop({
    provider: run.provider,
    model: run.model,
    system,
    messages,
    tools: resolvedTools,
    permission: gate,
    signal: run.signal,
    stateRef,
    maxToolRounds: def.maxTurns,
    onProcess: run.onProcess,
    ...(run.hooks ? { hooks: run.hooks } : {}),
    agentKind: "subagent", // WP-02（M4）：MCP 转后台生效条件之"主循环"面（:296642 同构）
  })) {
    switch (ev.type) {
      case "usage":
        // 四列快照（ADR-0027 最后一条为准）；totalTokens 跨轮累计（input+output，CC totalTokens 口径）
        usage = ev.usage;
        totalTokens += ev.usage.inputTokens + ev.usage.outputTokens;
        break;
      case "tool_start":
        totalToolUseCount++;
        break;
      case "done":
        doneReason = ev.reason;
        break;
    }
  }

  const finalMessages = stateRef.current?.messages ?? messages;
  const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
  const text = (lastAssistant?.content ?? [])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  const content = text !== "" ? text : "(Subagent completed but returned no output.)";
  const totalDurationMs = Date.now() - startedAt;
  const report = `${content}\n<subagent_tokens>subagent_tokens: ${totalTokens}, tool_uses: ${totalToolUseCount}, duration_ms: ${totalDurationMs}</subagent_tokens>`;

  return {
    status: "completed",
    agentId,
    agentType: normalized.agentType,
    content,
    report,
    totalTokens,
    totalToolUseCount,
    totalDurationMs,
    usage,
    doneReason,
  };
}
