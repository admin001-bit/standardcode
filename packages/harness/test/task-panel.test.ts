// WP-05（M3）任务面板 /tasks /background + TaskOutput/TaskStop/WaitFor 测试（ORC-032；判据自足：板 WP-05 DoD①-④）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { createTaskRegistry } from "../src/task-registry.ts";
import {
  SIGTERM_GRACE_MS,
  TASK_OUTPUT_PREVIEW_BYTES,
  WAITFOR_TIMEOUT_MAX_MS,
  tailPreview,
  taskOutput,
  stopTask,
  waitForTask,
} from "../src/task-control.ts";
import { spawnSubagentTask } from "../src/subagent-tasks.ts";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

/** 可控假子进程（两阶段断言：exitCode/killed 状态机）。 */
function fakeChild(): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; killed: boolean; pid: number };
  c.pid = 4242;
  c.exitCode = null;
  c.killed = false;
  return c as ChildProcess;
}

function instantProvider(): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    countTokens: async () => 0,
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("instant fail");
    },
  };
}

describe("DoD① /tasks 参数语义（active_only/limit 边界 1–100）", () => {
  it("默认 active_only=true 仅列运行中；all 含终态；limit 截断", () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const a = reg.register({ agentId: "a", agentType: "general-purpose", description: "task a", isBackgrounded: true });
    const b = reg.register({ agentId: "b", agentType: "general-purpose", description: "task b", isBackgrounded: false });
    reg.complete(a.taskId, { content: "x", totalTokens: 5, totalToolUseCount: 1, totalDurationMs: 1, doneReason: "end" });
    // 面板消费面=list 语义（/tasks 命令在 apps/cli 断言）
    expect(reg.list({ activeOnly: true }).map((t) => t.taskId)).toEqual([b.taskId]);
    expect(reg.list().map((t) => t.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(reg.list().slice(0, 1)).toHaveLength(1);
  });

  // parseTasksArgs 在 apps/cli（与命令表同处），断言在 apps/cli/test/task-panel.test.ts
});

describe("DoD② TaskOutput 32KB 截断（内联预览=最近 32KB tail）", () => {
  it("tailPreview：短文本原样；超限取尾部且不劈 UTF-8 多字节", () => {
    expect(tailPreview("hello", 32_768)).toEqual({ content: "hello", truncated: false });
    const big = "a".repeat(40_000);
    const r = tailPreview(big, TASK_OUTPUT_PREVIEW_BYTES);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, "utf8")).toBe(TASK_OUTPUT_PREVIEW_BYTES);
    expect(r.content.endsWith("a".repeat(100))).toBe(true);
    // 多字节边界：10000 个中文（3 字节/字）→ 尾部起点不得落在续字节
    const cjk = "汉".repeat(10_000);
    const r2 = tailPreview(cjk, 300);
    expect(r2.content).toBe("汉".repeat(100));
  });

  it("taskOutput：终态快照含内容、非阻塞；运行中=空内容快照", () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    expect(taskOutput(reg, t.taskId)).toEqual({ status: "running", content: "", truncated: false });
    reg.complete(t.taskId, { content: "final report", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" });
    expect(taskOutput(reg, t.taskId)).toEqual({ status: "completed", content: "final report", truncated: false });
    expect(() => taskOutput(reg, "task-404")).toThrow(/unknown task/);
  });
});

describe("DoD③ TaskStop 两阶段断言（宽限期内核未杀）", () => {
  it("阶段一 SIGTERM+宽限（缺省 5000ms 可注入）；阶段二仍存活才 SIGKILL", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    const abort = new AbortController();
    const c1 = fakeChild(); // 阶段二仍存活 → 强杀
    const c2 = fakeChild(); // 宽限内自行退出 → 不强杀
    reg.attachRuntime(t.taskId, { abort, children: new Set([c1, c2]) });
    const graceful: ChildProcess[] = [];
    const forced: ChildProcess[] = [];
    const slept: number[] = [];
    const r = await stopTask(reg, t.taskId, {
      sleep: async (ms) => {
        slept.push(ms);
        (c2 as any).exitCode = 0; // 模拟宽限期内退出
      },
      killGraceful: (c) => graceful.push(c),
      killForce: (c) => forced.push(c),
    });
    expect(r).toEqual({ stopped: true, alreadyTerminal: false });
    expect(slept).toEqual([SIGTERM_GRACE_MS]); // 5s 宽限（ORC-032 实测常量）
    expect(graceful.length).toBe(2); // 阶段一对全部子进程
    expect(forced).toEqual([c1]); // 阶段二只杀仍存活者——宽限期内核未杀
    expect(abort.signal.aborted).toBe(true); // 循环观察 signal 收尾
    expect(reg.get(t.taskId)?.status).toBe("failed");
    expect(reg.get(t.taskId)?.error).toBe("Stopped by TaskStop");
  });

  it("graceMs 覆盖+reason 自定义；已终态安全调用（Kimi :193）；run 已 complete 后 stop 不覆写", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    reg.attachRuntime(t.taskId, { abort: new AbortController(), children: new Set() });
    const r1 = await stopTask(reg, t.taskId, { graceMs: 1, reason: "user aborted" });
    expect(r1.stopped).toBe(true);
    expect(reg.get(t.taskId)?.error).toBe("user aborted");
    const r2 = await stopTask(reg, t.taskId, { graceMs: 1 });
    expect(r2).toEqual({ stopped: false, alreadyTerminal: true }); // 安全 no-op
    // settle 幂等：complete 后 stop 不覆写 completed
    const t3 = reg.register({ agentId: "c", agentType: "g", description: "d", isBackgrounded: true });
    reg.complete(t3.taskId, { content: "ok", totalTokens: 0, totalToolUseCount: 0, totalDurationMs: 0, doneReason: "end" });
    const r3 = await stopTask(reg, t3.taskId, { graceMs: 1 });
    expect(r3.alreadyTerminal).toBe(true);
    expect(reg.get(t3.taskId)?.status).toBe("completed");
  });

  it("真子进程集成：node -e 挂起进程 → 两阶段终止真实 SIGKILL（宽限期后 pid 消亡）", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], { stdio: "ignore" });
    child.unref();
    reg.attachRuntime(t.taskId, { abort: new AbortController(), children: new Set([child]) });
    await stopTask(reg, t.taskId, { graceMs: 800 });
    const exited = await new Promise<boolean>((res) => {
      child.once("exit", () => res(true));
      setTimeout(() => res(false), 4_000);
    });
    expect(exited).toBe(true); // 强杀生效
    expect(child.exitCode !== null || child.signalCode !== null || process.platform === "win32").toBe(true);
  }, 20_000);
});

describe("DoD④ WaitFor 本轮内等待+超时语义（timeout 必填/上限/超时非错误）", () => {
  it("有 task_id：等待至完成；结果带内容快照", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    setTimeout(() => reg.complete(t.taskId, { content: "late result", totalTokens: 3, totalToolUseCount: 1, totalDurationMs: 1, doneReason: "end" }), 30);
    const r = await waitForTask(reg, t.taskId, { timeoutMs: 5_000, pollMs: 10 });
    expect(r.timedOut).toBe(false);
    expect(r.finished).toMatchObject({ taskId: t.taskId, status: "completed", content: "late result" });
  });

  it("超时不是错误：timedOut=true 且列出仍在运行的任务", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const t = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    const r = await waitForTask(reg, t.taskId, { timeoutMs: 30, pollMs: 10 });
    expect(r.timedOut).toBe(true);
    expect(r.running).toContain(t.taskId);
    expect(r.finished).toBeUndefined();
    reg.fail(t.taskId, "cleanup");
  });

  it("无 task_id：运行中=任意一个结束即返回；无运行=立即返回", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const empty = await waitForTask(reg, undefined, { timeoutMs: 5_000, pollMs: 10 });
    expect(empty).toEqual({ timedOut: false, running: [] }); // 立即返回
    const a = reg.register({ agentId: "a", agentType: "g", description: "d", isBackgrounded: true });
    const b = reg.register({ agentId: "b", agentType: "g", description: "d", isBackgrounded: true });
    setTimeout(() => reg.complete(b.taskId, { content: "b done", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" }), 20);
    const r = await waitForTask(reg, undefined, { timeoutMs: 5_000, pollMs: 10 });
    expect(r.finished?.taskId).toBe(b.taskId);
    expect(r.running).toContain(a.taskId); // a 仍运行
    reg.fail(a.taskId, "cleanup");
  });

  it("timeout 上限 600s（Kimi :197）；unknown task 抛错", async () => {
    const reg = createTaskRegistry({});
    await expect(waitForTask(reg, undefined, { timeoutMs: WAITFOR_TIMEOUT_MAX_MS + 1 })).rejects.toThrow(/exceeds limit/);
    await expect(waitForTask(reg, "task-404", { timeoutMs: 100 })).rejects.toThrow(/unknown task/);
  });

  it("端到端：spawn 后台任务→WaitFor 等其完成→TaskOutput 读报告（通道一致性）", async () => {
    const reg = createTaskRegistry({ evictAfterMs: 0 });
    const launch = await spawnSubagentTask(
      { prompt: "p", description: "d" },
      { depth: 0, availableTypes: ["general-purpose"] },
      { provider: instantProvider(), model: "m", tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }] },
      { registry: reg, env: {} },
    );
    expect(launch.status).toBe("async_launched");
    if (launch.status !== "async_launched") return;
    const r = await waitForTask(reg, launch.taskId, { timeoutMs: 5_000, pollMs: 10 });
    expect(r.finished?.status).toBe("failed"); // instantProvider 恒抛
    expect(reg.get(launch.taskId)?.error).toContain("instant fail");
    // 槽已释放
    expect(reg.getConcurrentSubagents()).toBe(0);
  });
});
