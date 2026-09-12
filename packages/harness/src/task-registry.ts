// L1 任务注册表（v2.8 §6 ORC-040~042；M3 WP-04）。
// 内存态+进程内事件（卡边界：不做跨会话持久化）。CC hJ 注册形状同构（A 级报告 §4.2：
// {type:"local_agent", status, agentId, isBackgrounded, ...}）。
// 并发槽：takeConcurrencySlot 幂等（重复 take 不重复计数）/releaseConcurrencySlot 幂等（重复释放
// 不二次计数——DoD①，holdsSlot 标志位保证）；并发计数从持槽任务派生（与注册表一致性按构造成立——DoD④）。
// evictAfter 30s：任务终态后 30s 逐出（ORC-040 原文；调度器可注入供测试——DoD②）。

import { EventEmitter } from "node:events";
import { MAX_CONCURRENT_SUBAGENTS } from "./subagent.ts";

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskRecord {
  taskId: string;
  type: "local_agent";
  status: TaskStatus;
  agentId: string;
  agentType: string;
  description: string;
  /** 后台标志（后台默认路径恒 true；同步 120s 翻转后置位——ORC-022）。 */
  isBackgrounded: boolean;
  /** 持槽标志（并发计数的派生源；终态释放）。 */
  holdsSlot: boolean;
  createdAt: number;
  completedAt?: number;
  /** 终态结果摘要（SubagentRunResult 收敛面）。 */
  result?: { content: string; totalTokens: number; totalToolUseCount: number; totalDurationMs: number; doneReason: string };
  error?: string;
}

export interface TaskRegistryOptions {
  /** 并发槽上限（ORC-022 并发 20；STANDARD_CODE_MAX_CONCURRENT_SUBAGENTS 同构，接线=WP-05 工具面）。 */
  maxConcurrent?: number;
  /** 终态后逐出延迟（ORC-040 evictAfter 30s；0=不逐出）。 */
  evictAfterMs?: number;
  /** 逐出调度器注入（测试断言延迟值；缺省 setTimeout+unref）。 */
  scheduleEvict?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

export interface TaskRegistry {
  /** 注册任务（running 态；并发槽未取）。 */
  register(input: { agentId: string; agentType: string; description: string; isBackgrounded: boolean }): TaskRecord;
  /** 取并发槽：幂等（已持槽再取=true 不重复计数）；槽满=false。 */
  takeConcurrencySlot(taskId: string): boolean;
  /** 释放并发槽：幂等（未持槽释放为 no-op——DoD① 重复释放不二次计数）。 */
  releaseConcurrencySlot(taskId: string): void;
  /** 并发子 agent 数（持槽任务派生——DoD④ 注册表一致性按构造成立）。 */
  getConcurrentSubagents(): number;
  /** 同步转后台置位（120s 翻转路径；CC §4.2 转后台后 isBackgrounded:!0）。 */
  markBackgrounded(taskId: string): void;
  /** 终态：结果摘要落账+槽释放+evictAfter 调度。 */
  complete(taskId: string, result: TaskRecord["result"]): void;
  fail(taskId: string, error: string): void;
  /** 终态前移除（并发槽竞态拒绝面；run 前清理，不走 evict 链）。 */
  remove(taskId: string): void;
  get(taskId: string): TaskRecord | undefined;
  /** 任务枚举（activeOnly=仅 running——WP-05 /tasks active_only 默认 true 的消费面）。 */
  list(opts?: { activeOnly?: boolean }): TaskRecord[];
  /** 事件：updated（status/isBackgrounded 变更）、completed、failed、evicted（payload=taskId）。 */
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
}

export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS;
  const evictAfterMs = opts.evictAfterMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const scheduleEvict =
    opts.scheduleEvict ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.(); // CLI 常驻面不因逐出定时器挂住进程
    });
  const emitter = new EventEmitter();
  const tasks = new Map<string, TaskRecord>();
  let counter = 0;

  function emitUpdated(taskId: string) {
    emitter.emit("updated", taskId);
  }

  function settle(taskId: string, status: "completed" | "failed", patch: Partial<TaskRecord>) {
    const t = tasks.get(taskId);
    if (!t || t.status !== "running") return;
    t.status = status;
    t.completedAt = now();
    t.holdsSlot = false; // 终态释放（幂等：非 running 再触发为 no-op）
    Object.assign(t, patch);
    emitter.emit("updated", taskId);
    emitter.emit(status, taskId, t);
    if (evictAfterMs > 0) {
      scheduleEvict(() => {
        if (tasks.delete(taskId)) emitter.emit("evicted", taskId);
      }, evictAfterMs);
    }
  }

  return {
    register: (input) => {
      const task: TaskRecord = {
        taskId: `task-${++counter}`,
        type: "local_agent",
        status: "running",
        holdsSlot: false,
        createdAt: now(),
        ...input,
      };
      tasks.set(task.taskId, task);
      emitUpdated(task.taskId);
      return task;
    },
    takeConcurrencySlot: (taskId) => {
      const t = tasks.get(taskId);
      if (!t) return false;
      if (t.holdsSlot) return true; // 幂等：已持槽
      if ([...tasks.values()].filter((x) => x.holdsSlot).length >= maxConcurrent) return false;
      t.holdsSlot = true;
      emitUpdated(taskId);
      return true;
    },
    releaseConcurrencySlot: (taskId) => {
      const t = tasks.get(taskId);
      if (!t || !t.holdsSlot) return; // 幂等：重复释放不二次计数（DoD①）
      t.holdsSlot = false;
      emitUpdated(taskId);
    },
    getConcurrentSubagents: () => [...tasks.values()].filter((t) => t.holdsSlot).length,
    markBackgrounded: (taskId) => {
      const t = tasks.get(taskId);
      if (!t) return;
      t.isBackgrounded = true;
      emitUpdated(taskId);
    },
    complete: (taskId, result) => settle(taskId, "completed", { result }),
    fail: (taskId, error) => settle(taskId, "failed", { error }),
    remove: (taskId) => {
      if (tasks.delete(taskId)) emitUpdated(taskId);
    },
    get: (taskId) => tasks.get(taskId),
    list: (o) => {
      const all = [...tasks.values()];
      return o?.activeOnly ? all.filter((t) => t.status === "running") : all;
    },
    on: (e, l) => {
      emitter.on(e, l);
    },
    off: (e, l) => {
      emitter.off(e, l);
    },
    once: (e, l) => {
      emitter.once(e, l);
    },
  };
}
