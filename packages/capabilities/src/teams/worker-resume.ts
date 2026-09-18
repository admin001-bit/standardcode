// M6-WP-09：停止 worker 的续聊恢复（按 agentId 寻址 → 复用 platform `resumeFrom` 从转录重建）。
//
// 依据：v2.8 ORC-040~042（行 296）+ ORC-023（行 295）；接缝⑲。
// 逐字锚点（`D:\StandardCode\evidence\claude-src-extracted\_440.js` 取行核对）：
//   L208382（**DoD③ 引句的真实行位**——卡面标 L37916 系笔误，见报告 §2.2）：
//     `Refer to agents by name — names keep working after an agent completes (a send resumes it from its transcript).`
//   L37916：`- The \`<task-id>\` value is the agent ID — use SendMessage with that ID as \`to\` to continue that worker`
//   L37966：`Use ${Gm} to stop a worker you sent in the wrong direction … Stopped workers can be continued with ${ko}.`
//   L179075：`agentId: ${e.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${e.agentId}', summary: '<5-10 word recap>' to continue this agent.)`
//
// [自定] 口径（供 V 核验）：
//   ① **转录读取必须复用 platform `resumeFrom`**（卡硬约束：禁止复制实现）。本包（capabilities）不依赖
//      platform，故以**注入**方式接入：`resumeTranscript` 由装配层传 `resumeFrom` 真身（apps/cli session 面），
//      单测注入替身；同一份 platform 实现另在 `apps/cli/test/wp09-worker-resume.test.ts` 用真实
//      `TranscriptWriter`/`resumeFrom` 端到端复跑，证明"复用而非复制"。
//   ② **per-agentId 转录命名**：本仓转录为会话级（`TranscriptWriter.create(projectRoot, sessionId)`），
//      **无 per-worker 转录文件**；本卡表名 `<transcriptsDir>/<agentId>.jsonl` 系 [自定]，
//      生产者（谁写该文件）在本卡范围外 → 显式登记为未接线 F 项，不得伪称已接线。
//   ③ fail-closed 五缺口服具（**禁静默成功**）：不可寻址 agentId / 无任务记录 / 任务仍在 running /
//      转录文件缺失 / 重建后零消息 —— 逐个 `stage` 点名（抛 `WorkerResumeError` 携带 stage），且均经 `warn` 上浮。
//   ④ 同名歧义：一个 agentId 命中多任务时取注册序最后一条（[自定]；本仓同 agentId 复用场景极窄）。
//   ⑤ 新增于 teams 目录（第 9 个文件）——**teams 七件一行未改**，对外工具集零增量（BLK-08=①）。

import { existsSync } from "node:fs";
import type { LLMMessage } from "@standardcode/providers";
import type { TaskRegistry } from "@standardcode/harness";
import { sendMessage, type SendMessageFailure, type SendMessagePort } from "./send-message.ts";
import type { TeamRoster } from "./roster.ts";

/** 注入式转录恢复结果（platform `resumeFrom` 的结构面）。 */
export interface WorkerResumeTranscript {
  messages: LLMMessage[];
  lastReason?: string;
  skippedMalformed: number;
}

/** fail-closed 阶段（每个阶段=一处点名拒绝分支，测试逐一覆盖）。 */
export const WORKER_RESUME_STAGES = [
  "unknown_target",
  "no_task",
  "still_running",
  "no_transcript",
  "empty_transcript",
  "delivery",
] as const;

export type WorkerResumeStage = (typeof WORKER_RESUME_STAGES)[number];

/** 阶段 → 机器可读失败分类（复用 WP-06 五类，不新增失败名）。 */
export const WORKER_RESUME_FAILURE_MAP: Readonly<Record<WorkerResumeStage, SendMessageFailure>> = {
  unknown_target: "not_reachable",
  no_task: "not_reachable",
  still_running: "invalid_target",
  no_transcript: "not_reachable",
  empty_transcript: "not_reachable",
  delivery: "send_failed",
};

/** ③ 点名文案构造器（stage + detail → 可读原文）。 */
export function workerResumeFailureText(stage: WorkerResumeStage, detail: string): string {
  switch (stage) {
    case "unknown_target":
      return `worker resume: \`${detail}\` is not an addressable agentId in this team's roster — a stopped worker is continued by its agentId, which stays addressable after completion`;
    case "no_task":
      return `worker resume: no task record for agentId \`${detail}\` — nothing to resume (the worker must have run once in this registry)`;
    case "still_running":
      return `worker resume: agent \`${detail}\` is still running — only stopped workers can be resumed from their transcript (stop it first)`;
    case "no_transcript":
      return `worker resume: transcript file absent for agentId \`${detail}\` — cannot rebuild its history to resume from`;
    case "empty_transcript":
      return `worker resume: transcript for agentId \`${detail}\` rebuilt to zero messages — no history to resume from (refusing to fabricate a seed)`;
    case "delivery":
      return `worker resume: delivery failed for agentId \`${detail}\``;
  }
}

/** 携带 stage 的拒绝错（fail-closed 分支的机器可读面——凭 `stage` 精确断言，不靠文案匹配）。 */
export class WorkerResumeError extends Error {
  readonly stage: WorkerResumeStage;
  constructor(stage: WorkerResumeStage, detail: string) {
    super(workerResumeFailureText(stage, detail));
    this.name = "WorkerResumeError";
    this.stage = stage;
  }
}

/** 续聊种子（投递成功后与回执一并返回；寄件的恢复底座）。 */
export interface WorkerResumeSeed {
  agentId: string;
  /** 成员名（L208382「Refer to agents by name」：有名优先按名，agentId 是内部 ID）。 */
  memberName?: string;
  taskId: string;
  transcriptPath: string;
  messages: LLMMessage[];
  lastReason?: string;
  skippedMalformed: number;
}

export type WorkerContinueResult =
  | { ok: true; receipt: string; seed: WorkerResumeSeed }
  | { ok: false; stage: WorkerResumeStage; failure: SendMessageFailure; reason: string };

export interface WorkerResumeOptions {
  roster: TeamRoster;
  registry: TaskRegistry;
  /** agentId → 转录文件路径（装配层注入；命名 [自定]②）。 */
  transcriptPathFor(agentId: string): string;
  /** 转录恢复实现（装配层传 platform `resumeFrom` —— ① 禁复制实现）。 */
  resumeTranscript(filePath: string): Promise<WorkerResumeTranscript>;
  /** 发送口（成员投递落点）。 */
  port: SendMessagePort;
  /** 发送者名（self-target 预检面）。 */
  selfName?: string;
  /** 转录存在性判定（缺省 `node:fs` existsSync；测试注入使该分支可证伪）。 */
  transcriptExists?(filePath: string): boolean;
  /** 告警通道（fail-closed 上浮面）。缺省=写 stderr。 */
  warn?(message: string): void;
}

export interface WorkerResumePort {
  readonly roster: TeamRoster;
  /** 只读出续聊种子（不投递；失败抛 `WorkerResumeError`）。 */
  seed(agentId: string): Promise<WorkerResumeSeed>;
  /** 完整通路：寻址→终态校验→转录重建→经 SendMessage 投递（DoD③「a send resumes it」）。 */
  continueWorker(input: { agentId: string; message: unknown; summary?: string }): Promise<WorkerContinueResult>;
}

export function createWorkerResume(options: WorkerResumeOptions): WorkerResumePort {
  const { roster, registry, port } = options;
  const exists = options.transcriptExists ?? ((p: string) => existsSync(p));
  const warn =
    options.warn ??
    ((m: string) => {
      try {
        process.stderr.write(`${m}\n`);
      } catch {
        /* 告警不静默，但不因写入失败而崩 */
      }
    });

  function fail(stage: WorkerResumeStage, detail: string): never {
    const err = new WorkerResumeError(stage, detail);
    warn(`[WP-09] ${err.message}`); // ③ fail-closed：告警上浮 + 抛错，双通道禁静默
    throw err;
  }

  /** ④ 一 Id 多任务取注册序最后一条；running=不可恢复。 */
  function terminalTaskOf(agentId: string): string {
    const hits = registry.list().filter((t) => t.agentId === agentId);
    if (hits.length === 0) fail("no_task", agentId); // ③ 无任务记录
    const last = hits[hits.length - 1]!;
    if (last.status === "running") fail("still_running", agentId); // ③ 仍在运行
    return last.taskId;
  }

  async function buildSeed(agentId: string): Promise<WorkerResumeSeed> {
    const route = roster.resolve(agentId);
    if (route.kind !== "member") fail("unknown_target", agentId); // ③ 不可寻址（含 "main"：main 不是 worker）
    const taskId = terminalTaskOf(agentId);
    const transcriptPath = options.transcriptPathFor(agentId);
    if (!exists(transcriptPath)) fail("no_transcript", agentId); // ③ 文件缺失
    const { messages, lastReason, skippedMalformed } = await options.resumeTranscript(transcriptPath);
    if (messages.length === 0) fail("empty_transcript", agentId); // ③ 零历史=不攒造种子
    const seed: WorkerResumeSeed = { agentId, memberName: route.member.name, taskId, transcriptPath, messages, skippedMalformed };
    if (lastReason !== undefined) seed.lastReason = lastReason;
    return seed;
  }

  return {
    roster,
    seed: buildSeed,
    async continueWorker(input): Promise<WorkerContinueResult> {
      let seed: WorkerResumeSeed;
      try {
        seed = await buildSeed(input.agentId);
      } catch (e) {
        const err = e instanceof WorkerResumeError ? e : null;
        const stage: WorkerResumeStage = err?.stage ?? "unknown_target";
        return { ok: false, stage, failure: WORKER_RESUME_FAILURE_MAP[stage], reason: err?.message ?? String(e) };
      }
      const result = await sendMessage(
        { to: input.agentId, message: input.message, ...(input.summary !== undefined ? { summary: input.summary } : {}) },
        { port, ...(options.selfName !== undefined ? { selfName: options.selfName } : {}) },
      );
      if (!result.ok) return { ok: false, stage: "delivery", failure: result.failure, reason: result.reason };
      return { ok: true, receipt: result.receipt, seed };
    },
  };
}

/** 恢复后的寻址提示（A 级 §9 L179075 同形落款）。 */
export function workerResumeNote(seed: WorkerResumeSeed): string {
  return `agentId: ${seed.agentId} (internal ID - do not mention to user. Resumed ${seed.messages.length} message(s) from its transcript; use SendMessage with to: '${seed.agentId}', summary: '<5-10 word recap>' to continue this agent.)`;
}
