// WP-10（M3）/status /usage 测试（§8.2 M3 分期；判据自足：板 WP-10 DoD①-④）。
// 口径锚：CTX-102 四列（=usage-meter totals）、命中率 M1 WP-05 同源（cache_read/input，M2 hitrate.mts :75 同式）、
// ADR-0027（API usage 唯一权威）、ENG-046 内置价格表（[自定] 占位——偏差与未解决见结果页，非官方价断言）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { createCommandContext, runRepl, type ReplIo } from "../src/repl.ts";
import { CLI_COMMANDS, priceTableRow, usageCostUsd } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";

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

function scriptedProvider(turns: LLMEvent[][]): ProviderAdapter & { seen: LLMMessage[][] } {
  let i = 0;
  const seen: LLMMessage[][] = [];
  return {
    seen,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req: LLMRequest) {
      seen.push(structuredClone(req.messages));
      for (const ev of turns[Math.min(i, turns.length - 1)]) yield ev;
      i++;
    },
  };
}

/** usage 事件置首、finish 收尾（render.ts：轮内末条 usage observe——快照语义）。 */
function turnUsage(u: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): LLMEvent[] {
  return [
    { type: "usage", usage: u } as LLMEvent,
    { type: "text_delta", text: "reply" } as LLMEvent,
    { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent,
  ];
}

async function runLines(repo: string, home: string, baseDir: string, lines: string[], provider = scriptedProvider([])): Promise<{ out: string; session: ReturnType<typeof createSession> }> {
  const session = createSession({ provider, catalog: ["m-a", "m-b"], model: "m-a", cwd: repo, home });
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir });
  return { out, session };
}

function newRepo(label: string): { repo: string; home: string; baseDir: string } {
  const repo = join(dir, label);
  const home = mkdtempSync(join(dir, `${label}h-`));
  const baseDir = join(dir, `${label}b`);
  mkdirSync(repo);
  gitInit(repo);
  return { repo, home, baseDir };
}

describe("DoD① /status 各字段实时", () => {
  it("五字段在位（model/provider/permission/context/tasks）；/model /permission /registry 注册即时反映", async () => {
    const { repo, home, baseDir } = newRepo("s1");
    const provider = scriptedProvider([turnUsage({ inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 50 })]);
    const { out } = await runLines(repo, home, baseDir, ["/status", "/exit"], provider);
    expect(out).toContain("[status]");
    expect(out).toContain("model: m-a（provider: anthropic");
    expect(out).toContain("permission: default");
    expect(out).toMatch(/context: \d+\/200000 tokens（[\d.]+%/);
    expect(out).toContain("tasks: 0 active / 0 total");
    // 实时面：模型切换+权限循环+任务注册后逐字段变化（同一次 run 内改盘态——经 io 生成器注入）
    const provider2 = scriptedProvider([turnUsage({ inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 50 })]);
    const session = createSession({ provider: provider2, catalog: ["m-a", "m-b"], model: "m-a", cwd: repo, home });
    let out2 = "";
    const io2: ReplIo = {
      lines: (async function* () {
        yield "/status";
        yield "/permission"; // EXE-001 循环：default→acceptEdits
        session.taskRegistry.register({ agentId: "a1", agentType: "general-purpose", description: "wp10 probe", isBackgrounded: false });
        session.taskRegistry.takeConcurrencySlot(session.taskRegistry.list()[0]!.taskId);
        yield "/model m-b";
        yield "/status";
        yield "/exit";
      })(),
      write: (s) => (out2 += s),
      close: () => {},
    };
    await runRepl({ session, io: io2, baseDir: join(dir, "s1b2") });
    const blocks = out2.split("[status]").slice(1);
    expect(blocks.length).toBe(2);
    const second = blocks[1]!;
    expect(out2).toContain("[status]");
    expect(second).toContain("model: m-b");
    expect(second).toContain("permission: acceptEdits");
    expect(second).toContain("tasks: 1 active / 1 total");
  });
});

describe("DoD② /usage 四列+命中率口径（M1 WP-05 同源）", () => {
  it("跨轮四列累计=input/output/cache_creation/cache_read 求和；hit=cache_read/input", async () => {
    const { repo, home, baseDir } = newRepo("u1");
    const provider = scriptedProvider([
      turnUsage({ inputTokens: 1000, outputTokens: 50, cacheCreationTokens: 200, cacheReadTokens: 400 }),
      turnUsage({ inputTokens: 1000, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 600 }),
    ]);
    const { out } = await runLines(repo, home, baseDir, ["q1", "q2", "/usage", "/exit"], provider);
    expect(out).toContain("input=2000 output=100 cache_creation=200 cache_read=1000");
    expect(out).toContain("cache hit rate（会话内实时，M1 WP-05 同源=cache_read/input）: 50.0%");
    expect(out).toContain("ADR-0027"); // 权威口径声明（DP-4：API usage 显式、本地估算不位移）
  });

  it("零 usage 会话：n/a 不谎报", async () => {
    const { repo, home, baseDir } = newRepo("u2");
    const { out } = await runLines(repo, home, baseDir, ["/usage", "/exit"], scriptedProvider([]));
    expect(out).toContain("input=0 output=0 cache_creation=0 cache_read=0");
    expect(out).toContain("n/a（no input usage yet）");
  });
});

describe("DoD③ 价格表行合计（内置固定表 [自定] 占位）", () => {
  it("usageCostUsd=四列×对应单价合计（USD/Mtok 口径精确）", () => {
    const sonnet = priceTableRow("claude-sonnet-4-6")!;
    expect(sonnet).toEqual({ inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheWriteUsdPerMTok: 3.75, cacheReadUsdPerMTok: 0.3 });
    expect(usageCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }, sonnet)).toBeCloseTo(22.05, 10);
    const opus = priceTableRow("claude-opus-5")!;
    expect(usageCostUsd({ inputTokens: 2_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, opus)).toBeCloseTo(30, 10);
    expect(priceTableRow("m-a")).toBeNull(); // env 自定目录模型无价格行
    expect(priceTableRow("gpt-4o")).toBeNull();
  });

  it("/usage：目录内模型出合计行+占位声明；目录外模型 cost n/a（拒绝静默套价）", () => {
    const repo = join(dir, "u3");
    const home = mkdtempSync(join(dir, "u3h-"));
    mkdirSync(repo);
    gitInit(repo);
    const provider = scriptedProvider([turnUsage({ inputTokens: 500_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 1_000_000 })]);
    const session = createSession({ provider, catalog: ["claude-sonnet-4-6"], model: "claude-sonnet-4-6", cwd: repo, home });
    const ctx = createCommandContext({ session, io: { lines: (async function* () {})(), write: () => {}, close: () => {} } });
    // 先累计：手动 observe（生产路径=render finish；此处直喂 meter 与命令面解耦断言）
    session.meter.observe({ inputTokens: 500_000, outputTokens: 100_000, cacheCreationTokens: 200_000, cacheReadTokens: 1_000_000 });
    const priced = ctx.usage().text;
    expect(priced).toContain("cost estimate: $");
    expect(priced).toContain("in=$3/M out=$15/M cacheW=$3.75/M cacheR=$0.3/M"); // 行合计单价在位
    expect(priced).toContain("官方标定缺位");
    // 500000*3 + 100000*15 + 200000*3.75 + 1000000*0.3 = 1.5e6+1.5e6+0.75e6+0.3e6 → 4.05 USD
    expect(priced).toContain("$4.050000");
    const s2 = createSession({ provider, catalog: ["m-x"], model: "m-x", cwd: repo, home });
    const ctx2 = createCommandContext({ session: s2, io: { lines: (async function* () {})(), write: () => {}, close: () => {} } });
    expect(ctx2.usage().text).toContain("cost estimate: n/a（m-x 不在内置价格表");
  });
});

describe("DoD④ 两命令 Tab 补全", () => {
  it("/st 唯一命中 /status；/us 唯一命中 /usage、/u 双义（insert 面）；候选列表含前缀重叠件；命令全集恰 30【勘误 2026-09-14：WP-03 /mcp 25→26；WP-05 /skills 26→27；WP-06 /memory 27→28；WP-09 /plugin 28→29；2026-09-15：WP-08 /update 29→30，/u 双义化=/e 先例形制】", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(names).toContain("status");
    expect(names).toContain("usage");
    expect(names.length).toBe(30);
    expect(completeInput("/st", CLI_COMMANDS).insert).toBe("/status ");
    expect(completeInput("/us", CLI_COMMANDS).insert).toBe("/usage "); // 四路唯一仍走 insert
    const cu = completeInput("/u", CLI_COMMANDS); // WP-08 /update 注册后 /u 双义（/e 先例形制）
    expect(cu.insert).toBeNull();
    expect(cu.candidates).toEqual(["/usage", "/update"]); // 注册序过滤（usage=25 在 update=30 前，非字典序）
    expect(completeInput("/upd", CLI_COMMANDS).insert).toBe("/update ");
    expect(completeInput("/", CLI_COMMANDS).candidates).toContain("/status");
    expect(completeInput("/", CLI_COMMANDS).candidates).toContain("/usage");
  });
});
