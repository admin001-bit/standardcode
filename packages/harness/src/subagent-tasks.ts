// L1 subagent 后台执行通道（v2.8 §6 ORC-022 后台默认/120s 翻转 + ADR-015；M3 WP-04）。
// CC §4.2 同构收敛面：同步分支=Promise.race([完成, backgroundSignal])（_440.js:178829-178834），
// autoBackgroundMs=Mos()（存在 CLAUDE_AUTO_BACKGROUND_TASKS 时 120000 否则 0，_440.js:177526-177529）——
// 本仓 env=STANDARD_CODE_AUTO_BACKGROUND_TASKS 同构（ADR-0007）：缺省 0=不翻转（同步恒同步）；
// 存在→120000（ORC-022 原文阈值）；[自定] 数字值=自定义阈值（测试面）。
// 后台默认：runBackground 判定在 WP-03 validateSpawn（未显式 false=后台）——本通道按归一化结果分流，
// 后台任务注册即返回 async_launched（CC §4.2 hJ/pb 形状），同步任务翻转后返回 backgrounded。
// 结果通知经注册表事件（completed/failed）——WP-05 面板消费。

import {
  runSubagent,
  validateSpawn,
  type SpawnRefusalCode,
  type SpawnValidationContext,
  type SpawnValidationResult,
  type SubagentRunContext,
  type SubagentRunResult,
  type SubagentSpawnInput,
} from "./subagent.ts";
import type { TaskRegistry } from "./task-registry.ts";

/** STANDARD_CODE_AUTO_BACKGROUND_TASKS 解析：缺省/空=0（不翻转）；数字值=该毫秒 [自定]；其他非空值=120000（CC 存在即 120000）。 */
export function parseAutoBackgroundMs(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

export type SubagentTaskLaunch =
  | { status: "refused"; code: SpawnRefusalCode; message: string; trace: string[] }
  | { status: "async_launched"; taskId: string; agentId: string }
  | { status: "backgrounded"; taskId: string; agentId: string }
  | { status: "completed"; taskId: string; agentId: string; result: SubagentRunResult };

export interface SubagentTaskOptions {
  registry: TaskRegistry;
  /** 翻转阈值（缺省=parseAutoBackgroundMs(env.STANDARD_CODE_AUTO_BACKGROUND_TASKS)）。 */
  autoBackgroundMs?: number;
  /** env 面（autoBackgroundMs 未显式给出时解析；测试注入）。 */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** agentId 工厂透传（缺省 runSubagent 内部递增）。 */
  newAgentId?: () => string;
  /** M4-WP04：SubagentStart 触发点（注册+取槽成功后、运行前；refused 不触发）。 */
  onStart?: (info: { taskId: string; agentId?: string; agentType: string }) => void;
  /** M4-WP04：SubagentStop 触发点（终态落账后——同步/后台/翻转三路统一）。 */
  onSettled?: (info: { taskId: string; agentId?: string; agentType: string; ok: boolean }) => void;
}

function toResultRecord(r: SubagentRunResult): NonNullable<import("./task-registry.ts").TaskRecord["result"]> {
  return {
    content: r.content,
    totalTokens: r.totalTokens,
    totalToolUseCount: r.totalToolUseCount,
    totalDurationMs: r.totalDurationMs,
    doneReason: r.doneReason,
  };
}

/**
 * spawn 一个 subagent 任务：校验（并发计数取注册表实况——DoD④ 一致性）→ 注册 → 取槽 →
 * 后台（默认）/同步（120s 翻转）分流。refused=校验拒绝或槽竞态（无任务残留）。
 */
export async function spawnSubagentTask(
  input: SubagentSpawnInput,
  ctx: Omit<SpawnValidationContext, "concurrentSubagents">,
  run: SubagentRunContext,
  opts: SubagentTaskOptions,
): Promise<SubagentTaskLaunch> {
  const { registry } = opts;
  // DoD④：并发计数以注册表实况为准（与槽状态按构造一致）
  const v: SpawnValidationResult = await validateSpawn(input, { ...ctx, concurrentSubagents: registry.getConcurrentSubagents() });
  if (!v.ok) return { status: "refused", code: v.code, message: v.message, trace: v.trace };

  const agentId = opts.newAgentId?.() ?? run.newAgentId?.() ?? undefined;
  const task = registry.register({
    agentId: agentId ?? "",
    agentType: v.normalized.agentType,
    description: v.normalized.description,
    isBackgrounded: v.normalized.background,
  });
  const taskId = task.taskId;
  const idFallback = () => agentId ?? taskId;
  if (!registry.takeConcurrencySlot(taskId)) {
    registry.remove(taskId); // 槽竞态（校验后他人占满）：无残留
    return { status: "refused", code: "concurrency_limit", message: "Concurrent subagent limit reached.", trace: v.trace };
  }

  // WP-05 任务运行时：AbortController（TaskStop 阶段一优雅停止面）+子进程集合（两阶段终止作用对象）
  const abort = new AbortController();
  const children = new Set<import("node:child_process").ChildProcess>();
  registry.attachRuntime(taskId, { abort, children });
  const chainAbort = (sig?: AbortSignal) => sig?.addEventListener("abort", () => abort.abort(), { once: true });
  chainAbort(opts.signal);
  chainAbort(run.signal);
  const runCtx: SubagentRunContext = {
    ...run,
    signal: abort.signal,
    newAgentId: idFallback,
    onProcess: (child) => {
      children.add(child);
      child.once("exit", () => children.delete(child));
    },
  };
  const settle = runPromise(v.normalized, runCtx, registry, taskId);
  // M4-WP04：SubagentStart 触发点（注册+取槽成功后、运行前；refused/槽竞态不触发）
  opts.onStart?.({ taskId, agentId: idFallback(), agentType: v.normalized.agentType });
  // onSettled 包装：complete/fail 双路各恰一次（后台/翻转/同步三路共享同一 settle 链）
  const settleHooked = settle.then(
    (r) => {
      opts.onSettled?.({ taskId, agentId: idFallback(), agentType: v.normalized.agentType, ok: true });
      return r;
    },
    (e: unknown) => {
      opts.onSettled?.({ taskId, agentId: idFallback(), agentType: v.normalized.agentType, ok: false });
      throw e;
    },
  );
  if (v.normalized.background) {
    // 后台默认（ORC-022）：注册即返回（CC §4.2 async_launched 形状）；完成经注册表事件通知
    // settle 的 rejection 已在 runPromise 内落账（registry.fail）——此处必须挂 catch 防未处理拒绝
    //（Node ≥15 默认崩溃；WP-04 V 首验 R1：与翻转分支 :103 同构对称）
    void settleHooked.catch(() => {});
    return { status: "async_launched", taskId, agentId: agentId ?? taskId };
  }

  const autoMs = opts.autoBackgroundMs ?? parseAutoBackgroundMs(opts.env?.STANDARD_CODE_AUTO_BACKGROUND_TASKS);
  if (autoMs <= 0) {
    return await settleHooked; // 同步恒同步（env 缺省）
  }
  // 同步 120s 翻转（CC Promise.race 同构）：翻转后 isBackgrounded 置位，调用方先返回
  const flip = new Promise<"backgrounded">((res) => setTimeout(() => res("backgrounded"), autoMs));
  const winner = await Promise.race([settleHooked, flip]);
  if (winner === "backgrounded") {
    registry.markBackgrounded(taskId);
    void settleHooked.catch(() => {}); // 翻转后完成/失败落账在 settle 内部；调用方已返回
    return { status: "backgrounded", taskId, agentId: agentId ?? taskId };
  }
  return winner; // completed（未翻转）
}

/** 运行 + 终态落账（complete/fail 幂等；槽由终态释放）。 */
async function runPromise(
  normalized: Extract<SpawnValidationResult, { ok: true }>["normalized"],
  runCtx: SubagentRunContext,
  registry: TaskRegistry,
  taskId: string,
): Promise<Extract<SubagentTaskLaunch, { status: "completed" }>> {
  try {
    const result = await runSubagent(normalized, runCtx);
    registry.complete(taskId, toResultRecord(result));
    return { status: "completed", taskId, agentId: result.agentId, result };
  } catch (e) {
    registry.fail(taskId, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
