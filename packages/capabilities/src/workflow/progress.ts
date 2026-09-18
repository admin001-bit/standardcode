// M6-WP-05：workflow 事件流 + 最小进度树 + 完成通知队列（DoD①/②/③ 载体）。
//
// 规格：A 级 claude-code-workflow.md §3.3（L168087-168111 phase 注册 / agent 进度 / log 去重）/ §8（/workflows 看实时进度树 +
// 完成时 <task-notification> 回灌主循环）。
//
// 边界（卡）：不改动 kernel.ts / journal.ts / sandbox.ts 语义——本模块是**纯观测面**，由编排装配层把
// orchestrator 的 onPhase / onLog 与 journal 的 onReplay 接进 tracker（接线约定见本文件尾注）。运行态由调用方
// 经 createWorkflowProgressTracker({ phases }) 提供 meta.phases 预声明；运行时 phase() 动态追加；与 meta 不匹配的
// 动态标题自成一组（kind="ungrouped"）。
//
// 复用面：journal.ts 的 previewWorkflowResult（A 级 §7.2 resultPreview 预览上限 200）由 withWorkflowJournal 在生成
// WorkflowReplayMark.resultPreview 时已调用，本模块只消费 mark.resultPreview——不复制预览逻辑。

import type { WorkflowReplayMark } from "./journal.ts";

// ───────────────────────── 事件形状（§3.3 逐字） ─────────────────────────

export type WorkflowProgressPhaseKind = "declared" | "ungrouped";

/** phase 注册进度事件（§3.3：每个 phase 标题取递增 index，首次出现时 emit）。 */
export interface WorkflowPhaseProgressEvent {
  type: "progress";
  /** §3.3：`workflow_phase_${index}`。 */
  toolUseID: string;
  data: { type: "workflow_phase"; index: number; title: string; kind: WorkflowProgressPhaseKind };
}

/** agent 级进度事件（§3.3：`workflow_agent_${index}_cached`，replay 命中 cached:true）。 */
export interface WorkflowAgentProgressEvent {
  type: "progress";
  /** §3.3：`workflow_agent_${index}_cached`。 */
  toolUseID: string;
  data: {
    type: "workflow_agent";
    index: number;
    label: string;
    phaseIndex: number;
    phaseTitle: string;
    agentId: string;
    model: string;
    state: "done";
    startedAt: number;
    lastProgressAt: number;
    cached: true;
    resultPreview: string;
    promptPreview: string;
  };
}

/** log 行进度事件（§3.3：toolUseID 固定 "workflow_log"，按 [phase\0label\0msg] 去重）。 */
export interface WorkflowLogProgressEvent {
  type: "progress";
  toolUseID: "workflow_log";
  data: { type: "workflow_log"; phase: string; label: string; message: string };
}

export type WorkflowProgressEvent = WorkflowPhaseProgressEvent | WorkflowAgentProgressEvent | WorkflowLogProgressEvent;

// ───────────────────────── 树节点 / 快照（最小进度树渲染数据面） ─────────────────────────

export interface WorkflowProgressAgentNode {
  label: string;
  agentId: string;
  cached: boolean;
  resultPreview: string;
}

export interface WorkflowProgressPhaseNode {
  index: number;
  title: string;
  kind: WorkflowProgressPhaseKind;
  appeared: boolean;
  /** 去重后的 log 行（顺序=出现序）。 */
  logs: string[];
  agents: WorkflowProgressAgentNode[];
}

export interface WorkflowProgressSnapshot {
  name: string;
  runId: string;
  /** 按 index 升序。 */
  phases: WorkflowProgressPhaseNode[];
}

// ───────────────────────── tracker ─────────────────────────

export interface WorkflowAgentProgressMeta {
  label?: string;
  model?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  startedAt?: number;
  lastProgressAt?: number;
  promptPreview?: string;
}

export interface WorkflowProgressTrackerOptions {
  name?: string;
  runId?: string;
  /** meta.phases 预声明（仅占位递增 index，运行时首次出现才 emit）。 */
  phases?: readonly string[];
  /** 进度事件订阅（§3.3 形状）；缺位=不订阅。 */
  onEvent?: (event: WorkflowProgressEvent) => void;
}

export interface WorkflowProgressTracker {
  /** 预注册/动态追加 phase；首次运行时出现=emit progress 事件，并切换 current phase（供 log 归属）。 */
  phase(title: string): void;
  /** 追加一条 log（按 [phase\0label\0msg] 去重；label 恒为空——sandbox 注入的 log 仅带 message）。 */
  log(message: string): void;
  /** journal 回放命中 → emit agent 进度事件（cached:true + resultPreview）。 */
  agentProgress(mark: WorkflowReplayMark, opts?: WorkflowAgentProgressMeta): void;
  /** 订阅进度事件；返回取消订阅函数。 */
  subscribe(listener: (event: WorkflowProgressEvent) => void): () => void;
  /** 当前进度快照（最小树渲染数据源）。 */
  snapshot(): WorkflowProgressSnapshot;
}

export function createWorkflowProgressTracker(options: WorkflowProgressTrackerOptions = {}): WorkflowProgressTracker {
  const name = options.name ?? "";
  const runId = options.runId ?? "";
  const listeners = new Set<(event: WorkflowProgressEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);

  // phase index 分配（单调递增；声明态优先占位，保证 index 确定可预测）。
  const phaseByTitle = new Map<string, WorkflowProgressPhaseNode>();
  const declaredTitles = new Set<string>();
  let nextPhaseIndex = 1;

  const ensurePhase = (title: string, kind: WorkflowProgressPhaseKind): WorkflowProgressPhaseNode => {
    let node = phaseByTitle.get(title);
    if (!node) {
      node = { index: nextPhaseIndex++, title, kind, appeared: false, logs: [], agents: [] };
      phaseByTitle.set(title, node);
    }
    return node;
  };

  // 预注册 meta.phases：仅占位 index，不 emit（emit 在运行时首次出现——§3.3「on first appearance」）。
  for (const title of options.phases ?? []) {
    if (!phaseByTitle.has(title)) {
      phaseByTitle.set(title, { index: nextPhaseIndex++, title, kind: "declared", appeared: false, logs: [], agents: [] });
    }
    declaredTitles.add(title);
  }

  const appearedPhases = new Set<string>();
  const current = { phaseTitle: "", phaseIndex: -1 };
  const logSeen = new Set<string>();
  let nextAgentIndex = 0;

  const emit = (event: WorkflowProgressEvent): void => {
    for (const l of listeners) l(event);
  };

  const phase = (title: string): void => {
    const declared = declaredTitles.has(title);
    const node = phaseByTitle.get(title) ?? ensurePhase(title, declared ? "declared" : "ungrouped");
    node.appeared = true;
    current.phaseTitle = title;
    current.phaseIndex = node.index;
    if (!appearedPhases.has(title)) {
      appearedPhases.add(title);
      emit({
        type: "progress",
        toolUseID: `workflow_phase_${node.index}`,
        data: { type: "workflow_phase", index: node.index, title, kind: node.kind },
      });
    }
  };

  const log = (message: string): void => {
    const phaseTitle = current.phaseTitle;
    const label = ""; // 裸 log() 不带 label（sandbox 注入仅 message）
    const key = `${phaseTitle}\0${label}\0${message}`;
    if (logSeen.has(key)) return; // §3.3 去重：同一 [phase\0label\0msg] 只 emit 一次
    logSeen.add(key);
    const node = phaseTitle ? phaseByTitle.get(phaseTitle) : undefined;
    node?.logs.push(message);
    emit({
      type: "progress",
      toolUseID: "workflow_log",
      data: { type: "workflow_log", phase: phaseTitle, label, message },
    });
  };

  const agentProgress = (mark: WorkflowReplayMark, opts: WorkflowAgentProgressMeta = {}): void => {
    const index = ++nextAgentIndex; // 单调 agent 序号（1-based）
    const phaseIndex = opts.phaseIndex ?? current.phaseIndex;
    const phaseTitle = opts.phaseTitle ?? current.phaseTitle;
    const label = opts.label ?? mark.key;
    const node = phaseTitle ? phaseByTitle.get(phaseTitle) : undefined;
    node?.agents.push({ label, agentId: mark.agentId, cached: true, resultPreview: mark.resultPreview });
    emit({
      type: "progress",
      toolUseID: `workflow_agent_${index}_cached`,
      data: {
        type: "workflow_agent",
        index,
        label,
        phaseIndex,
        phaseTitle,
        agentId: mark.agentId,
        model: opts.model ?? "",
        state: "done",
        startedAt: opts.startedAt ?? 0,
        lastProgressAt: opts.lastProgressAt ?? 0,
        cached: true,
        resultPreview: mark.resultPreview,
        promptPreview: opts.promptPreview ?? "",
      },
    });
  };

  const subscribe = (listener: (event: WorkflowProgressEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const snapshot = (): WorkflowProgressSnapshot => ({
    name,
    runId,
    phases: [...phaseByTitle.values()]
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ ...p, logs: [...p.logs], agents: [...p.agents] })),
  });

  return { phase, log, agentProgress, subscribe, snapshot };
}

// ───────────────────────── 最小进度树渲染（纯文本，无 TUI/ANSI 绘制） ─────────────────────────

export function renderWorkflowProgressSnapshot(snap: WorkflowProgressSnapshot): string {
  const lines: string[] = [];
  const header = snap.name
    ? `workflow: ${snap.name}${snap.runId ? ` (run ${snap.runId})` : ""}`
    : "workflow";
  lines.push(header);
  const declared = snap.phases.filter((p) => p.kind === "declared");
  const ungrouped = snap.phases.filter((p) => p.kind === "ungrouped");
  const renderPhase = (p: WorkflowProgressPhaseNode): void => {
    const state = p.appeared ? "[x]" : "[ ]";
    lines.push(`  ${state} phase ${p.index}: ${p.title}`);
    for (const a of p.agents) {
      const cache = a.cached ? " (cached)" : "";
      lines.push(`      - agent ${a.label}${cache}: ${a.resultPreview}`);
    }
    for (const m of p.logs) lines.push(`      . ${m}`);
  };
  for (const p of declared) renderPhase(p);
  if (ungrouped.length > 0) {
    lines.push("  other phases:");
    for (const p of ungrouped) renderPhase(p);
  }
  return lines.join("\n");
}

export function renderWorkflowProgressTree(tracker: WorkflowProgressTracker): string {
  return renderWorkflowProgressSnapshot(tracker.snapshot());
}

// ───────────────────────── 完成通知队列（DoD③：<task-notification> 回灌主循环） ─────────────────────────

export type WorkflowCompletionStatus = "completed" | "failed" | "interrupted";

export interface WorkflowCompletionNotification {
  name: string;
  runId: string;
  status: WorkflowCompletionStatus;
  resultPreview?: string;
}

export interface WorkflowCompletionQueue {
  /** 投递一条完成通知（生成 <task-notification> 文本，挂入待 drain 缓冲）。 */
  push(notification: WorkflowCompletionNotification): void;
  /** 取出并清空全部待投递通知（once-only：drain 后缓冲空，二次 drain 返回空）。 */
  drain(): string[];
}

export function createWorkflowCompletionQueue(): WorkflowCompletionQueue {
  const buf: string[] = [];
  return {
    push(notification) {
      const preview = notification.resultPreview ? `: ${notification.resultPreview}` : "";
      buf.push(
        `<task-notification>Workflow "${notification.name}" ${notification.status} (run ${notification.runId})${preview}</task-notification>`,
      );
    },
    drain() {
      return buf.splice(0, buf.length);
    },
  };
}

// ───────────────────────── 接线约定（登记供 V：本模块是纯观测面，不主动接 kernel） ─────────────────────────
// 编排装配层（workflow runner，WP-07+）在构建 createWorkflowOrchestrator + createWorkflowJournalSession 时：
//   ① 用 meta.phases 建 tracker：`const tracker = createWorkflowProgressTracker({ name, runId, phases: meta.phases })`
//   ② orchestrator 选项注入：`onPhase: (t) => tracker.phase(t)`、`onLog: (m) => tracker.log(m)`
//   ③ journal 选项注入：`onReplay: (mark) => tracker.agentProgress(mark)`
//   ④ 完成（脚本 return / 异常 / 中断）时：`workflowBoard.queue.push({ name, runId, status, resultPreview })`
//   ⑤ 把 tracker 挂到 CLI board：`workflowBoard.register(runId, tracker)`（供 /workflows 渲染）
// 以上 5 点属 runner 接线，不在本卡（WP-05）实现范围；本卡只提供 tracker / 渲染 / 队列 / board / 命令 / 注入点。
