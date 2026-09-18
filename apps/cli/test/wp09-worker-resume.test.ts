// M6-WP-09 worker 续聊恢复 —— **真实 platform 转录面**端到端 + session 装配接线 + flag 关态零构造。
// 判据：`resumeFrom`/`rebuildMessages` 必须是 platform 真身被复用（卡 §6.5「禁止复制实现」）；
//        teams flag 关态=workerResume 零构造（DoD⑤ 同口径）。
// 与 `packages/capabilities/test/wp09-worker-resume.test.ts` 的分工：那边注入替身证分支，这边接真实现证复用。

import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";
import { TranscriptWriter, teamsDir, transcriptsDir } from "@standardcode/platform";
import type { LLMMessage, ProviderAdapter } from "@standardcode/providers";

const AGENT_ID = "a000000000001-0001";
const MSG_A: LLMMessage = { role: "user", content: [{ type: "text", text: "pull the latest" }] };
const MSG_B: LLMMessage = { role: "assistant", content: [{ type: "text", text: "done, all green" }] };
const MSG_C: LLMMessage = { role: "user", content: [{ type: "text", text: "now fix the flake" }] };

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in WP-09 worker resume tests");
    },
    countTokens: async () => 0,
  };
}

const GATE_TEAMS_ON = { enabled: true, flags: ["teams"] as const, notices: [] };

function home(): string {
  return path.join(tmpdir(), `wp09-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** 会话 + 已注册成员 + 一个"已停止"的 worker 任务（终态=failed）。 */
async function wired(homeDir: string, how: "complete" | "fail" = "fail") {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home: homeDir, cwd: homeDir, experimental: GATE_TEAMS_ON });
  session.teamRoster!.addMember("alice", { agentId: AGENT_ID });
  const t = session.taskRegistry.register({ agentId: AGENT_ID, agentType: "general-purpose", description: "worker task", isBackgrounded: true });
  if (how === "fail") session.taskRegistry.fail(t.taskId, "stopped by TaskStop");
  else session.taskRegistry.complete(t.taskId, { content: "c", totalTokens: 1, totalToolUseCount: 0, totalDurationMs: 1, doneReason: "end" });
  // worker 转录表命名=`<transcriptsDir>/<agentId>.jsonl`（[自定]②）：与 session 装配的 transcriptPathFor 同款多样
  const writer = await TranscriptWriter.create(homeDir, AGENT_ID, path.join(homeDir, ".standardcode"));
  await writer.append({ kind: "user_message", message: MSG_A });
  await writer.append({ kind: "assistant_message", message: MSG_B });
  return { session, taskId: t.taskId, writer };
}

describe("DoD③ 真实 platform `resumeFrom` 复用（非复制）", () => {
  it("session.workerResume.seed：从真 JSONL 重建出教会消息历史（与写入逐条一致）", async () => {
    const h = home();
    const { session, taskId } = await wired(h);
    const seed = await session.workerResume!.seed(AGENT_ID);
    expect(seed.taskId).toBe(taskId);
    expect(seed.memberName).toBe("alice");
    expect(seed.messages).toEqual([MSG_A, MSG_B]);
    expect(seed.transcriptPath.endsWith(`${AGENT_ID}.jsonl`)).toBe(true);
    expect(existsSync(seed.transcriptPath)).toBe(true); // 真文件（不替身）
  });

  it("复用判据：compact 截断语义由 platform `rebuildMessages` 产出（摘要锚点 + keptCount 尾部）", async () => {
    const h = home();
    const { session } = await wired(h);
    const w = await TranscriptWriter.create(h, AGENT_ID, path.join(h, ".standardcode")); // 同文件续写
    await w.append({ kind: "user_message", message: MSG_C });
    await w.append({ kind: "compact", summary: "SUMMARY-9SEG", keptCount: 1, mode: "auto", preTokens: 100, postTokens: 20 });
    const seed = await session.workerResume!.seed(AGENT_ID);
    // rebuildMessages 的语义（platform 既有实现，非本卡重造）：保留尾部 keptCount 条，**再**落摘要消息收尾
    expect(seed.messages).toHaveLength(2); // [MSG_C, 摘要] —— 此形态只有 platform 实现能给
    expect(seed.messages.at(0)).toEqual(MSG_C);
    expect(seed.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "SUMMARY-9SEG" }] });
  });

  it("complete 态（非 failed）同样可恢复（终态形的另一种）", async () => {
    const h = home();
    const { session } = await wired(h, "complete");
    expect((await session.workerResume!.seed(AGENT_ID)).messages).toEqual([MSG_A, MSG_B]);
  });
});

describe("session 装配接线 + flag 关态零构造", () => {
  it("teams flag 活跃 → workerResume 在位且入驻 roster/registry/port 三件套", async () => {
    const h = home();
    const { session } = await wired(h);
    expect(session.workerResume).toBeDefined();
    expect(session.workerResume!.roster.teamName).toBe("default");
    expect(session.teamRoster!.addressable()).toContain(AGENT_ID);
  });

  it("flag 缺席（默认关）→ workerResume 零构造（teams 面整体不在位），DoD⑤ 同口径", () => {
    const h = home();
    const off = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home: h, cwd: h });
    expect(off.workerResume).toBeUndefined();
    expect(off.teamRoster).toBeUndefined();
    expect(existsSync(path.join(h, ".standardcode", "projects"))).toBe(false); // 零触盘
  });

  it("continueWorker 走装配面：投递落 member inbox，且任务字段不变", async () => {
    const h = home();
    const { session, taskId } = await wired(h);
    const before = JSON.stringify(session.taskRegistry.get(taskId));
    const res = await session.workerResume!.continueWorker({ agentId: AGENT_ID, message: "carry on", summary: "resume the flake hunt" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt).toBe(`delivered to ${AGENT_ID}`);
    const inbox = path.join(teamsDir(h, path.join(h, ".standardcode")), "default", "alice.inbox.json");
    expect(existsSync(inbox)).toBe(true);
    expect(readFileSync(inbox, "utf8")).toContain("carry on");
    expect(JSON.stringify(session.taskRegistry.get(taskId))).toBe(before); // 接缝⑲：消息不改状态
  });
});
