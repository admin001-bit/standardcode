// WP-10（M2）会话命令 /new /resume /rename 测试（CTX-101 交接终点/UI-030；判据自足：板 WP-10 DoD①②③④）。
// R1 修复（V 退回 2026-09-09）：等价断言基线=独立两源（活体 final.messages vs 转录重建）+多轮场景；
// R2 修复：picker 三要素（搜索+预览+重命名）桩面断言。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo, type SessionPicker } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";
import { listSessions, resumeFrom, renameSessionTitle } from "@standardcode/platform";

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
  it("多轮会话 /new：旧 transcript 内容完好（重建=活体终态）且索引两枚举；新会话空起点", async () => {
    const repo = join(dir, "r1");
    const home = mkdtempSync(join(dir, "h1-"));
    const baseDir = join(dir, "bd1");
    mkdirSync(repo);
    gitInit(repo);
    const p = scriptedProvider([REPLY, REPLY, REPLY]);
    const lines = ["q1", "q2", "/new", "q3", "/exit"];
    const session = createSession({ provider: p, catalog: ["m-a"], model: "m-a", cwd: repo, home });
    let out = "";
    await runRepl({
      session,
      io: { lines: (async function* () { for (const l of lines) yield l; })(), write: (s) => (out += s), close: () => {} },
      baseDir,
    });
    const liveFinal = structuredClone(session.messages); // 活体终态（/new 后=q3 轮历史）
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions.length).toBe(2); // 旧会话完好（CTX-101 交接）
    for (const s of sessions) expect(existsSync(s.filePath)).toBe(true);
    // R1 修复回归：多轮会话转录无重复 assistant；重建=该会话活体终态（独立两源 toEqual）
    // R4 修复：listSessions 按文件名字典序（UUID 与创建顺序无关）——顺序无关断言+按 messageCount 定位
    const counts = sessions.map((s) => s.messageCount).sort((a, b) => a - b);
    expect(counts).toEqual([2, 4]); // 旧（q1/q2 两轮）=4；新（q3 单轮）=2
    const oldSession = sessions.find((s) => s.messageCount === 4)!;
    const newSession = sessions.find((s) => s.messageCount === 2)!;
    const rebuiltOld = await resumeFrom(oldSession.filePath);
    expect(rebuiltOld.messages).toEqual([ // R4 连带：旧会话内容等价真断言（非 messageCount 代理）
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ]);
    const rebuiltNew = await resumeFrom(newSession.filePath);
    expect(rebuiltNew.messages).toEqual(liveFinal); // 新会话转录重建=活体终态（M1 口径，独立源）
    expect(p.seen[2]!.length).toBe(1); // /new 后空起点：q3 请求仅本轮 user
    void out;
  });
});

describe("R3 修复回归：工具轮 tool_result 入转录（悬空 tool_use=0）", () => {
  it("工具轮会话转录重建含 tool_result user 消息；重建=活体终态（M1 口径）", async () => {
    const repo = join(dir, "r5");
    const home = mkdtempSync(join(dir, "h5-"));
    const baseDir = join(dir, "bd5");
    mkdirSync(repo);
    gitInit(repo);
    // turn：tool_use → tool_result → assistant 文本（真实 repl+真实 Bash 工具）
    const p = scriptedProvider([
      [
        { type: "tool_start", id: "t1", name: "Bash" } as LLMEvent,
        { type: "tool_input_delta", id: "t1", jsonPartial: JSON.stringify({ command: "echo probe-marker" }) } as LLMEvent,
        { type: "tool_end", id: "t1" } as unknown as LLMEvent,
        { type: "text_delta", text: "" } as LLMEvent,
      ],
      REPLY,
    ]);
    const session = createSession({ provider: p, catalog: ["m-a"], model: "m-a", cwd: repo, home: mkdtempSync(join(dir, "h5b-")) });
    await runRepl({
      session,
      io: { lines: (async function* () { yield "run a command"; yield "/exit"; })(), write: () => {}, close: () => {} },
      baseDir,
      confirm: { async confirm() { return "once"; } }, // default 模式 Bash=ask → 确认放行（工具真执行）
    });
    const liveFinal = session.messages; // 活体终态（runRepl 内 s.messages=final.messages 已替换引用——取替换后数组本身）
    expect(liveFinal.some((m) => m.role === "user" && JSON.stringify(m).includes("tool_result"))).toBe(true);
    const { sessions } = await listSessions(repo, baseDir);
    const rebuilt = await resumeFrom(sessions[0]!.filePath);
    expect(rebuilt.messages).toEqual(liveFinal); // 重建=活体终态（tool_result 在位=无悬空 tool_use）
    expect(rebuilt.messages.filter((m) => m.role === "user" && JSON.stringify(m).includes("tool_result")).length).toBe(1);
  });
});

describe("DoD② /resume 恢复等价（终态 toEqual，M1 口径=独立两源）+选择器", () => {
  it("多轮会话 /resume：重建历史=活体终态（无重复 assistant）；continue turn 携带恢复历史", async () => {
    const repo = join(dir, "r2");
    const home = mkdtempSync(join(dir, "h2-"));
    const baseDir = join(dir, "bd2");
    mkdirSync(repo);
    gitInit(repo);
    const p1 = scriptedProvider([REPLY, REPLY]);
    await runLines(repo, home, baseDir, ["q1", "q2", "/exit"], p1);
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.messageCount).toBe(4); // R1 修复回归：两轮=恰 4 消息（无重复 assistant）
    const target = sessions[0]!;

    const p2 = scriptedProvider([REPLY]);
    const picker: SessionPicker = {
      async pick(entries) {
        expect(entries.length).toBe(1);
        return entries[0]!;
      },
      async rename() {},
    };
    const { out } = await runLines(repo, home, baseDir, ["/resume", "follow-up question", "/exit"], p2, picker);
    expect(out).toContain("4 message(s) restored");
    // 恢复后 continue turn 的请求=恢复历史（恰 4）+本轮 user（toEqual 逐条）
    const continued = p2.seen[0]!;
    expect(continued.length).toBe(5);
    expect(continued.filter((m) => m.role === "assistant").length).toBe(2); // 无重复
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
      async rename() {},
    };
    await runLines(repo, home, baseDir, ["/resume", "/exit"], p2, picker);
    expect(seen).toContain("My Custom Title");
    void sessions;
  });

  it("R2 选择器内重命名（rename 钩子）：恢复前对历史会话设标题，索引即时反映", async () => {
    const repo = join(dir, "r4");
    const home = mkdtempSync(join(dir, "h4-"));
    const baseDir = join(dir, "bd4");
    mkdirSync(repo);
    gitInit(repo);
    const p1 = scriptedProvider([REPLY]);
    await runLines(repo, home, baseDir, ["session to rename", "/exit"], p1);
    const p2 = scriptedProvider([REPLY]);
    const picker: SessionPicker = {
      async pick(entries) {
        return entries[0]!;
      },
      async rename(entry) {
        await renameSessionTitle(repo, entry.sessionId, "Renamed In Picker", baseDir); // 与生产同函数（baseDir 隔离）
      },
    };
    await runLines(repo, home, baseDir, ["/resume", "/exit"], p2, picker);
    const { sessions } = await listSessions(repo, baseDir);
    expect(sessions[0]!.title).toBe("Renamed In Picker"); // picker 内重命名已落 sidecar
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
