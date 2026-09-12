// L1 任务控制接口（v2.8 §6 ORC-032 任务面板语义参考 Kimi；M3 WP-05）。
// 语义锚点（A 级 KimiCode的产品细节.md:181-197）：
//   TaskOutput——task_id 返回状态与输出，内联预览最多包含**最近 32 KB**（tail），完整日志在磁盘
//     （转录面归 WP-05 后续/转录扩展，本卡接口只出内联预览），始终非阻塞=立即返回当前快照；
//   TaskStop——两阶段终止（ORC-032：SIGTERM→5s 宽限→SIGKILL，SIGTERM_GRACE_MS=5_000 一手源码实测
//     kimi background/index.ts:163）；可选 reason（默认 "Stopped by TaskStop"，task-stop.ts:23 逐字同）；
//     对已终止任务安全调用（A 级 :192）；Windows=taskkill /T 语义映射（卡边界；M1 先例）。
//   WaitFor——timeout 必填（秒面=毫秒，上限 600s；上限值=A 级 :194 文档锚，Kimi 源码快照无对应常量）；
//     不传 task_id 时调用时刻无运行任务立即返回、有则任意一个结束即返回；超时不是错误——
//     结果列出仍在运行的任务（A 级 :194）。
// 任务运行柄（abort+children）由 spawnSubagentTask 挂于注册表（WP-05 runtime 面）。

import { spawn, type ChildProcess } from "node:child_process";
import type { TaskRegistry, TaskStatus } from "./task-registry.ts";

/** Kimi 内联预览上限（A 级 :190）。 */
export const TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;
/** ORC-032 实测宽限（5_000ms）。 */
export const SIGTERM_GRACE_MS = 5_000;
/** Kimi WaitFor timeout 上限 600 秒（A 级 :194 文档锚；Kimi 源码快照无对应常量）。 */
export const WAITFOR_TIMEOUT_MAX_MS = 600_000;

/** 终态报告超上限取最近字节（tail），UTF-8 边界安全。 */
export function tailPreview(s: string, maxBytes: number): { content: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { content: s, truncated: false };
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) start++; // 跳 UTF-8 续字节
  return { content: buf.subarray(start).toString("utf8"), truncated: true };
}

export interface TaskOutputResult {
  status: TaskStatus;
  content: string;
  truncated: boolean;
}

/** TaskOutput：非阻塞快照（M3 任务输出=终态报告；运行中无缓冲内容——偏差登记）。 */
export function taskOutput(registry: TaskRegistry, taskId: string): TaskOutputResult {
  const t = registry.get(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  return { status: t.status, ...tailPreview(t.result?.content ?? "", TASK_OUTPUT_PREVIEW_BYTES) };
}

/** 优雅杀（SIGTERM 面；Windows=taskkill /T 无 /F，M1 中断先例的平台映射）。 */
export function killGraceful(child: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T"], { stdio: "ignore" }).unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  } catch {}
}

/** 强杀（SIGKILL 面；Windows=taskkill /T /F）。 */
export function killForce(child: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {}
}

export interface StopTaskOptions {
  /** 两阶段宽限（缺省 SIGTERM_GRACE_MS=5000；测试注入）。 */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  killGraceful?: (child: ChildProcess) => void;
  killForce?: (child: ChildProcess) => void;
  /** 终止原因（缺省 "Stopped by TaskStop"——Kimi :193）。 */
  reason?: string;
}

export interface StopTaskResult {
  stopped: boolean;
  /** 已终态安全调用（Kimi :193）。 */
  alreadyTerminal: boolean;
}

/** TaskStop：两阶段终止（SIGTERM→grace→SIGKILL）+任务 abort（循环/工具观察 signal 收尾）。 */
export async function stopTask(registry: TaskRegistry, taskId: string, opts: StopTaskOptions = {}): Promise<StopTaskResult> {
  const t = registry.get(taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  if (t.status !== "running") return { stopped: false, alreadyTerminal: true };
  const rt = registry.getRuntime(taskId);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const kg = opts.killGraceful ?? killGraceful;
  const kf = opts.killForce ?? killForce;

  // 阶段一：SIGTERM 子进程 + abort 循环（工具观察 signal 自行收尾；宽限内不强杀）
  for (const c of rt?.children ?? []) kg(c);
  rt?.abort.abort();
  await sleep(opts.graceMs ?? SIGTERM_GRACE_MS);
  // 阶段二：仍存活者 SIGKILL
  for (const c of rt?.children ?? []) if (c.exitCode === null && !c.killed) kf(c);

  registry.fail(taskId, opts.reason ?? "Stopped by TaskStop"); // settle 幂等：run 已 complete 则 no-op
  return { stopped: true, alreadyTerminal: false };
}

export interface WaitForOptions {
  /** 必填（Kimi :197 timeout 必填，上限 600s）。 */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** 轮询间隔（缺省 50ms；测试注入）。 */
  pollMs?: number;
}

export interface WaitForResult {
  timedOut: boolean;
  /** 已结束任务快照；无 task_id 时=调用时刻运行任务中第一个结束的。 */
  finished?: { taskId: string; status: "completed" | "failed"; content: string | undefined };
  /** 超时非错误：列出仍在运行的任务（Kimi :197）。 */
  running: string[];
}

function runningIds(registry: TaskRegistry): string[] {
  return registry.list({ activeOnly: true }).map((t) => t.taskId);
}

/** WaitFor：本轮内阻塞等待任务结束或超时（不传 taskId=任意运行任务结束即返回；无运行立即返回）。 */
export async function waitForTask(registry: TaskRegistry, taskId: string | undefined, opts: WaitForOptions): Promise<WaitForResult> {
  if (opts.timeoutMs > WAITFOR_TIMEOUT_MAX_MS) {
    throw new Error(`WaitFor timeout exceeds limit (max ${WAITFOR_TIMEOUT_MAX_MS}ms, ORC-032)`);
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + opts.timeoutMs;

  if (taskId !== undefined) {
    const t = registry.get(taskId);
    if (!t) throw new Error(`unknown task: ${taskId}`);
    while (t.status === "running") {
      if (Date.now() >= deadline) return { timedOut: true, running: runningIds(registry) };
      await sleep(pollMs);
    }
    return { timedOut: false, finished: { taskId: t.taskId, status: t.status as "completed" | "failed", content: t.result?.content }, running: runningIds(registry) };
  }

  // 不传 task_id：无运行中立即返回；否则监控调用时刻集合，任一结束即返回
  const watched = registry.list({ activeOnly: true });
  if (watched.length === 0) return { timedOut: false, running: [] };
  const ids = new Set(watched.map((t) => t.taskId));
  for (;;) {
    for (const id of ids) {
      const t = registry.get(id);
      if (t && t.status !== "running") {
        return { timedOut: false, finished: { taskId: id, status: t.status as "completed" | "failed", content: t.result?.content }, running: runningIds(registry) };
      }
    }
    if (Date.now() >= deadline) return { timedOut: true, running: runningIds(registry) };
    await sleep(pollMs);
  }
}
