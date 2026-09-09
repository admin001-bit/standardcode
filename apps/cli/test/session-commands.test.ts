// WP-10（M2）会话命令 /new /resume /rename 测试（CTX-101 交接终点/UI-030；判据自足：板 WP-10 DoD①②③④）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo, type SessionPicker } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";
import { listSessions, resumeFrom } from "@standardcode/platform";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-wp10-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
}

/** 可编排多轮 provider：每 turn 消费一个 LLMEvent[][]；记录收到的请求历史。 */
function scriptedProvider(turns: LLMEvent[][]): ProviderAdapter & { seen: import("@standardcode/providers").LLMMessage[][] } {
  let i = 0;
  const seen: import("@standardcode/providers").LLMMessage[][] = [];
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

async function runLines(repo: string, home: string, baseDir: string, lines: string[], provider: ProviderAdapter, picker?: SessionPicker): Promise<{ out: string }> {
  const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir, sessionPicker: picker });
  return { out };
}

describe("DoD① /new 开新会话且旧 transcript 完好可 resume", () => {
  it("/new 前后两个 transcript 均落盘；索引两枚举；新会话消息历史为空起点", async () => {
    const repo = join(dir, "r1");
    const home = mkdtempSync(join(dir, "h1-"));
    const baseDir = join(dir, "bd1");
    mkdirSync(repo);
    gitInit(repo);
    const p = scriptedProvider([REPLY, REPLY]);
    await runLines(repo, home, baseDir, ["first question", "/new", "second question", "/exit"], p);
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions.length).toBe(2); // 旧会话完好（CTX-101 交接：旧 transcript 可 resume）
    for (const s of sessions) expect(existsSync(s.filePath)).toBe(true);
    // 第 2 turn 请求不含第 1 轮消息（新会话空起点）
    expect(p.seen[1]!.length).toBe(1); // 仅本轮 user
  });
});

describe("DoD② /resume 恢复等价（终态 toEqual，M1 口径）+选择器", () => {
  it("resume 后消息历史与被恢复会话终态一致；continue turn 携带恢复的历史", async () => {
    const repo = join(dir, "r2");
    const home = mkdtempSync(join(dir, "h2-"));
    const baseDir = join(dir, "bd2");
    mkdirSync(repo);
    gitInit(repo);
    const p1 = scriptedProvider([REPLY]);
    await runLines(repo, home, baseDir, ["original question", "/exit"], p1);
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions.length).toBe(1);
    const target = sessions[0]!;
    const finalHistory = await resumeFrom(target.filePath); // M1 口径：终态=转录重建历史（user+assistant）

    const p2 = scriptedProvider([REPLY]);
    const picker: SessionPicker = {
      async pick(entries) {
        expect(entries.length).toBe(1);
        return entries[0]!;
      },
    };
    await runLines(repo, home, baseDir, ["/resume", "follow-up question", "/exit"], p2, picker);
    // continue turn 的请求=恢复历史+本轮 user（toEqual 逐条）
    const continued = p2.seen[0]!;
    expect(continued).toEqual([...finalHistory.messages, { role: "user", content: [{ type: "text", text: "follow-up question" }] }]);
    expect(p2.seen.length).toBe(1);
  });

  it("resume 后 /rename 改标题并即时反映在索引", async () => {
    const repo = join(dir, "r3");
    const home = mkdtempSync(join(dir, "h3-"));
    const baseDir = join(dir, "bd3");
    mkdirSync(repo);
    gitInit(repo);
    const p1 = scriptedProvider([REPLY]);
    await runLines(repo, home, baseDir, ["question for title", "/rename My Custom Title", "/exit"], p1);
    let { sessions } = await listSessions(repo, baseDir);
    expect(sessions[0]!.title).toBe("My Custom Title"); // sidecar 优先
    expect(sessions[0]!.title).not.toContain("question for title");
    // /resume 列表即时反映（picker 收到的 entries 即列表）
    let seen: string[] = [];
    const p2 = scriptedProvider([REPLY]);
    const picker: SessionPicker = {
      async pick(entries) {
        seen = entries.map((e) => e.title);
        return null; // 取消
      },
    };
    await runLines(repo, home, baseDir, ["/resume", "/exit"], p2, picker);
    expect(seen).toContain("My Custom Title");
    void sessions;
  });
});

describe("DoD③ /rename 更新索引且 /resume 列表即时反映（见上例）+DoD④ Tab 补全（UI-001）", () => {
  it("三命令注册且 Tab 补全可命中", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("new");
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("resume");
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("rename");
    const c = completeInput("/re", CLI_COMMANDS);
    expect(c.candidates).toEqual(["/rewind", "/resume", "/rename"]);
    const r = completeInput("/rename ", CLI_COMMANDS);
    expect(r.insert).toBeNull(); // 参数位不改写行
    expect(r.hint).toContain("<title>");
  });
});

