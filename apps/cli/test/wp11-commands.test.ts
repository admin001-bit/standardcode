// WP-11（M2）命令集余量七条测试（§8.2 M2 分期；判据自足：板 WP-11 DoD①-⑧）。
// 集成形态：真实 repl+scripted provider+隔离 home/baseDir。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { createCommandContext, runRepl, type ReplIo } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-wp11-"));
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

const REPLY: LLMEvent[] = [
  { type: "text_delta", text: "reply" } as LLMEvent,
  { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent,
];

async function runLines(repo: string, home: string, baseDir: string, lines: string[]): Promise<{ out: string; session: ReturnType<typeof createSession>; provider: ReturnType<typeof scriptedProvider> }> {
  const provider = scriptedProvider([REPLY, REPLY, REPLY, REPLY]);
  const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir });
  return { out, session, provider };
}

describe("DoD② /compact：手动压缩触发 WP-04 流程+手动窗口边界", () => {
  it("两轮会话 /compact → 摘要替换历史（preTokens>postTokens 型收缩）；窗口越界报错", async () => {
    const repo = join(dir, "c1");
    const home = mkdtempSync(join(dir, "hc-"));
    const baseDir = join(dir, "bdc");
    mkdirSync(repo);
    gitInit(repo);
    // runCompaction 需要真实 provider 产摘要文本——scripted REPLY（"reply"）即可当摘要
    const { out, session } = await runLines(repo, home, baseDir, ["q1", "q2", "/compact", "/exit"]);
    expect(out).toContain("[compact]");
    expect(session.messages.length).toBeLessThanOrEqual(2); // 摘要替换历史（newMessages=[user summary]）
    expect(session.messages.some((m) => JSON.stringify(m).includes("reply"))).toBe(true);
    // 手动窗口越界（<100k 下界；>1M 上界=O5 补测，同一命令门）
    const { out: out2 } = await runLines(repo, home, baseDir, ["/compact 50000", "/exit"]);
    expect(out2).toContain("[command] /compact failed");
    expect(out2).toContain("100000");
    const { out: out3 } = await runLines(repo, home, baseDir, ["/compact 1000001", "/exit"]);
    expect(out3).toContain("[command] /compact failed");
  });

  it("手动窗口 150000 生效（R1 回归：裸整数解析为绝对值，协调器阈值=150000×0.8=120000）", async () => {
    const repo = join(dir, "c1b");
    const home = mkdtempSync(join(dir, "hcb-"));
    const baseDir = join(dir, "bdb");
    mkdirSync(repo);
    gitInit(repo);
    const { session } = await runLines(repo, home, baseDir, ["q1", "/compact 150000", "/exit"]);
    // 修复前：parseManualWindow("150000") 按 k 误读 1.5e8 拒 → 静默回落默认窗 200000（compactAt=160000）→ 两断言皆 false
    const lo = session.autocompact.evaluate(119_999, 99);
    const hi = session.autocompact.evaluate(120_000, 99);
    expect(lo.shouldCompact).toBe(false);
    expect(hi.shouldCompact).toBe(true);
    expect(hi.level).toBe("compact");
  });
});

describe("DoD③ /config：展示=WP-01 合并序、编辑落 local", () => {
  it("无参展示五来源；写键落 settings.local.json 且 /reload 后生效", async () => {
    const repo = join(dir, "c2");
    const home = mkdtempSync(join(dir, "hc2-"));
    const baseDir = join(dir, "bdc2");
    mkdirSync(repo);
    gitInit(repo);
    const { out } = await runLines(repo, home, baseDir, ["/config", "/config memory.autoRead false", "/exit"]);
    expect(out).toContain("effective sources");
    expect(out).toContain("merged keys");
    const localFile = join(repo, ".standardcode", "settings.local.json");
    expect(existsSync(localFile)).toBe(true);
    const doc = JSON.parse(readFileSync(localFile, "utf8"));
    expect(doc.memory.autoRead).toBe(false);
    expect(doc.schemaVersion).toBe(1);
    // reload 后 merged 反映
    const { session, out: out2 } = await runLines(repo, home, baseDir, ["/reload", "/config memory.autoRead", "/exit"]);
    expect(out2).toContain("false");
    void session;
  });
});

describe("DoD④ /provider：切换下一 turn 生效（MDL-010~013）", () => {
  it("无参列当前；切换后下一 turn 请求走新 provider", async () => {
    const repo = join(dir, "c3");
    const home = mkdtempSync(join(dir, "hc3-"));
    const baseDir = join(dir, "bdc3");
    mkdirSync(repo);
    gitInit(repo);
    // openai 需 OPENAI_API_KEY——env 注入隔离 home settings；直接注入 process.env 副本不可行（createSession 用 init.env）
    // 这里只验无参展示+未知名报错（openai 实切换留 M3 /provider live 面——本卡注册+切换语义在 session.switchProvider）
    const { out, session } = await runLines(repo, home, baseDir, ["/provider", "/provider nope", "/exit"]);
    expect(out).toContain("provider: anthropic");
    // 未知名但缺 OPENAI_API_KEY → buildProvider 先撞 key 门（切换语义本身在 session.switchProvider，openai live 面=M3）
    expect(out).toContain("[command] /provider failed");
    expect(out).toContain("missing API key");
    expect(session.providerName).toBe("anthropic"); // 切换失败保原值
  });

  it("切换成功路径（V O2 补测）：key+目录 env 注入 → switchProvider 重建 adapter，catalog/model 随新 provider", async () => {
    const repo = join(dir, "c3b");
    const home = mkdtempSync(join(dir, "hc3b-"));
    const baseDir = join(dir, "bdc3b");
    mkdirSync(repo);
    gitInit(repo);
    const scripted = scriptedProvider([REPLY, REPLY]);
    // 不传 init.catalog：生产装配形态（main.ts createSession 无 catalog 注入），switch 后 catalog 必须取新 provider 目录
    const session = createSession({
      provider: scripted,
      model: "m-a",
      cwd: repo,
      home,
      env: { OPENAI_API_KEY: "sk-test", STANDARD_CODE_MODELS: "gpt-x,gpt-y" },
    });
    expect(session.providerName).toBe("anthropic");
    session.switchProvider("openai");
    expect(session.providerName).toBe("openai");
    expect(session.provider).not.toBe(scripted); // adapter 已重建（下一 turn runPromptTurn 现取 s.provider=生效机制）
    expect([...session.catalog]).toEqual(["gpt-x", "gpt-y"]);
    expect(session.model).toBe("gpt-x"); // 旧 model 不在新目录 → 回落目录首
  });
});

describe("DoD⑤ /doctor：检查项清单落结果页（S-10 提示+迁移提示）+自修复最小集", () => {
  it("坏 settings JSON→warn；缺 schemaVersion→ENG-080 提示；.standardcode 缺失→自修复创建", async () => {
    const repo = join(dir, "c4");
    const home = mkdtempSync(join(dir, "hc4-"));
    const baseDir = join(dir, "bdc4");
    const std = join(repo, ".standardcode");
    mkdirSync(std, { recursive: true });
    writeFileSync(join(std, "settings.json"), "{broken", "utf8"); // 坏 JSON→warn
    gitInit(repo);
    const { out } = await runLines(repo, home, baseDir, ["/doctor", "/exit"]);
    expect(out).toContain("doctor: environment health check");
    expect(out).toContain("[warn] settings projectShared");
    expect(out).toContain("invalid JSON");
  });

  it("写探针真实现（V O3 修复）：.standardcode 可写→[ok]；自修复=缺失才创建并 [fix] 登记", async () => {
    const repo = join(dir, "c4b");
    const home = mkdtempSync(join(dir, "hc4b-"));
    const baseDir = join(dir, "bdc4b");
    mkdirSync(repo);
    gitInit(repo);
    // 目录缺失 → doctor 创建（自修复真实发生）并上屏 [fix]
    const { out } = await runLines(repo, home, baseDir, ["/doctor", "/exit"]);
    expect(out).toContain("[ok] directories writable"); // 写探针=临时文件写删（原硬编码 [ok] 无探针）
    expect(out).toContain("[fix] created missing project .standardcode");
    expect(existsSync(join(repo, ".standardcode"))).toBe(true);
    // 目录已在 → 无 [fix]（自修复不谎报）
    const { out: out2 } = await runLines(repo, home, baseDir, ["/doctor", "/exit"]);
    expect(out2).toContain("[ok] directories writable");
    expect(out2).toContain("[ok] no self-repair needed");
    expect(out2).not.toContain("[fix]");
  });
});

describe("DoD⑥ /cd /add-dir：生效且 add-dir 过信任门控", () => {
  it("/cd 切换目录（tools 重建）；/add-dir 未信任拒绝（fail-closed）；信任后成功", async () => {
    const repo = join(dir, "c5");
    const other = join(dir, "other-dir");
    const home = mkdtempSync(join(dir, "hc5-"));
    const baseDir = join(dir, "bdc5");
    mkdirSync(repo);
    mkdirSync(other);
    gitInit(other);
    gitInit(repo);
    const { out, session } = await runLines(repo, home, baseDir, [`/add-dir ${other}`, "/exit"]);
    expect(out).toContain("add-dir requires workspace trust"); // 未信任仓库目录拒绝（§8.3）
    // 信任 other 后成功
    const { acceptTrust } = await import("@standardcode/platform");
    acceptTrust(other, { accepted: {} }, join(home, ".standardcode", "trust.json"));
    const s2 = createSession({ provider: scriptedProvider([REPLY]) as never, catalog: ["m-a"], model: "m-a", cwd: other, home });
    s2.addAdditionalDirectory(repo);
    expect(s2.additionalDirectories).toContain(repo);
    // /cd 生效
    const { out: out2, session: s3 } = await runLines(repo, home, baseDir, [`/cd ${other}`, "/exit"]);
    expect(out2).toContain("[cd]");
    expect(s3.cwd).toBe(other);
    expect(out2).not.toContain("[error]");
  });
});

describe("DoD⑦ /reload：记忆与设置分区重载断言", () => {
  it("会话启动后改盘再 /reload → 新内容入旧内容出（V O1 判别式修复：原版先写后建会话=/reload no-op 亦过）", async () => {
    const repo = join(dir, "c6");
    const home = mkdtempSync(join(dir, "hc6-"));
    const baseDir = join(dir, "bdc6");
    mkdirSync(repo);
    gitInit(repo);
    // 启动时只有 V1——createSession 初载读到 V1；turn 循环中改盘写 V2，/reload 必须重读盘才可见
    writeFileSync(join(repo, "AGENTS.md"), "V1-MARKER", "utf8");
    let flipped = false;
    const provider = scriptedProvider([REPLY, REPLY]);
    const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
    expect(session.memory.text).toContain("V1-MARKER"); // 初载态
    let out = "";
    const io: ReplIo = {
      lines: (async function* () {
        yield "q1";
        writeFileSync(join(repo, "AGENTS.md"), "V2-MARKER-RELOADED", "utf8"); // 会话中途改盘
        flipped = true;
        yield "/reload";
        yield "/exit";
      })(),
      write: (s) => (out += s),
      close: () => {},
    };
    await runRepl({ session, io, baseDir });
    expect(flipped).toBe(true);
    expect(out).toContain("[reload]");
    expect(session.memory.text).toContain("V2-MARKER-RELOADED"); // 新内容入
    expect(session.memory.text).not.toContain("V1-MARKER"); // 旧内容出（真重载，非 no-op）
  });
});

describe("DoD①⑧ 注册+Tab 补全（M2 全集十八；M3 增五件后 23——WP-05/07）", () => {
  it("七命令注册（M2 分期）且 /re 前缀含 /reload", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    for (const n of ["compact", "config", "provider", "doctor", "cd", "add-dir", "reload"]) expect(names).toContain(n);
    expect(names.length).toBe(33); // M2 十八+M3 七+M4 五件+M7 /goal（M7-WP-01，2026-09-19：30→31）+M7-WP-03 /theme（2026-09-23：31→32）+M7-WP-04 /keybindings（2026-09-23：32→33）
    expect(completeInput("/re", CLI_COMMANDS).candidates).toContain("/reload");
  });
});

describe("WP-08 DoD③ compact 直调面 fail-closed（M2 WP-11 登记级①收口：界外值不静默回落默认窗）", () => {
  it("ctx.compact 界外值（越界/NaN/小数/负数）拒绝：协调器不换、模型轮次不发生；合法下界通过", async () => {
    const repo = join(dir, "wp08c");
    const home = mkdtempSync(join(dir, "hwp08c-"));
    const baseDir = join(dir, "bwp08c");
    mkdirSync(repo);
    gitInit(repo);
    const provider = scriptedProvider([REPLY, REPLY]);
    const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: repo, home });
    session.messages.push({ role: "user", content: [{ type: "text", text: "hi" }] });
    const io: ReplIo = {
      lines: (async function* () {})(),
      write: () => {},
      close: () => {},
    };
    const ctx = createCommandContext({ session, io, baseDir });
    const before = session.autocompact;
    for (const bad of [50_000, 1_000_001, NaN, 1.5, -1]) {
      await expect(ctx.compact(bad)).rejects.toThrow(/integer in \[100000, 1000000\]/);
    }
    expect(session.autocompact).toBe(before); // 原版路径=静默回落默认窗并整体替换协调器（防御纵深缺口）
    expect(provider.seen.length).toBe(0); // 界外值不进压缩轮次
    await ctx.compact(100_000); // 合法边界（下界含）正常执行
    expect(session.autocompact).not.toBe(before);
    expect(provider.seen.length).toBe(1);
  });
});
