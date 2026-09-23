// M7-WP-07（X 执行会话，2026-09-24）：四长尾 `/branch` `/batch` `/loop` `/btw` 从 EXPERIMENTAL_DEFERRED_COMMANDS
// 迁入对应 flag 映射并落地实现。判据自足（板 WP-07 DoD + BLK-11=① 口径）：
//   ① 默认关=四件零注册（注册表逐字等于 CLI_COMMANDS 仍 35）；
//   ② flag 组合面矩阵：workflow 开=+3（workflows/batch/loop→38）、fork 开=+3（fork/export/branch→38）、
//      teams 开=+0（无命令面→35）、三 flag 全开=+6（→41；btw 侧信道恒不注册）；
//   ③ 四个语义各一正例（branch 复制转录/btw 旁路单问/loop 计数制/batch 逐行执行）；
//   ④ fail-closed：/loop 用法错、/batch 缺文件/空参、/btw 空参均点名报错；
//   ⑤ EXPERIMENTAL_DEFERRED_COMMANDS === []（M7 清空推后集）；
//   ⑤b /btw 侧信道路由（REPL 真实派发：teams 开=旁路派发、teams 关=未知命令）＋拦截块判别力（provider 调用计数）
//      ＋/btw 不写转录（转录文件级断言）；
//   ⑥ 中断钩子（/loop 当轮即止）与上限边界（/loop n=10 恰接受、/batch 200 接受·201 拒绝且零执行）；
//   ⑦ /branch 转录未落盘态回归（新会话首条输入即 /branch 不得 ENOENT）。
// 计数口径（CLI_COMMANDS 守恒 35 不变）与 wp01/wp05/wp10/wp12 同形；侧信道 /btw 不进注册表（见 mini-ADR-0049）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExperimentalGate } from "@standardcode/platform";
import { transcriptsDir } from "@standardcode/platform";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import {
  EXPERIMENTAL_DEFERRED_COMMANDS,
  EXPERIMENTAL_FLAG_COMMANDS,
  experimentalCommandNames,
  gatedRegistry,
} from "../src/experimental-gate.ts";
import { createCommandContext, runRepl, type ReplDeps } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

const closed: ExperimentalGate = { enabled: false, flags: [], notices: [] };
const workflowOpen: ExperimentalGate = { enabled: true, flags: ["workflow"], notices: [] };
const forkOpen: ExperimentalGate = { enabled: true, flags: ["fork"], notices: [] };
const teamsOpen: ExperimentalGate = { enabled: true, flags: ["teams"], notices: [] };
const allOpen: ExperimentalGate = { enabled: true, flags: ["workflow", "teams", "fork"], notices: [] };

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({
      contextWindow: 1,
      maxOutputTokens: { default: 1, upper: 1 },
      thinking: "none",
      input: ["text"],
      streaming: true,
      toolCalling: true,
      cache: { ttlLevels: ["5m"], explicitBreakpoints: false },
    }),
    async *stream(_req: LLMRequest): AsyncIterable<LLMEvent> {
      for (const ev of [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

let root: string;
let projDir: string;
let baseDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp07-longtail-"));
  projDir = path.join(root, "proj");
  baseDir = path.join(root, "repl-store");
  mkdirSync(projDir, { recursive: true });
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function makeSession(): Session {
  return createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: root });
}
function ctxOf(s: Session, out?: string[]): ReturnType<typeof createCommandContext> {
  return createCommandContext({ session: s, io: { lines: (async function* () {})(), write: (x) => out?.push(x), close: () => {} }, baseDir });
}
/** 计数 provider 会话：判「旁路派发是否真的发生」（仅断言提示文案对拦截块存在性零判别力）。 */
function countingSession(): { s: Session; streams: number } {
  const box = { streams: 0 };
  const base = fakeProvider();
  const s = createSession({
    provider: {
      ...base,
      async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
        box.streams++;
        yield* base.stream(req);
      },
    },
    catalog: ["m"],
    model: "m",
    cwd: projDir,
    projectRoot: projDir,
    home: root,
  });
  return { s, get streams() { return box.streams; } };
}

describe("WP-07 ① 默认关闭=四件零注册（注册表逐字等于 CLI_COMMANDS，仍 35）", () => {
  it("关闭态：注册表名集合逐字等于 CLI_COMMANDS 且恰 35 件", () => {
    const reg = gatedRegistry(closed);
    expect(reg.map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(reg).toHaveLength(35);
  });

  it("四长尾在关闭态注册表逐一零命中（branch/batch/loop/btw 全部缺席）", () => {
    const names = gatedRegistry(closed).map((c) => c.name);
    for (const n of ["branch", "batch", "loop", "btw"]) {
      expect(names, `默认关不得注册 /${n}`).not.toContain(n);
    }
  });

  it("拒绝面全集（experimentalCommandNames）=七件（含侧信道 btw），默认关一律被滤除", () => {
    expect([...experimentalCommandNames()].sort()).toEqual(
      ["batch", "branch", "btw", "export", "fork", "loop", "workflows"].sort(),
    );
    const names = gatedRegistry(closed).map((c) => c.name);
    for (const n of experimentalCommandNames()) expect(names).not.toContain(n);
  });
});

describe("WP-07 ② flag 组合面矩阵（workflow=+3、fork=+3、teams=0、all=+6；btw 恒不注册）", () => {
  it("workflow 开=38（workflows + batch + loop）；fork 开=38（fork + export + branch）；teams 开=35（无命令面）；三 flag 全开=41", () => {
    const wf = gatedRegistry(workflowOpen);
    expect(wf).toHaveLength(38);
    const wfNames = wf.map((c) => c.name);
    expect(wfNames).toContain("workflows");
    expect(wfNames).toContain("batch");
    expect(wfNames).toContain("loop");
    expect(wfNames).not.toContain("fork");
    expect(wfNames).not.toContain("export");
    expect(wfNames).not.toContain("branch");

    const fk = gatedRegistry(forkOpen);
    expect(fk).toHaveLength(38);
    const fkNames = fk.map((c) => c.name);
    expect(fkNames).toContain("fork");
    expect(fkNames).toContain("export");
    expect(fkNames).toContain("branch");
    expect(fkNames).not.toContain("workflows");
    expect(fkNames).not.toContain("batch");
    expect(fkNames).not.toContain("loop");

    // teams 有工具面（SendMessage）但无斜杠命令面 → 注册表仍 35
    expect(gatedRegistry(teamsOpen)).toHaveLength(35);

    const all = gatedRegistry(allOpen);
    expect(all).toHaveLength(41);
    const allNames = all.map((c) => c.name);
    for (const n of ["workflows", "batch", "loop", "fork", "export", "branch"]) expect(allNames).toContain(n);
    // /btw 侧信道：任一门态（含全开）恒不注册
    for (const gate of [closed, workflowOpen, forkOpen, teamsOpen, allOpen]) {
      expect(gatedRegistry(gate).map((c) => c.name), `门态 [${gate.flags.join(",")}] 侧信道 /btw 不得注册`).not.toContain("btw");
    }
  });

  it("映射登记面一致（flag→命令名 [自定]）", () => {
    expect(EXPERIMENTAL_FLAG_COMMANDS.workflow).toEqual(["workflows", "batch", "loop"]);
    expect(EXPERIMENTAL_FLAG_COMMANDS.fork).toEqual(["fork", "export", "branch"]);
    expect(EXPERIMENTAL_FLAG_COMMANDS.teams).toEqual([]); // 无斜杠命令面；/btw 走侧信道
  });
});

describe("WP-07 ③ 四长尾语义各一正例", () => {
  it("/branch [name]：复制当前会话转录为新 session（打印新分支 id，当前会话不变）", async () => {
    const s = makeSession();
    s.messages.push({ role: "user", content: [{ type: "text", text: "prior context" }] });
    const out: string[] = [];
    const r = await ctxOf(s, out).branch("feature-x");
    expect(r.text).toMatch(/\[branch\][^\n]*session [0-9a-f-]+/); // 语言无关：[branch] 前缀 + session id
    expect(r.text).toContain("feature-x");
    // 当前会话未切换（消息仍在、未被清空）
    expect(s.messages.some((m) => m.role === "user" && Array.isArray(m.content) && (m.content[0] as { text?: string }).text === "prior context")).toBe(true);
  });

  it("/btw <question>：旁路单问，答案打印但不写转录（主消息流零增量）", async () => {
    const s = makeSession();
    const before = s.messages.length;
    const r = await ctxOf(s).btw("what is 2+2?");
    expect(r.text).toContain("[btw]");
    expect(r.text).toContain("ok"); // provider 回显
    expect(s.messages.length).toBe(before); // 不进主消息流
  });

  it("/loop <n> <prompt>：计数制连跑 n 轮（无参=状态提示；带参=逐轮执行并落转录）", async () => {
    const s = makeSession();
    // 无参=状态提示
    const status = await ctxOf(s).loop("");
    expect(status.text).toContain("[loop]");
    // 带参=3 轮
    const r = await ctxOf(s).loop("3 ping");
    expect(r.text).toContain("[loop]"); // 语言无关前缀
    expect(r.text).toContain("ping"); // 插值 prompt
    expect(r.text).toContain("3"); // 插值轮次
    const userRounds = s.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && (m.content[0] as { text?: string }).text === "ping").length;
    expect(userRounds).toBe(3);
  });

  it("/batch <file>：读文件逐非空行作 user turn 顺序执行", async () => {
    const file = path.join(root, "batch-lines.txt");
    writeFileSync(file, "line one\n\nline two\n   \nline three\n", "utf8");
    const s = makeSession();
    const r = await ctxOf(s).batch(file);
    expect(r.text).toContain("[batch]"); // 语言无关前缀
    expect(r.text).toContain(file); // 插值文件路径
    expect(r.text).toContain("3"); // 插值行数
    const batched = s.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && ["line one", "line two", "line three"].includes((m.content[0] as { text?: string }).text ?? "")).length;
    expect(batched).toBe(3);
    expect(existsSync(file)).toBe(true); // 源文件不消费
  });
});

describe("WP-07 ④ fail-closed（用法错/缺资源均点名报错，不静默）", () => {
  it("/loop 非整数或越界用法=点名报错", async () => {
    const s = makeSession();
    // 断言命中插值 {value}（语言无关）：abc / 0 x / 11 x
    await expect(ctxOf(s).loop("abc")).rejects.toThrow(/abc/);
    await expect(ctxOf(s).loop("0 x")).rejects.toThrow(/0 x/);
    await expect(ctxOf(s).loop("11 x")).rejects.toThrow(/11 x/);
  });

  it("/batch 空参=点名；缺文件=点名（不静默跑空）", async () => {
    const s = makeSession();
    await expect(ctxOf(s).batch("")).rejects.toThrow("/batch <file>");
    await expect(ctxOf(s).batch(path.join(root, "does-not-exist.txt"))).rejects.toThrow(/找不到文件|file not found/);
  });

  it("/btw 空参=点名报错（不派发空问）", async () => {
    const s = makeSession();
    await expect(ctxOf(s).btw("")).rejects.toThrow("/btw <question>");
  });
});

describe("WP-07 ⑤ 推后集已清空（M7 四件全部迁入映射/侧信道）", () => {
  it("EXPERIMENTAL_DEFERRED_COMMANDS === []", () => {
    expect(EXPERIMENTAL_DEFERRED_COMMANDS).toEqual([]);
  });

  it("读回分支转录可经 readTranscript 解析（schemaVersion 同契约，side-effect 可恢复）", async () => {
    const s = makeSession();
    s.messages.push({ role: "user", content: [{ type: "text", text: "branchable" }] });
    const r = await ctxOf(s).branch("");
    const id = r.text.match(/created branch session ([0-9a-f-]+)/)![1]!;
    const file = path.join(transcriptsDir(s.cwd, baseDir), `${id}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const recs = readFileSync(file, "utf8").trim().split("\n").filter((l) => l !== "");
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const rec = JSON.parse(recs[0]!) as { schemaVersion: number };
    expect(rec.schemaVersion).toBe(1); // SCHEMA_VERSION（当前契约值）
  });
});

describe('WP-07 ⑤b /btw 侧信道路由（REPL 真实派发路径；V-WP10 轮发现的缺口闭合）', () => {
  async function runReplCapture(lines: string[], gate: ExperimentalGate): Promise<string[]> {
    const out: string[] = [];
    const s = makeSession();
    await runRepl({
      session: s,
      commands: gatedRegistry(gate),
      io: {
        lines: (async function* () { for (const l of lines) yield l; })(),
        write: (x: string) => out.push(x),
        close: () => {},
      },
      experimentalGate: gate,
      baseDir: path.join(root, 'repl-store-' + Math.random().toString(36).slice(2)),
    });
    return out;
  }
  it('teams 开：/btw 经 REPL 旁路派发到旁路单问（答案上屏、不写转录）', async () => {
    const out = await runReplCapture(['/btw hello'], teamsOpen);
    expect(out.join('')).toContain('ok');
  });
  it('teams 关：/btw 走未知命令提示（拒绝面语义，不派发）', async () => {
    const out = await runReplCapture(['/btw hello'], workflowOpen);
    expect(out.join('')).toContain('/btw');
  });

  it('判别力：teams 关时 provider 零调用（拦截块存在性的判据——仅断言提示文案不足以判别）', async () => {
    const calls = countingSession();
    const bd = path.join(root, 'repl-store-intr-' + Math.random().toString(36).slice(2));
    const out: string[] = [];
    await runRepl({
      session: calls.s,
      commands: gatedRegistry(workflowOpen),
      io: { lines: (async function* () { yield '/btw hello'; })(), write: (x: string) => out.push(x), close: () => {} },
      experimentalGate: workflowOpen,
      baseDir: bd,
    });
    expect(out.join('')).toContain('/btw');
    expect(calls.streams, 'teams 未开：/btw 不得旁路派发到 provider').toBe(0);
  });

  it('判别力：teams 开时 provider 恰一次调用（旁路派发真的发生）', async () => {
    const calls = countingSession();
    const bd = path.join(root, 'repl-store-intr2-' + Math.random().toString(36).slice(2));
    await runRepl({
      session: calls.s,
      commands: gatedRegistry(teamsOpen),
      io: { lines: (async function* () { yield '/btw hello'; })(), write: () => {}, close: () => {} },
      experimentalGate: teamsOpen,
      baseDir: bd,
    });
    expect(calls.streams).toBe(1);
  });

  it('/btw 不写转录（转录文件级断言：会话目录下零 .jsonl）', async () => {
    const bd = path.join(root, 'repl-store-btw-' + Math.random().toString(36).slice(2));
    const s = makeSession();
    await runRepl({
      session: s,
      commands: gatedRegistry(teamsOpen),
      io: { lines: (async function* () { yield '/btw hello'; })(), write: () => {}, close: () => {} },
      experimentalGate: teamsOpen,
      baseDir: bd,
    });
    const dir = transcriptsDir(s.cwd, bd);
    const jsonl = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    expect(jsonl, '/btw 旁路单问不得写转录').toEqual([]);
  });
});

describe('WP-07 ⑥ 中断钩子与上限边界（V-WP07 判别力缺口补用例）', () => {
  it('/loop 中断钩子：deps.isInterrupted 置起后当轮即止（3 轮请求→实际 1 轮）', async () => {
    const s = makeSession();
    let i = 0;
    const ctx = createCommandContext({
      session: s,
      io: { lines: (async function* () {})(), write: () => {}, close: () => {} },
      baseDir,
      isInterrupted: () => ++i > 1, // 首轮通过后置起
    });
    const r = await ctx.loop('3 ping');
    expect(r.text).toContain('[loop]');
    const userRounds = s.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && (m.content[0] as { text?: string }).text === 'ping').length;
    expect(userRounds, '中断后置起轮不再执行').toBe(1);
  });

  it('/loop 上限边界：n=10 恰接受（上限内）', async () => {
    const s = makeSession();
    const r = await ctxOf(s).loop('10 ping');
    expect(r.text).toContain('10');
  });

  it('/batch 上限边界：200 行恰接受、201 行点名拒绝且零执行', async () => {
    const ok = path.join(root, 'batch-200.txt');
    writeFileSync(ok, Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n') + '\n', 'utf8');
    const s1 = makeSession();
    const r = await ctxOf(s1).batch(ok);
    expect(r.text).toContain('200');

    const tooMany = path.join(root, 'batch-201.txt');
    writeFileSync(tooMany, Array.from({ length: 201 }, (_, i) => `l${i}`).join('\n') + '\n', 'utf8');
    const s2 = makeSession();
    await expect(ctxOf(s2).batch(tooMany)).rejects.toThrow(/201/);
    expect(s2.messages.length, '超限不执行任何一行').toBe(0);
  });
});

describe('WP-07 ⑦ /branch 转录未落盘态（真缺陷回归：新会话首条输入即 /branch）', () => {
  it('转录文件尚未创建时不报 ENOENT，落内存重建路径并打印新分支 id', async () => {
    const bd = path.join(root, 'repl-store-branch-' + Math.random().toString(36).slice(2));
    const s = makeSession();
    const out: string[] = [];
    await runRepl({
      session: s,
      commands: gatedRegistry(forkOpen),
      io: { lines: (async function* () { yield '/branch early'; })(), write: (x: string) => out.push(x), close: () => {} },
      experimentalGate: forkOpen,
      baseDir: bd,
    });
    const joined = out.join('');
    expect(joined).toContain('[branch]');
    expect(joined, '不得出现 ENOENT 失败').not.toContain('ENOENT');
  });
});
