// M6-WP-03：workflow 编排内核（agent() / parallel() / pipeline() + 并发信号量 + budget 硬顶 + agent 上限）。
//
// 规格：v2.8 ORC-022（行 292 spawn 前置校验序列）/ ORC-023/024（行 295）/ ORC-040~042（行 296）；
// A 级 claude-code-workflow.md §4.1（安全分类器前置）/§4.2（subagent 查询）/§4.3（StructuredOutput 强制与重试）
// /§4.4（workflow subagent 专属提示词）/§5（并发公式 L167994-167998、常量 L169692-169694、cap 与错误文案 L169790-169804）
// /§6（budget L168064-168076、错误文案 L169801-169806）。
//
// 复用面（不重做，本卡只编排）：
//   - `validateSpawn`（packages/harness/src/subagent.ts：ORC-022 九段校验序列）——agent() 逐调用复用。
//   - `runSubagent`（同上：M3 subagent 执行器，后台默认 + 120s 翻转=WP-04 接线，本卡不碰）——agent() 真派生走它。
//   - 生命周期/后台翻转语义完全沿用 M3，本卡只在其外包裹并发信号量 / agent 硬顶 / budget 记账 / StructuredOutput 重试。
//
// 注入纪律（继承 WP-02 sandbox.ts）：本模块是宿主侧内核，所有值经 WorkflowHooks 进 vm context 前由 sandbox
// 的桥接器/克隆处理；本模块内部不接触 vm realm，故不重复克隆逻辑，但**错误文案与常量逐字取自 A 级报告**。

import os from "node:os";
import type { ProviderAdapter } from "@standardcode/providers";
import {
  type PermissionBroker,
  type SubagentDefinition,
  type SubagentSpawnInput,
  runSubagent,
  validateSpawn,
} from "@standardcode/harness";
import type { PermissionGate, Tool } from "@standardcode/harness";
import type { WorkflowAgentOptions, WorkflowBudget, WorkflowHooks, WorkflowPipelineStage } from "./sandbox.ts";

// ───────────────────────── 常量（逐字取自 A 级报告锚点） ─────────────────────────

/** 并发信号量容量公式：`min(16, max(2, cpus−2))`（§5.1 L167994-167998，含下限 2 保护）。 */
export function concurrencyCapacity(): number {
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.min(16, Math.max(2, cpus - 2));
}

/** 生命周期 agent 总数硬顶（runaway-loop backstop，§5 L169694 `Ssr=1000`）。 */
export const MAX_WORKFLOW_AGENTS = 1000;

/** parallel()/pipeline() items 上限（§5 L171046「at most 4096 items」；实现侧常量未定位→[自定] 取 4096）。 */
export const WORKFLOW_MAX_ITEMS = 4096;

/** StructuredOutput 校验失败重试上限（§4.3/§12 未解②：常量 `xo` 未逐字定位→[自定] 取 3，理由见报告 §4）。 */
export const DEFAULT_STRUCTURED_OUTPUT_RETRY_CAP = 3;

/** workflow subagent 专属系统提示词（§4.4 L169699-169710 逐字 `_ns`）。 */
export const WORKFLOW_SUBAGENT_SYSTEM_NOTE =
  "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\n" +
  "\n" +
  "CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.\n" +
  "- Output the literal result (data, JSON, text). Do NOT output confirmations like \"Done.\" or \"Sent.\"\n" +
  "- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.\n" +
  "- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.\n" +
  "- Be concise. The script will parse your output.";

// ───────────────────────── 错误类型（name 属性同名，供 vm 内 toContextError 搬运） ─────────────────────────

/** agent 总数硬顶（§5 L169790-169804 `wsr`/`WorkflowAgentCapError`）。 */
export class WorkflowAgentCapError extends Error {
  constructor(agentCount: number) {
    super(
      `Workflow agent() call cap reached (${agentCount}). This usually means a loop using budget.remaining() never terminates because ` +
        "no token budget was set — remaining() returns Infinity when budget.total is null. " +
        "Add a hard iteration cap to the loop, or pass a token budget.",
    );
    this.name = "WorkflowAgentCapError";
  }
}

/** token budget 硬顶（§6 L169801-169806 `ksr`/`WorkflowBudgetError`）。 */
export class WorkflowBudgetError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). ` +
        "Stopping further agent() calls. In-flight agents will complete; their results are preserved.",
    );
    this.name = "WorkflowBudgetError";
  }
}

/** parallel()/pipeline() items 超过上限（§5 L171046 描述层显式错误）。 */
export class WorkflowItemsLimitError extends Error {
  constructor(kind: "parallel" | "pipeline", count: number, limit: number) {
    super(`Workflow ${kind}() accepts at most ${limit} items; received ${count}.`);
    this.name = "WorkflowItemsLimitError";
  }
}

// ───────────────────────── budget 构造（total=null → remaining()=Infinity） ─────────────────────────

/**
 * 构造 WorkflowBudget。total===null 表示无预算，remaining() 返回 Infinity（§6 语义 + DoD④）。
 * 调用方（CLI 装配）据真实输出 token 累计传入 spent()。
 */
export function makeWorkflowBudget(total: number | null, spent: () => number): WorkflowBudget {
  return {
    total,
    spent,
    remaining: () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent())),
  };
}

// ───────────────────────── StructuredOutput 最小校验器（[自定] 内置，可被注入覆盖） ─────────────────────────

export type StructuredOutputResult =
  | { ok: true; value: unknown }
  | { ok: false };

/** 内置最小 JSON-schema 校验：支持 {type, properties?, required?} 与基元 type；未知 schema 形=放行（无法校验）。 */
export function defaultStructuredOutputValidator(text: string, schema: unknown): StructuredOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return { ok: true, value };
  const s = schema as Record<string, unknown>;
  const type = s.type;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
    for (const k of required) {
      if (typeof k !== "string" || !(k in obj)) return { ok: false };
    }
    const props = s.properties;
    if (props && typeof props === "object") {
      for (const [k, p] of Object.entries(props as Record<string, unknown>)) {
        if (k in obj && !matchType(obj[k], (p as Record<string, unknown>)?.type)) return { ok: false };
      }
    }
    return { ok: true, value };
  }
  if (type === "array") return { ok: Array.isArray(value), value: value };
  if (type === "string" || type === "number" || type === "boolean") {
    return { ok: matchType(value, type), value };
  }
  return { ok: true, value };
}

function matchType(value: unknown, type: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

// ───────────────────────── 信号量 ─────────────────────────

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = Math.max(1, capacity);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available++;
  }
}

// ───────────────────────── 编排内核选项 ─────────────────────────

export interface WorkflowOrchestratorOptions {
  /** 校验序列基础（复用 M3 validateSpawn）：可用 agent 类型名（大小写不敏感解析）。 */
  availableTypes: Iterable<string>;
  /** agent 定义查询（WP-06 注册表；用于把 agentType 解析为 SubagentDefinition）。 */
  definitionsOf?: (name: string) => SubagentDefinition | undefined;
  /** 权限规则已拒绝的类型（复用 M3）。 */
  deniedAgentTypes?: string[];
  /** 当前嵌套深度（顶层=0）。 */
  depth?: number;
  /** 后台任务禁用否决位（复用 M3）。 */
  backgroundDisabled?: boolean;
  /** requiredMCP 等待钩子（复用 M3；缺=有要求则 fail-closed 拒绝）。 */
  pendingRequiredMcp?: (required: string[]) => string[];

  /** budget（WorkflowBudget）；total=null 视为无预算（remaining()=Infinity）。 */
  budget?: WorkflowBudget;

  /** runSubagent 执行面基础（provider/model 必备；其余透传 M3 执行器）。 */
  provider: ProviderAdapter;
  model: string;
  tools?: Tool[];
  permissionBroker?: PermissionBroker;
  permission?: PermissionGate;
  parentContext?: { memory?: string; gitStatus?: string };

  /** 遥测回调：cap / budget 各发一次（payload 同 A 级 §10 事件族字段）。 */
  onTelemetry?: (event: string, payload: Record<string, unknown>) => void;
  /** StructuredOutput 校验器（默认 defaultStructuredOutputValidator；注入以测试）。 */
  structuredOutputValidator?: (text: string, schema: unknown) => StructuredOutputResult;
  /** phase() 回调（进度=WP-05，本卡仅转发）。 */
  onPhase?: (title: string) => void;
  /** log() 回调（进度叙述=WP-05，本卡仅转发）。 */
  onLog?: (message: string) => void;

  /** items 上限（[自定] 默认 4096）。 */
  maxItems?: number;
  /** StructuredOutput 重试上限（[自定] 默认 3）。 */
  structuredOutputRetryCap?: number;
  /** 并发信号量容量（默认 concurrencyCapacity()；注入以测试）。 */
  concurrencyCapacityOverride?: number;
  /** 生命周期 agent 硬顶（默认 1000）。 */
  maxAgents?: number;

  /** 测试探针：agent 提交 spawn（过 cap+budget、未 await 信号量前）回调，spent 计账点。 */
  onAgentCommitted?: () => void;
  /** 测试探针：信号量 acquire 时采样当前在途并发数（不含本 agent）。 */
  onConcurrencySample?: (currentConcurrent: number) => void;
}

// ───────────────────────── 编排内核 ─────────────────────────

/** 建 workflow 编排内核（实现 WorkflowHooks 的 agent/parallel/pipeline/phase/log 五件）。 */
export function createWorkflowOrchestrator(options: WorkflowOrchestratorOptions): WorkflowHooks {
  const capacity = options.concurrencyCapacityOverride ?? concurrencyCapacity();
  const semaphore = new Semaphore(capacity);
  const maxAgents = options.maxAgents ?? MAX_WORKFLOW_AGENTS;
  const maxItems = options.maxItems ?? WORKFLOW_MAX_ITEMS;
  const retryCap = options.structuredOutputRetryCap ?? DEFAULT_STRUCTURED_OUTPUT_RETRY_CAP;
  const validator = options.structuredOutputValidator ?? defaultStructuredOutputValidator;
  const budget = options.budget;

  let lifecycleAgents = 0;
  let concurrentAgents = 0;
  let capTelemetryFired = false;
  let budgetTelemetryFired = false;

  // §4.4：把 workflow subagent 专属提示词注入到解析出的定义 systemPrompt（复用 definitionsOf，不重写）。
  const augmentDefinitionsOf = options.definitionsOf
    ? (name: string): SubagentDefinition | undefined => {
        const def = options.definitionsOf!(name);
        if (!def) return def;
        if (def.systemPrompt && def.systemPrompt.includes(WORKFLOW_SUBAGENT_SYSTEM_NOTE)) return def;
        return {
          ...def,
          systemPrompt: (def.systemPrompt ? def.systemPrompt + "\n\n---\n\n" : "") + WORKFLOW_SUBAGENT_SYSTEM_NOTE,
        };
      }
    : options.definitionsOf;

  async function runOneAgent(prompt: string, opts?: WorkflowAgentOptions): Promise<unknown> {
    // ② ORC-022 校验序列（复用 M3 validateSpawn；九段全序；并发段接待本内核信号量=capacity，见下方注释）。
    const description = opts?.label ?? prompt;
    const spawnInput: SubagentSpawnInput = {
      prompt,
      description,
      subagentType: opts?.agentType,
      isolation: opts?.isolation,
    };
    // 并发段：ORC-022 的「并发 20」是 M3 全局 subagent 并发；workflow 内部并发由本内核信号量（DoD②
    // min(16,max(2,cpus−2))）治理，故把 workflow 当前在途数与本内核容量传入，使该段以 workflow 容量为限、
    // 不触发 M3 全局 20 误拒（[自定] 口径，登记供 V）。信号量仍是有效闸。
    // 注意：ORC-022 校验序列第④步「预算」是**会话级 USD 预算**（不同轴），workflow 的 token budget 由本内核
    // 自有硬顶（下方 step ④ / §6 O()）按 L169801 文案抛错治理，故此处不把 token budget 注入 validateSpawn
    // 的 budget 段，避免其以 budget_exhausted 静默 skip 抢在 kernel 硬顶之前（[自定] 口径，登记供 V）。
    const validated = await validateSpawn(spawnInput, {
      depth: options.depth ?? 0,
      availableTypes: options.availableTypes,
      definitionsOf: augmentDefinitionsOf,
      deniedAgentTypes: options.deniedAgentTypes,
      concurrentSubagents: concurrentAgents,
      maxConcurrentSubagents: capacity,
      backgroundDisabled: options.backgroundDisabled,
      pendingRequiredMcp: options.pendingRequiredMcp,
    });
    // 校验拒绝（深度/类型/权限/隔离/requiredMCP/并发上限等）= 跳过该 agent，结果 null（[自定]：与 §4.1 安全分类器 skip 同构；
    // 硬顶另走 cap/budget throw；不阻断整体 workflow）。
    if (!validated.ok) return null;

    // ④ budget 硬顶（§6 O()：total!=null 且 remaining<=0 → 抛，遥测只发一次；在途 agent 不受此影响）。
    if (budget && budget.total !== null && budget.remaining() <= 0) {
      if (!budgetTelemetryFired) {
        budgetTelemetryFired = true;
        options.onTelemetry?.("tengu_workflow_budget_cap_exceeded", {
          spent: budget.spent(),
          budget: budget.total,
          agentCount: lifecycleAgents,
        });
      }
      throw new WorkflowBudgetError(budget.spent(), budget.total);
    }

    // ① agent 总数硬顶（§5 A()：d>=Ssr 抛，遥测只发一次）。此检查与下方提交（lifecycleAgents++）之间
    // 无 await，构成原子段；校验拒绝已 return，故不消耗生命周期槽位。
    if (lifecycleAgents >= maxAgents) {
      if (!capTelemetryFired) {
        capTelemetryFired = true;
        options.onTelemetry?.("tengu_workflow_agent_cap_exceeded", { agentCount: lifecycleAgents });
      }
      throw new WorkflowAgentCapError(maxAgents);
    }

    // 提交 spawn：计账点（lifecycle + 调用方 spent 钩子）。
    lifecycleAgents++;
    concurrentAgents++;
    options.onAgentCommitted?.();

    const release = (): void => {
      concurrentAgents--;
      semaphore.release();
    };

    try {
      await semaphore.acquire();
      options.onConcurrencySample?.(concurrentAgents - 1);

      const model = opts?.model ?? options.model;
      const runCtx = {
        provider: options.provider,
        model,
        tools: options.tools,
        ...(options.permissionBroker ? { permissionBroker: options.permissionBroker } : {}),
        ...(options.permission ? { permission: options.permission } : {}),
        ...(options.parentContext ? { parentContext: options.parentContext } : {}),
      };

      if (opts?.schema === undefined) {
        // 无 schema：返回 subagent 最终文本（§2.2）。
        const r = await runSubagent(validated.normalized, runCtx);
        return r.content;
      }

      // StructuredOutput 强制与重试（§4.3）：校验失败重试至 retryCap，上限后该 agent 结果 null（DoD⑥）。
      let attempt = 0;
      for (;;) {
        const r = await runSubagent(validated.normalized, runCtx);
        const checked = validator(r.content, opts.schema);
        if (checked.ok) return checked.value;
        attempt++;
        if (attempt >= retryCap) return null;
      }
    } finally {
      release();
    }
  }

  const parallel: WorkflowHooks["parallel"] = async (thunks) => {
    if (thunks.length > maxItems) throw new WorkflowItemsLimitError("parallel", thunks.length, maxItems);
    // 有 barrier：等全部完成；单 thunk 抛错→对应位 null，整体不 reject（§2.2）。
    return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  };

  const pipeline: WorkflowHooks["pipeline"] = async (items, ...stages) => {
    if (items.length > maxItems) throw new WorkflowItemsLimitError("pipeline", items.length, maxItems);
    // 无 barrier：每项独立流过所有 stage；stage 抛错=该项落 null 并跳过后续 stage（§2.2）。
    return Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = undefined;
        for (const stage of stages as WorkflowPipelineStage[]) {
          try {
            prev = await stage(prev, item, index);
          } catch {
            return null;
          }
        }
        return prev;
      }),
    );
  };

  const phase: WorkflowHooks["phase"] = (title) => {
    options.onPhase?.(title);
  };

  const log: WorkflowHooks["log"] = (message) => {
    options.onLog?.(message);
  };

  return { agent: runOneAgent, parallel, pipeline, phase, log };
}
