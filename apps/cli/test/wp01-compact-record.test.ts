// WP-01（M3）压缩回缩缺口清偿测试（ADR-0038；判据自足：板 WP-01 DoD②③）。
// 缺口本体（M2 偏差⑤）：压缩只换内存、transcript 无 compact 记录 → /resume 重建=压缩前全史 ≠ 活体终态。
// 修复后：压缩两通道（手动/自动）落 compact 记录，重建截断语义=压缩后活体终态（M1 恢复等价 toEqual 口径）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, ProviderAdapter } from "@standardcode/providers";
import { listSessions, resumeFrom } from "@standardcode/platform";
import { createSession } from "../src/session.ts";
import { runRepl } from "../src/repl.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-wp01-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
}

function scriptedProvider(turns: LLMEvent[][]): ProviderAdapter & { seen: LLMMessage[][] } {
  let i = 0;
  const seen: LLMMessage[][] = [];
  return {
    seen,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req) {
      seen.push(structuredClone(req.messages));
      for (const ev of turns[Math.min(i, turns.length - 1)]) yield ev;
      i++;
    },
  };
}

const REPLY: LLMEvent[] = [
  { type: "text_delta", text: "reply" } as LLMEvent,
  { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent,
];

async function runLines(repo: string, home: string, baseDir: string, lines: string[], session?: ReturnType<typeof createSession>): Promise<{ out: string; session: ReturnType<typeof createSession> }> {
  const provider = scriptedProvider([REPLY, REPLY, REPLY, REPLY, REPLY]);
  const s = session ?? createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
  let out = "";
  await runRepl({
    session: s,
    io: { lines: (async function* () { for (const l of lines) yield l; })(), write: (t) => (out += t), close: () => {} },
    baseDir,
  });
  return { out, session: s };
}

describe("WP-01 DoD② 压缩路径落 compact 记录（ADR-0038）", () => {
  it("两轮会话 /compact → transcript 含 kind=compact（mode=manual/preTokens/postTokens/summary）", async () => {
    const repo = join(dir, "manual");
    const home = mkdtempSync(join(dir, "hm-"));
    const baseDir = join(dir, "bdm");
    mkdirSync(repo);
    gitInit(repo);
    const { out, session } = await runLines(repo, home, baseDir, ["q1", "q2", "/compact", "/exit"]);
    expect(out).toContain("[compact]");
    // 活体：压缩后=摘要替换历史
    expect(session.messages).toHaveLength(1);
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions.length).toBe(1);
    const { records } = await (await import("@standardcode/platform")).readTranscript(sessions[0].filePath);
    const compacts = records.filter((r) => r.kind === "compact");
    expect(compacts).toHaveLength(1);
    expect(compacts[0]).toMatchObject({ mode: "manual", preTokens: expect.any(Number), postTokens: expect.any(Number) });
    expect((compacts[0].summary ?? "").length).toBeGreaterThan(0);
  }, 30_000);

  it("DoD④ 旧转录兼容：无 compact 记录的转录 resume 行为不变（重建=全史）", async () => {
    const repo = join(dir, "legacy");
    const home = mkdtempSync(join(dir, "hl-"));
    const baseDir = join(dir, "bdl");
    mkdirSync(repo);
    gitInit(repo);
    // 两轮纯文本（无压缩）→ transcript 只有 user/assistant/done
    const { session } = await runLines(repo, home, baseDir, ["q1", "q2", "/exit"]);
    const { sessions } = await listSessions(repo, baseDir);
    const resumed = await resumeFrom(sessions[0].filePath);
    expect(resumed.messages).toEqual(session.messages); // 旧形为：重建=全史（M1 口径不回归）
    expect(resumed.skippedMalformed).toBe(0);
  }, 30_000);
});

describe("WP-01 DoD③ 含压缩会话 resume 重建=活体终态（M1 toEqual 口径——缺口修复核心证据）", () => {
  it("压缩后继续一轮再退出 → resumeFrom 重建与活体 messages toEqual（修复前：重建=压缩前全史≠活体）", async () => {
    const repo = join(dir, "equiv");
    const home = mkdtempSync(join(dir, "he-"));
    const baseDir = join(dir, "bde");
    mkdirSync(repo);
    gitInit(repo);
    const { session } = await runLines(repo, home, baseDir, ["q1", "q2", "/compact", "q3", "/exit"]);
    // 活体终态：[summary user, q3 user, reply assistant]
    expect(session.messages).toHaveLength(3);
    const { sessions } = await listSessions(repo, baseDir);
    const resumed = await resumeFrom(sessions[0].filePath);
    expect(resumed.messages).toEqual(session.messages); // ← 修复前此断言必败（重建含压缩前全史 4 条）
    expect((resumed.messages[0].content as Array<{ text: string }>)[0].text).toContain("reply"); // 摘要锚点（scripted 摘要=reply 文本）
    expect(resumed.skippedMalformed).toBe(0);
  }, 30_000);
});
