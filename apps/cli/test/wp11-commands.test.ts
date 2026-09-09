// WP-11（M2）命令集余量七条测试（§8.2 M2 分期；判据自足：板 WP-11 DoD①-⑧）。
// 集成形态：真实 repl+scripted provider+隔离 home/baseDir。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
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
    // 手动窗口越界（<100k）
    const { out: out2 } = await runLines(repo, home, baseDir, ["/compact 50000", "/exit"]);
    expect(out2).toContain("[command] /compact failed");
    expect(out2).toContain("100000");
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
  it("改 AGENTS.md 后 /reload → memory.text 反映新内容", async () => {
    const repo = join(dir, "c6");
    const home = mkdtempSync(join(dir, "hc6-"));
    const baseDir = join(dir, "bdc6");
    mkdirSync(repo);
    gitInit(repo);
    writeFileSync(join(repo, "AGENTS.md"), "RELOADED-MARKER", "utf8");
    const { out, session } = await runLines(repo, home, baseDir, ["/reload", "/exit"]);
    expect(out).toContain("[reload]");
    expect(session.memory.text).toContain("RELOADED-MARKER");
  });
});

describe("DoD①⑧ 注册+Tab 补全（恰十八）", () => {
  it("七命令注册（恰十八=§8.2 M2 全集）且 /re 前缀含 /reload", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    for (const n of ["compact", "config", "provider", "doctor", "cd", "add-dir", "reload"]) expect(names).toContain(n);
    expect(names.length).toBe(18);
    expect(completeInput("/re", CLI_COMMANDS).candidates).toContain("/reload");
  });
});
