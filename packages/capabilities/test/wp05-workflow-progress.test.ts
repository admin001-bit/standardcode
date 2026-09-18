// M6-WP-05：workflow 事件流 + 最小进度树 + 完成通知队列测试（DoD①/②/③ 载体）。
// 覆盖：meta.phases 预注册+递增 index / 运行时动态追加 / 未匹配标题自成一组 / log 去重 /
// agent 进度事件形状（cached+resultPreview）/ 订阅 emitter / 完成通知 <task-notification> 形状 + once-only。
// 纯运行时观测面，不依赖 ripgrep（环境基线失败项不涉及本文件）。
import { describe, expect, it } from "vitest";
import {
  createWorkflowCompletionQueue,
  createWorkflowProgressTracker,
  renderWorkflowProgressSnapshot,
  type WorkflowProgressEvent,
  type WorkflowReplayMark,
} from "../src/index.ts";

/** 捕获订阅事件。 */
function collect(tracker = createWorkflowProgressTracker({ phases: [] })) {
  const events: WorkflowProgressEvent[] = [];
  const unsub = tracker.subscribe((e) => events.push(e));
  return { tracker, events, unsub };
}

describe("WP-05 DoD① phase 预注册 + 递增 index", () => {
  it("meta.phases 预注册分配递增 index 且 kind=declared、未运行时出现=未 appeared", () => {
    const t = createWorkflowProgressTracker({ name: "W", runId: "r1", phases: ["Setup", "Run"] });
    const snap = t.snapshot();
    expect(snap.phases.map((p) => [p.index, p.title, p.kind])).toEqual([
      [1, "Setup", "declared"],
      [2, "Run", "declared"],
    ]);
    expect(snap.phases.every((p) => p.appeared === false)).toBe(true);
  });

  it("运行时 phase() 首次出现才 emit 事件（toolUseID=workflow_phase_${index}），再次调用不重复 emit", () => {
    const { tracker, events } = collect(createWorkflowProgressTracker({ phases: ["Setup"] }));
    tracker.phase("Setup");
    tracker.phase("Setup");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "progress",
      toolUseID: "workflow_phase_1",
      data: { type: "workflow_phase", index: 1, title: "Setup", kind: "declared" },
    });
    expect(tracker.snapshot().phases[0]!.appeared).toBe(true);
  });
});

describe("WP-05 DoD① 运行时动态追加 + 未匹配自成一组", () => {
  it("未声明的动态标题追加到现有 index 之后、kind=ungrouped", () => {
    const t = createWorkflowProgressTracker({ phases: ["Setup"] });
    t.phase("Dynamic");
    const snap = t.snapshot();
    const dyn = snap.phases.find((p) => p.title === "Dynamic")!;
    expect(dyn.index).toBe(2); // 递增于预注册 index(1)
    expect(dyn.kind).toBe("ungrouped");
  });

  it("渲染树把 ungrouped 归到 'other phases' 分组，declared 单独列出", () => {
    const t = createWorkflowProgressTracker({ name: "W", runId: "r1", phases: ["Setup"] });
    t.phase("Setup");
    t.phase("Dynamic");
    const out = renderWorkflowProgressSnapshot(t.snapshot());
    expect(out).toContain("[x] phase 1: Setup");
    expect(out).toContain("other phases:");
    expect(out).toContain("[x] phase 2: Dynamic");
  });

  it("预声明未出现的 phase 渲染为 [ ]（pending）", () => {
    const t = createWorkflowProgressTracker({ name: "W", runId: "r1", phases: ["Setup", "Run"] });
    t.phase("Run");
    const out = renderWorkflowProgressSnapshot(t.snapshot());
    expect(out).toContain("[ ] phase 1: Setup");
    expect(out).toContain("[x] phase 2: Run");
  });
});

describe("WP-05 DoD② log 去重（[phase\\0label\\0msg]）", () => {
  it("相同 log 行只 emit 一次、只进入当前 phase 的 logs 一次", () => {
    const { tracker, events } = collect(createWorkflowProgressTracker({ phases: ["Setup"] }));
    tracker.phase("Setup");
    tracker.log("loading config");
    tracker.log("loading config");
    const logs = events.filter((e) => e.type === "progress" && e.toolUseID === "workflow_log");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      type: "progress",
      toolUseID: "workflow_log",
      data: { type: "workflow_log", phase: "Setup", label: "", message: "loading config" },
    });
    expect(tracker.snapshot().phases[0]!.logs).toEqual(["loading config"]);
  });

  it("切换 phase 后同一 message 在该 phase 下仍视为新行（phase 维度参与去重键）", () => {
    const t = createWorkflowProgressTracker({ phases: ["A", "B"] });
    t.phase("A");
    t.log("x");
    t.phase("B");
    t.log("x");
    const a = t.snapshot().phases.find((p) => p.title === "A")!;
    const b = t.snapshot().phases.find((p) => p.title === "B")!;
    expect(a.logs).toEqual(["x"]);
    expect(b.logs).toEqual(["x"]);
  });
});

describe("WP-05 DoD② agent 进度事件形状（cached + resultPreview）", () => {
  it("journal replay mark → 发 workflow_agent_${index}_cached 事件，data.cached=true 且 resultPreview 透传", () => {
    const { tracker, events } = collect(createWorkflowProgressTracker({ phases: ["Run"], runId: "r9" }));
    tracker.phase("Run");
    const mark: WorkflowReplayMark = {
      key: "wfkey-deadbeef",
      agentId: "wfagent-r9-deadbee-1",
      cached: true,
      attempts: 2,
      result: { ok: "yes" },
      resultPreview: '{"ok":"yes"}',
    };
    tracker.agentProgress(mark, { label: "fetch", model: "m", promptPreview: "do it" });
    const agentEvents = events.filter((e) => e.type === "progress" && e.toolUseID.startsWith("workflow_agent_"));
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0]!.toolUseID).toBe("workflow_agent_1_cached");
    expect(agentEvents[0]!.data).toMatchObject({
      type: "workflow_agent",
      index: 1,
      label: "fetch",
      phaseTitle: "Run",
      agentId: "wfagent-r9-deadbee-1",
      model: "m",
      state: "done",
      cached: true,
      resultPreview: '{"ok":"yes"}',
      promptPreview: "do it",
    });
    // 树渲染含 cached 命中预览
    expect(renderWorkflowProgressSnapshot(tracker.snapshot())).toContain("(cached): " + '{"ok":"yes"}');
  });

  it("多个 replay 各自递增 agent index", () => {
    const t = createWorkflowProgressTracker({ phases: [] });
    const ev: WorkflowProgressEvent[] = [];
    t.subscribe((e) => ev.push(e));
    t.agentProgress({ key: "k1", agentId: "a1", cached: true, attempts: 1, result: "r1", resultPreview: "r1" });
    t.agentProgress({ key: "k2", agentId: "a2", cached: true, attempts: 1, result: "r2", resultPreview: "r2" });
    const ids = ev.filter((e) => e.toolUseID.startsWith("workflow_agent_")).map((e) => e.toolUseID);
    expect(ids).toEqual(["workflow_agent_1_cached", "workflow_agent_2_cached"]);
  });
});

describe("WP-05 DoD③ 完成通知队列（<task-notification> 形状 + once-only）", () => {
  it("push 生成 <task-notification> 文本；drain 取出并清空（二次 drain 空=once-only）", () => {
    const q = createWorkflowCompletionQueue();
    q.push({ name: "My WF", runId: "r7", status: "completed", resultPreview: "done 42" });
    const first = q.drain();
    expect(first).toHaveLength(1);
    expect(first[0]).toBe('<task-notification>Workflow "My WF" completed (run r7): done 42</task-notification>');
    expect(q.drain()).toEqual([]); // once-only
  });

  it("status=failed / interrupted 与无 resultPreview 均生成正确文本", () => {
    const q = createWorkflowCompletionQueue();
    q.push({ name: "W", runId: "x", status: "failed" });
    expect(q.drain()[0]).toBe('<task-notification>Workflow "W" failed (run x)</task-notification>');
    q.push({ name: "W", runId: "y", status: "interrupted" });
    expect(q.drain()[0]).toBe('<task-notification>Workflow "W" interrupted (run y)</task-notification>');
  });

  it("多次 push 一次 drain 全部取出", () => {
    const q = createWorkflowCompletionQueue();
    q.push({ name: "A", runId: "1", status: "completed" });
    q.push({ name: "B", runId: "2", status: "completed" });
    expect(q.drain()).toHaveLength(2);
    expect(q.drain()).toEqual([]);
  });
});
