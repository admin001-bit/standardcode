// M6-WP-09（Teams × 共享任务系统）停止 worker 续聊恢复单测：DoD③ + fail-closed 五缺口服具 + 接缝⑲。
// 判据自足（`_440.js` L208382「a send resumes it from its transcript」真实行位、L37916、L37966、L179075）。
//
// **判别力纪律**（规避"0 红针"）：实现面每处缺省回落，本文件必给**非缺省形**用例——
//   `transcriptExists` 缺省 `existsSync` vs 显式注入 false/true（缺文件 branch 唯有注入可证，Windows 无稳定 ENOENT 触发路径）；
//   `resumeTranscript` 缺省无**（必须注入）** vs 注入不同返回值（复用/非复制的判据）；
//   `warn` 缺省 stderr vs 注入收集器（每次 fail-closed 都要能证"告警上浮"而非静默）；
//   `selfName` 缺省 vs 显式给值（self-target 预检 branch）；
//   终态形：completed（缺省形） vs failed（非缺省形）。

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskRegistry } from "@standardcode/harness";
import type { LLMMessage } from "@standardcode/providers";
import {
  createWorkerResume,
  WORKER_RESUME_FAILURE_MAP,
  WORKER_RESUME_STAGES,
  WorkerResumeError,
  workerResumeFailureText,
  workerResumeNote,
  type WorkerResumeTranscript,
} from "../src/teams/worker-resume.ts";
import { createRosterSendMessagePort, createTeamRoster, teammateInboxPath, appendMailbox } from "../src/teams/index.ts";
import { sendMessage } from "../src/teams/send-message.ts";

const MSG_A: LLMMessage = { role: "user", content: [{ type: "text", text: "first question" }] };
const MSG_B: LLMMessage = { role: "assistant", content: [{ type: "text", text: "first answer" }] };
const RESULT = { content: "c", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" };

interface Fixture {
  warnings: string[];
  registry: ReturnType<typeof createTaskRegistry>;
  roster: ReturnType<typeof createTeamRoster>;
  teamsRoot: string;
  /** 注入式转录内容：agentId → 记录（缺省=文件在位、消息 [MSG_A, MSG_B]）。 */
  resumeFor(agentId: string, opts?: { exists?: boolean; messages?: LLMMessage[]; lastReason?: string }): void;
  build(): ReturnType<typeof createWorkerResume>;
  agentIdOf(member: string): string;
}

function fx(): Fixture {
  const warnings: string[] = [];
  const registry = createTaskRegistry({ evictAfterMs: 0 });
  const roster = createTeamRoster({ teamName: "default" });
  const worker = roster.addMember("alice", { agentId: "a000000000001-0001" });
  roster.addMember("bob", { agentId: "a000000000002-0002" });
  const teamsRoot = path.join(mkdtempSync(path.join(tmpdir(), "wp09-resume-")), "teams");
  const store = new Map<string, { exists: boolean; messages: LLMMessage[]; lastReason?: string }>();
  const seen: string[] = [];

  const fixture: Fixture = {
    warnings,
    registry,
    roster,
    teamsRoot,
    resumeFor: (agentId, opts) => {
      store.set(agentId, { exists: opts?.exists ?? true, messages: opts?.messages ?? [MSG_A, MSG_B], ...(opts?.lastReason !== undefined ? { lastReason: opts.lastReason } : {}) });
    },
    agentIdOf: () => worker.agentId,
    build: () =>
      createWorkerResume({
        roster,
        registry,
        port: createRosterSendMessagePort({
          roster,
          from: "alice",
          deliverToMain: () => {},
          deliverToMember: (d) => {
            appendMailbox(teammateInboxPath(teamsRoot, roster.teamName, d.member.name), d.entry);
          },
        }),
        selfName: "alice",
        transcriptPathFor: (agentId) => `/nope/${agentId}.jsonl`,
        transcriptExists: (filePath) => store.get(path.basename(filePath, ".jsonl"))?.exists ?? true,
        resumeTranscript: async (filePath) => {
          seen.push(filePath);
          const key = path.basename(filePath, ".jsonl");
          const hit = store.get(key);
          if (!hit) return { messages: [], skippedMalformed: 0 };
          return { messages: hit.messages, skippedMalformed: 0, ...(hit.lastReason !== undefined ? { lastReason: hit.lastReason } : {}) };
        },
        warn: (m) => warnings.push(m),
      }),
  };
  void seen;
  return fixture;
}

/** 默认注入形：登记任务（running）→ 终态 → 转录在位。 */
function stoppedWorker(f: Fixture, agentId: string, how: "complete" | "fail" = "complete"): string {
  const t = f.registry.register({ agentId, agentType: "general-purpose", description: "worker task", isBackgrounded: true });
  if (how === "complete") f.registry.complete(t.taskId, RESULT);
  else f.registry.fail(t.taskId, "stopped by TaskStop");
  f.resumeFor(agentId);
  return t.taskId;
}

describe("DoD③ 停止的 worker 按 agentId 续聊并从转录恢复", () => {
  it("completed 态 worker：seed 返回重建的消息历史（路径解析成立）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    const taskId = stoppedWorker(f, agentId, "complete");
    const worker = f.build();
    const seed = await worker.seed(agentId);
    expect(seed).toMatchObject({ agentId, taskId, memberName: "alice", skippedMalformed: 0 });
    expect(seed.messages).toEqual([MSG_A, MSG_B]);
    expect(seed.transcriptPath).toBe(`/nope/${agentId}.jsonl`); // transcriptPathFor 注入面被真调用
  });

  it("failed 态 worker（非缺省终态形）同样可恢复——L37966「Stopped workers can be continued」", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId, "fail");
    const worker = f.build();
    expect((await worker.seed(agentId)).messages).toEqual([MSG_A, MSG_B]);
  });

  it("恢复读取的是**注入实现**（换返回值则种子随之变）—— 证明未复制 platform 实现", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    const alt: LLMMessage = { role: "user", content: [{ type: "text", text: "totally different" }] };
    f.resumeFor(agentId, { messages: [alt], lastReason: "aborted" });
    const seed = await f.build().seed(agentId);
    expect(seed.messages).toEqual([alt]);
    expect(seed.lastReason).toBe("aborted");
  });

  it("SendMessage 到已停止 worker 的 agentId：走续聊通路，**不是 not_reachable**（L208382 反向上的 same id）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    const worker = f.build();
    const res = await worker.continueWorker({ agentId, message: "continue where you stopped", summary: "resume the refactor" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toBe(`delivered to ${agentId}`); // 无截断附加 suffix
    expect(res.seed.messages).toEqual([MSG_A, MSG_B]);
    // 投递真的落到该成员的 inbox（per-member 投递 face the member name, not agentId → alice）
    const inbox = teammateInboxPath(f.teamsRoot, f.roster.teamName, "alice");
    expect(existsSync(inbox)).toBe(true);
    expect(readFileSync(inbox, "utf8")).toContain("continue where you stopped");
  });

  it("直接 SendMessage（不经 transcript）同样可达该 agentId：addressable 不因 worker 停止而失效", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    const port = createRosterSendMessagePort({ roster: f.roster, from: "alice", deliverToMain: () => {}, deliverToMember: () => {} });
    const res = await sendMessage({ to: agentId, message: "ping" }, { port });
    expect(res.ok).toBe(true); // ← 关键：不是 not_reachable
    if (!res.ok) return;
    expect(res.receipt).toBe(`delivered to ${agentId}`);
  });

  it("workerResumeNote：L179075 同形落款，含 message 条数", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    const seed = await f.build().seed(agentId);
    const note = workerResumeNote(seed);
    expect(note).toContain(agentId);
    expect(note).toContain("internal ID - do not mention to user.");
    expect(note).toContain("Resumed 2 message(s) from its transcript");
  });
});

describe("fail-closed 五缺口服具（禁静默成功；每绽走告警+阶段双通道）", () => {
  it("① 不可寻址 agentId → stage unknown_target / failure not_reachable + 告警上浮", async () => {
    const f = fx();
    const worker = f.build();
    const res = await worker.continueWorker({ agentId: "a999999999999-9999", message: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("unknown_target");
    expect(res.failure).toBe("not_reachable");
    expect(res.reason).toContain("a999999999999-9999");
    expect(f.warnings.some((w) => w.includes("a999999999999-9999"))).toBe(true); // 禁静默
  });

  it('② "main" 不是 worker（resolve 命中 main 而非 member）→ unknown_target', async () => {
    const f = fx();
    const res = await f.build().continueWorker({ agentId: "main", message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe("unknown_target");
  });

  it("③ 无任务记录 → no_task（用**已注册但从未跑过**的成员 bob：先过 roster 寻址闸，再落任务闸）", async () => {
    const f = fx();
    const bobId = "a000000000002-0002"; // roster 成员，但从未 register 过任务
    expect(f.roster.resolve(bobId).kind).toBe("member"); // 前置：可寻址（否则会先命中 unknown_target）
    f.resumeFor(bobId);
    const res = await f.build().continueWorker({ agentId: bobId, message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("no_task");
      expect(res.failure).toBe("not_reachable");
      expect(res.reason).toContain(bobId);
    }
    expect(f.warnings.some((w) => w.includes("nothing to resume"))).toBe(true);
  });

  it("③b 未注册地址（连 roster 都不是成员）命中 unknown_target 而非 no_task——两类分支互不遮蔽", async () => {
    const f = fx();
    const res = await f.build().continueWorker({ agentId: "a999999999999-9999", message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe("unknown_target");
  });

  it("④ 任务仍在 running（未停止）→ still_running / invalid_target（拒绝，不偷偷开始新跑）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    f.registry.register({ agentId, agentType: "general-purpose", description: "d", isBackgrounded: true });
    f.resumeFor(agentId);
    const res = await f.build().continueWorker({ agentId, message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("still_running");
      expect(res.failure).toBe("invalid_target");
      expect(res.reason).toContain("still running");
    }
    expect(f.warnings.some((w) => w.includes("still running"))).toBe(true);
  });

  it("⑤ 转录文件缺失 → no_transcript（**注入 transcriptExists=false**，Windows 无稳定 ENOENT 面故必须注入）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    f.resumeFor(agentId, { exists: false }); // ← 非缺省形：明确"文件不在位"
    const res = await f.build().continueWorker({ agentId, message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("no_transcript");
      expect(res.failure).toBe("not_reachable");
    }
    expect(f.warnings.some((w) => w.includes("transcript file absent"))).toBe(true);
  });

  it("⑥ 重建后零消息 → empty_transcript（拒绝攒造种子）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    f.resumeFor(agentId, { messages: [] });
    const res = await f.build().continueWorker({ agentId, message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("empty_transcript");
      expect(res.reason).toContain("refusing to fabricate a seed");
    }
  });

  it("⑦ 投递失败（传输层 peer-gone）→ stage delivery 且归因为 stale_socket（复用 WP-06 五类，不新增失败名）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    const worker = createWorkerResume({
      roster: f.roster,
      registry: f.registry,
      port: { async send() { return "peer-gone"; } },
      transcriptPathFor: (id) => `/t/${id}.jsonl`,
      transcriptExists: () => true,
      resumeTranscript: async (): Promise<WorkerResumeTranscript> => ({ messages: [MSG_A], skippedMalformed: 0 }),
      warn: (m) => f.warnings.push(m),
    });
    const res = await worker.continueWorker({ agentId, message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stage).toBe("delivery");
      expect(res.failure).toBe("stale_socket");
    }
  });

  it("抛错面同步 `seed()`：拒绝携 stage 的 WorkerResumeError（调用方可按 stage 精确处理）", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    stoppedWorker(f, agentId);
    f.resumeFor(agentId, { messages: [] });
    await expect(f.build().seed(agentId)).rejects.toBeInstanceOf(WorkerResumeError);
    try {
      await f.build().seed(agentId);
    } catch (e) {
      expect((e as WorkerResumeError).stage).toBe("empty_transcript");
    }
  });

  it("阶段全集与失败映射守恒（新增阶段必须同步登记映射，否则本例红）", () => {
    expect(WORKER_RESUME_STAGES).toEqual(["unknown_target", "no_task", "still_running", "no_transcript", "empty_transcript", "delivery"]);
    for (const s of WORKER_RESUME_STAGES) expect(WORKER_RESUME_FAILURE_MAP[s]).toBeTruthy();
    expect(workerResumeFailureText("delivery", "a1")).toContain("a1");
  });
});

describe("接缝⑲：续聊不改任务状态（状态由任务工具负责，消息只负责承载）", () => {
  it("continueWorker 成功后：任务 status/owner/blockedBy 一字不变", async () => {
    const f = fx();
    const agentId = f.agentIdOf("alice");
    const dep = f.registry.register({ agentId: "dep", agentType: "g", description: "dep", isBackgrounded: true });
    const t = stoppedWorker(f, agentId);
    f.registry.setOwner(t, "bob");
    f.registry.setBlockedBy(t, [dep.taskId]);
    const before = JSON.stringify(f.registry.get(t));
    const res = await f.build().continueWorker({ agentId, message: "keep going" });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(f.registry.get(t))).toBe(before); // 消息面零写入
  });
});
