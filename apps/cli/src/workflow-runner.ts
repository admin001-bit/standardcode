// M7-WP-13（①④⑨⑩⑬）：workflow 真实 runner 装配层。
//
// 形制：镜像同目录 `workflow-board.ts` 的「独立模块 + 进程级单例」——board 仍是进程级单例（`workflowBoard`），
// 本模块是**装配五步**的落点（caps/workflow/progress.ts:296-301 官方接线约定逐条兑现）：
//   ① `createWorkflowProgressTracker({ name, runId, phases: meta.phases })`
//   ② `createWorkflowOrchestrator({ onPhase: t => tracker.phase(t), onLog: m => tracker.log(m), budget, onTelemetry })`
//   ③ `createWorkflowJournalSession({ orchestration, runsDir, runId, onReplay: mark => tracker.agentProgress(mark) })`
//      （journal session 内部即 `withWorkflowJournal` 包装 + run 目录单入口——caps/journal.ts:474 契约）
//   ④ 终态：`workflowBoard.queue.push({ name, runId, status, resultPreview })`
//   ⑤ `workflowBoard.register(runId, tracker)`（本模块在派生**前**注册，终态分支配对 `unregister`——⑬）
//   ⑥ `runWorkflowScript({ script, hooks: journaled.hooks, budget })`（vm 沙箱求值，WP-02 单源）
//
// 依赖纪律（同 board：装配层持 capabilities 细节，命令面不直连）：
//   - ① 目录根 runsDir 由调用方（apps/cli/session.ts workflow 门段）经 platform `workflowsDir(projectRoot)` 注入；
//   - ⑨ 遥测桥：`createWorkflowTelemetryBridge` 映射 `tengu_workflow_*` → `sc_workflow_*` 后经 `forwardTelemetry`
//     落到装配层注入的 facade `workflowEvent`；**缺位=不注入 onTelemetry=零事件产出**（WP-11 接缝㉑）；
//   - ⑩ budget：`makeWorkflowBudget(total, spent)`（caps/workflow/kernel.ts:94 逐字签名）——`spent()` 由装配层
//     注入真实输出 token 读数，本模块只做注入不做计量。
//
// 边界（不做的）：②scriptPath 回填 / ③配方投递（工具面）→ WP-06/07 随卡义务；本模块只落装配与生命周期。

import { randomUUID } from "node:crypto";
import {
  createWorkflowJournalSession,
  createWorkflowOrchestrator,
  createWorkflowProgressTracker,
  createWorkflowTelemetryBridge,
  makeWorkflowBudget,
  parseWorkflowMeta,
  previewWorkflowResult,
  runWorkflowScript,
  type WorkflowCompletionStatus,
  type WorkflowTelemetryForward,
} from "@standardcode/capabilities";
import type { PermissionBroker, SubagentDefinition, Tool } from "@standardcode/harness";
import type { ProviderAdapter } from "@standardcode/providers";
import { workflowBoard, type WorkflowBoard } from "./workflow-board.ts";

/** runner 装配面（会话级基础设施；执行面随每次 run 请求传入——provider 可被 /provider 切换，故不做快照）。 */
export interface WorkflowRunnerOptions {
  /** 运行目录根（①：装配层经 platform `workflowsDir(agentsProjectRoot, ...)` 注入）。 */
  runsDir: string;
  /** ⑨ 遥测转发落点（装配层接 `facade.workflowEvent`）；缺位=不注入桥=零事件。 */
  forwardTelemetry?: WorkflowTelemetryForward;
  /** ⑩ 预算总额（null/缺位=无预算，remaining()=Infinity）。 */
  budgetTotal?: number | null;
  /** ⑩ 已花输出 token 读数（装配层注入真实计数源）；缺位=恒 0。 */
  spent?: () => number;
  /** 看板（缺省=进程级单例 `workflowBoard`；注入=测试 / 多会话独立生命周期）。 */
  board?: WorkflowBoard;
  /** runId 生成（缺省 randomUUID；测试注入便于断言）。 */
  newRunId?: () => string;
}

/** 单次 run 的执行面（provider/model 必备；其余透传 M3 校验链与编排内核）。 */
export interface WorkflowRunRequest {
  /** 脚本文本（MUST 以 `export const meta = {...}` 纯字面量开头，WP-02 静态校验）。 */
  script: string;
  /** 脚本落盘路径（恢复配方用；本卡不落盘，仅供 journal session 组配方文本）。 */
  scriptPath?: string;
  /** 工具调用传入的 args。 */
  args?: unknown;
  /** 从历史 run 的 journal 续跑（缺位=新 run）。 */
  resumeFromRunId?: string | null;
  /** runId（缺位=按 newRunId 生成）。 */
  runId?: string;
  provider: ProviderAdapter;
  model: string;
  /** 可用 agent 类型名（M3 validateSpawn 复用；缺位=空集=全部类型解析失败）。 */
  availableTypes?: Iterable<string>;
  definitionsOf?: (name: string) => SubagentDefinition | undefined;
  tools?: Tool[];
  permissionBroker?: PermissionBroker;
  depth?: number;
  deniedAgentTypes?: string[];
  pendingRequiredMcp?: (required: string[]) => string[];
}

/** run 终态结果（脚本 return 值 / 失败原因；通知已投递、看板已回收）。 */
export interface WorkflowRunOutcome {
  runId: string;
  name: string;
  /** 终态（completed=脚本正常返回；failed=脚本抛错/超时）。 */
  status: Exclude<WorkflowCompletionStatus, "interrupted">;
  /** 脚本顶层 return 值（failed=undefined）。 */
  result: unknown;
  resultPreview: string;
  /** journal 回放命中数（resume 面）。 */
  replays: number;
  /** 失败原因（failed 时在位；上浮不静默——本模块不吞错，只不抛）。 */
  error?: unknown;
}

export interface WorkflowRunner {
  /** ① 注入的运行目录根（journal / script-store 单源的入参）。 */
  readonly runsDir: string;
  /** 装配五步全序执行；终态必投通知且必回收看板（⑬）。 */
  run(request: WorkflowRunRequest): Promise<WorkflowRunOutcome>;
}

export function createWorkflowRunner(options: WorkflowRunnerOptions): WorkflowRunner {
  const board = options.board ?? workflowBoard;
  const newRunId = options.newRunId ?? (() => randomUUID());

  return {
    runsDir: options.runsDir,
    async run(request: WorkflowRunRequest): Promise<WorkflowRunOutcome> {
      const runId = request.runId ?? newRunId();
      // meta 静态校验前置：失败在 register 之前抛出（不注册、不留看板残项）。
      const { meta } = parseWorkflowMeta(request.script);
      // ① tracker（meta.phases 预声明占位）
      const tracker = createWorkflowProgressTracker({ name: meta.name, runId, phases: meta.phases });
      // ⑤ 注册看板（/workflows 渲染面）
      board.register(runId, tracker);
      // ⑨ 遥测桥（缺位=不注入=零事件，接缝㉑）
      const telemetry = options.forwardTelemetry ? createWorkflowTelemetryBridge({ forward: options.forwardTelemetry }) : undefined;
      // ⑩ budget（total/spent 两面；spent 读数由装配层注入）
      const budget = makeWorkflowBudget(options.budgetTotal ?? null, options.spent ?? (() => 0));
      // ② orchestrator（进度回调 + 遥测 + budget）
      const orchestration = createWorkflowOrchestrator({
        provider: request.provider,
        model: request.model,
        availableTypes: request.availableTypes ?? [],
        budget,
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.definitionsOf !== undefined ? { definitionsOf: request.definitionsOf } : {}),
        ...(request.permissionBroker !== undefined ? { permissionBroker: request.permissionBroker } : {}),
        ...(request.depth !== undefined ? { depth: request.depth } : {}),
        ...(request.deniedAgentTypes !== undefined ? { deniedAgentTypes: request.deniedAgentTypes } : {}),
        ...(request.pendingRequiredMcp !== undefined ? { pendingRequiredMcp: request.pendingRequiredMcp } : {}),
        onPhase: (title) => tracker.phase(title),
        onLog: (message) => tracker.log(message),
        ...(telemetry ? { onTelemetry: telemetry } : {}),
      });
      // ③ journal session（内部 withWorkflowJournal；runsDir 单源入参）+ 回放进度
      const journal = await createWorkflowJournalSession({
        orchestration,
        runsDir: options.runsDir,
        runId,
        ...(request.resumeFromRunId ? { resumeFromRunId: request.resumeFromRunId } : {}),
        ...(request.scriptPath !== undefined ? { scriptPath: request.scriptPath } : {}),
        onReplay: (mark) => tracker.agentProgress(mark),
        ...(telemetry ? { onTelemetry: telemetry } : {}),
      });
      // ⑥ 脚本求值（journaled hooks 已含 resume 回放 + 记录）
      let status: Exclude<WorkflowCompletionStatus, "interrupted"> = "completed";
      let result: unknown;
      let error: unknown;
      try {
        result = await runWorkflowScript({
          script: request.script,
          hooks: journal.hooks,
          budget,
          ...(request.args !== undefined ? { args: request.args } : {}),
        });
      } catch (err) {
        status = "failed";
        error = err;
      }
      // journal 落盘（保留 journal=可续跑；清理面留给显式 cleanupWorkflowRun 调用方）
      await journal.finish().catch(() => {});
      const resultPreview = status === "completed" ? previewWorkflowResult(result) : "";
      // —— 终态分支（④通知 + ⑬看板回收配对 register，防进程级单例泄漏）——
      board.queue.push({ name: meta.name, runId, status, resultPreview });
      board.unregister(runId);
      return {
        runId,
        name: meta.name,
        status,
        result,
        resultPreview,
        replays: journal.replays.length,
        ...(status === "failed" ? { error } : {}),
      };
    },
  };
}
