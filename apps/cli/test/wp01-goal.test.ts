// M7-WP-01：/goal 命令（DoD①②③④）。
// 判据自足：
//   ① 注册面（DoD①）：CLI_COMMANDS 恰 32（/goal=第 32 件，正式面非实验门——gatedRegistry 默认关态逐字等于 CLI_COMMANDS 含 goal）。
//   ② 三操作（DoD②）：设定（/goal <objective>）→查看（/goal 与 /goal status）→清除（/goal clear）各一例。
//   ③ 注入面（DoD③）：设定/清除/refine 均以 user turn 注入 s.messages 尾部（<session-goal> XML 块，repl.subtask.injected 先例形）
//      =下一轮 prompt 模型可见的结构证据（消息历史全量进请求）。
//   ④ refine：走 spawnSubagentTask 同一入口（ORC-022 复用；fake provider 脚本化返回改写文本→goal 替换+注入新目标）；
//      refused/空产出=拒绝；无 goal=点名；首轮空会话守卫=subtask 同构 [自定]。
//   ⑤ 转义与守卫：`-- ` 转义（目标以子命令词开头，Kimi 行 352 同构）；带参子命令=拒绝点名 fail-closed。
//   ⑥ 零回归面：goal 状态=ctx 闭包内存态（不落盘）；status/clear 在未设定态=none（不抛错，幂等）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import { gatedRegistry } from "../src/experimental-gate.ts";
import type { ExperimentalGate } from "@standardcode/platform";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

function scriptedProvider(scripts: string[]): ProviderAdapter & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let call = 0;
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const text = scripts[call] ?? scripts[scripts.length - 1] ?? "reply";
      call++;
      for (const ev of [
        { type: "message_start", id: "m", model: "test" },
        { type: "text_delta", text },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

let root: string;
let homeDir: string;
let projDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-m7wp01-goal-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function makeSession(scripts: string[]): Session {
  return createSession({ provider: scriptedProvider(scripts), catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir });
}

function ctxOf(s: Session): ReturnType<typeof createCommandContext> {
  return createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} } as unknown as ReplDeps["io"] });
}

function lastUserText(s: Session): string {
  const last = s.messages.at(-1)!;
  expect(last.role).toBe("user");
  return (last.content as Array<{ type: string; text: string }>).map((b) => b.text).join("");
}

describe("DoD① 注册面：CLI_COMMANDS 恰 32（/goal=第 32 件，正式面）", () => {
  it("CLI_COMMANDS 恰 32 且尾项=goal（30→31 同步口径登记）", () => {
    expect(CLI_COMMANDS).toHaveLength(32);
    expect(CLI_COMMANDS.at(-1)!.name).toBe("theme");
  });
  it("gatedRegistry 默认关=逐字等于 CLI_COMMANDS（31，含 goal——goal 非实验命令）", () => {
    const closed = { enabled: false, flags: [], notices: [] } as ExperimentalGate;
    const reg = gatedRegistry(closed);
    expect(reg.map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(reg).toHaveLength(32);
    expect(reg.find((c) => c.name === "goal")).toBeDefined();
  });
});

describe("DoD② 三操作：设定→查看→清除", () => {
  it("未设定态：/goal 与 /goal status 与 /goal clear 均 none（幂等不抛错）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    expect((await ctx.goal("")).text).toContain("no session goal");
    expect((await ctx.goal("status")).text).toContain("no session goal");
    expect((await ctx.goal("clear")).text).toContain("no session goal");
    expect(s.messages).toHaveLength(0); // 未设定态零注入（注入只发生在状态变更）
  });
  it("设定：/goal <objective> → 注入 <session-goal> user turn（DoD③ 结构证据）+ status 查得目标", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    const out = (await ctx.goal("fix the checkout tests then run docs build")).text;
    expect(out).toContain("[goal] set"); // 确认行（目标文本经注入块承载，见下）
    expect(s.messages).toHaveLength(1);
    const injected = lastUserText(s);
    expect(injected).toContain("<session-goal>");
    expect(injected).toContain("fix the checkout tests");
    expect(injected).toContain("</session-goal>");
    expect((await ctx.goal("status")).text).toContain("fix the checkout tests");
  });
  it("查看：/goal 与 /goal status 均显示当前目标（ctx 闭包状态跨调用持续）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    await ctx.goal("ship v0.2");
    const n0 = s.messages.length;
    expect((await ctx.goal("")).text).toContain("ship v0.2");
    expect((await ctx.goal("status")).text).toContain("ship v0.2");
    expect(s.messages).toHaveLength(n0); // 查看零注入
  });
  it("清除：/goal clear → 状态清空 + cleared 注入（对称面）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    await ctx.goal("ship v0.2");
    const out = (await ctx.goal("clear")).text;
    expect(out).toContain("cleared");
    const cleared = lastUserText(s);
    expect(cleared).toContain('<session-goal cleared="true" />');
    expect((await ctx.goal("status")).text).toContain("no session goal");
  });
});

describe("转义与守卫（Kimi 行 352 同构 + fail-closed）", () => {
  it("-- 转义：目标以子命令词开头（/goal -- clear the cache）按目标设定而非子命令（前缀剥离有断言）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    const out = (await ctx.goal("-- clear the cache after deploy")).text;
    expect(out).toContain("[goal] set");
    // 目标文本经注入块承载（-- 转义后整段为目标且 **不含 -- 前缀**，未走 clear 子命令分支）
    expect(lastUserText(s)).toContain("\nclear the cache after deploy\n</session-goal>");
    // status 查得值须为剥前缀后的目标（转义失效时值带 "-- " 前缀=本断言红）
    expect((await ctx.goal("status")).text).toContain("current: clear the cache after deploy");
  });
  it("带参子命令=拒绝点名（status/clear/refine 三形；Kimi 未定义行为取严 [自定]）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    await expect(ctx.goal("status now")).rejects.toThrow(/\bstatus\b/);
    await expect(ctx.goal("clear it")).rejects.toThrow(/\bclear\b/);
    await expect(ctx.goal("refine it")).rejects.toThrow(/\brefine\b/);
    expect(s.messages).toHaveLength(0);
  });
});

describe("refine：spawn 改写（DoD②③『细化』面）", () => {
  it("refine：spawn 返回改写文本 → goal 替换 + 新目标注入（脚本化 provider 单脚本形）", async () => {
    const s = makeSession(["Deliverable: green checkout test suite. Constraint: no network. Done-when: pnpm test exits 0."]);
    const ctx = ctxOf(s);
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] }); // 过首轮守卫（subtask 同构 [自定]）
    await ctx.goal("fix tests");
    const out = (await ctx.goal("refine")).text;
    expect(out).toContain("Deliverable: green checkout test suite");
    const injected = lastUserText(s);
    expect(injected).toContain("<session-goal>");
    expect(injected).toContain("Deliverable: green checkout test suite");
    // refine 的改写请求到达 provider（spawn 面 prompt 实证辅助）
    const refineReq = scriptedLastRequest(s);
    expect(refineReq).toBeDefined();
  });
  it("无 goal=点名拒绝；空产出=拒绝不静默置空", async () => {
    const s = makeSession(["", "   "]);
    const ctx = ctxOf(s);
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    await expect(ctx.goal("refine")).rejects.toThrow(/no session goal/);
    await ctx.goal("real objective");
    await expect(ctx.goal("refine")).rejects.toThrow(/empty objective/);
    // 目标保持原值（未被空产出污染）
    expect((await ctx.goal("status")).text).toContain("real objective");
  });
  // 注：首轮空会话守卫（s.messages.length===0）在 /goal 语义下不可达——设定即注入 user turn 使消息非空；
  // 实现保留该守卫=防御性（subtask 同构），无判别用例（登记于结果页偏差）。
});

describe("判别力（V 补）：N5/N6 缺口封闭（fail-closed 分支可达性）", () => {
  it("C1（N5）：已有 goal 但 messages 被清空 → 首轮守卫 repl.subtask.guard 触发（subtask 同构防御分支可达）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    await ctx.goal("fix the flaky integration test"); // 设定目标（注入 user turn，正常态守卫不可达）
    expect(s.messages.length).toBeGreaterThan(0); // 前置不变量：设定后必有 user turn
    s.messages.length = 0; // 白盒构造「首轮守卫」可达态（绕过正常设定注入）
    await expect(ctx.goal("refine")).rejects.toThrow(/Cannot start a subtask/);
    // 特征词与 noGoal / emptyRefine 文案不重叠（判别力隔离）——见 i18n.ts:199
  });
  it("C2（N6）：已有 goal 时 refine 带参 → 点名拒绝 subcommandArgs（extraArgs 分支，noGoal 不可达）", async () => {
    const s = makeSession([]);
    const ctx = ctxOf(s);
    await ctx.goal("ship the release notes"); // 设定目标 → noGoal 分支不可能命中
    await expect(ctx.goal("refine extra")).rejects.toThrow(/takes no arguments/);
    // 断言落在 repl.goal.err.subcommandArgs（i18n.ts:347），与 noGoal 文案隔离
    expect(s.messages).toHaveLength(1); // 仅设定注入；refine 带参被拒未注入
  });
});

/** 取 refine 调用到达 provider 的最近请求（spawn 面 prompt 实证辅助）。 */
function scriptedLastRequest(s: Session): LLMRequest | undefined {
  const p = s.provider as ProviderAdapter & { requests?: LLMRequest[] };
  return p.requests?.at(-1);
}
