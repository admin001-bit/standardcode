// M6-WP-05：CLI 侧 workflow 进度看板（DoD②/③/④ 装配面）。
//
// 本模块是会话级的「活动 workflow 进度 trackers」+「完成通知队列」容器，供：
//   - /workflows 命令读取活动 tracker 并渲染最小进度树（DoD④）；
//   - repl.ts runPromptTurn 在每轮 user turn 前 drain 完成通知、isomorphic 到 M4-WP04 的
//     drainMcpNotifications → Notification 钩子路径，把 <task-notification> 作为 user turn 注入主循环（DoD③）。
//
// 形态 [自定]（登记供 V）：以进程级单例承载（CLI 单会话进程，与 session 同生命周期）；不触碰 /tasks 与后台 subagent
// 任务族（packages/harness 的 task-registry/task-control），故既有后台任务面零回归。真实 runner（M7-WP-13④ 已落：
// apps/cli/src/workflow-runner.ts）在派生 workflow 时 workflowBoard.register(runId, tracker) 并 queue.push(完成通知)；
// 终态分支配对 unregister(runId)（⑬ 生命周期，防单例 trackers 泄漏——register/unregister 恒等配对）。
// 本卡只提供容器 + 命令 + 注入点。

import {
  createWorkflowProgressTracker,
  createWorkflowCompletionQueue,
  type WorkflowProgressTracker,
  type WorkflowCompletionQueue,
} from "@standardcode/capabilities";

export class WorkflowBoard {
  private trackers = new Map<string, WorkflowProgressTracker>();
  private activeRunId: string | null = null;
  readonly queue: WorkflowCompletionQueue = createWorkflowCompletionQueue();

  /** 注册某 run 的进度 tracker（同时设为活动 run，供 /workflows 默认展示）。 */
  register(runId: string, tracker: WorkflowProgressTracker): void {
    this.trackers.set(runId, tracker);
    this.activeRunId = runId;
  }

  unregister(runId: string): void {
    this.trackers.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = null;
  }

  get(runId: string): WorkflowProgressTracker | null {
    return this.trackers.get(runId) ?? null;
  }

  /** 活动（最近注册）的 tracker；无= null。 */
  active(): WorkflowProgressTracker | null {
    return this.activeRunId ? (this.trackers.get(this.activeRunId) ?? null) : null;
  }

  /** 全部活动 trackers（/workflows 展示全集）。 */
  list(): WorkflowProgressTracker[] {
    return [...this.trackers.values()];
  }

  /** drain 待投递的完成通知（once-only：清空缓冲）。 */
  drainNotifications(): string[] {
    return this.queue.drain();
  }
}

/** 进程级单例（与 session 同生命周期；单 CLI 会话进程）。 */
export const workflowBoard = new WorkflowBoard();

// 重新导出便于命令/装配层统一从本模块取类型与构造器（避免命令直接 import capabilities 细节）。
export { createWorkflowProgressTracker, createWorkflowCompletionQueue };
export type { WorkflowProgressTracker, WorkflowCompletionQueue };
