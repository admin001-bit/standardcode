// 批 6 回归（全仓审查 2026-10-01）：会话态残留/一致性八条中的六面（R1-1/2/3＋S5-1/3/4/5/7）。
// R1-x＝sessionGoal 改 Session 字段（原 ctx 闭包仅 /new 清）；S5-1＝switchSession 先摘旧资产（撞锁不串盘）；
// S5-3＝reload 读随 session.cwd（写读同径）；S5-4＝id 创建即赋+随切随更；S5-5＝skills 注入三态复位；
// S5-7＝/compact 手动窗口重建带全量配置（enabled/pct/modelDefault 保真）。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { SessionLock, transcriptsDir } from "@standardcode/platform";
import { createCommandContext, runRepl, type ReplIo } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-cr6-"));
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 句柄残留容错 */
  }
});

const SKILL_MD = `---
name: greet
description: greets the user warmly
---
Hello from greet skill.
`;

function mkProj(name: string, opts?: { skill?: boolean; settings?: Record<string, unknown> }): { proj: string; home: string } {
  const proj = path.join(root, name, "proj");
  const home = path.join(root, name, "home");
  mkdirSync(proj, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (opts?.skill) {
    mkdirSync(path.join(proj, ".standardcode", "skills", "greet"), { recursive: true });
    writeFileSync(path.join(proj, ".standardcode", "skills", "greet", "SKILL.md"), SKILL_MD, "utf8");
  }
  if (opts?.settings) {
    mkdirSync(path.join(proj, ".standardcode"), { recursive: true });
    writeFileSync(path.join(proj, ".standardcode", "settings.json"), JSON.stringify({ schemaVersion: 1, ...opts.settings }), "utf8");
  }
  return { proj, home };
}

/** 纯文本回合 provider（prompt 轮可用）；capabilities 给真实形状。 */
function textProvider(): ProviderAdapter {
  let n = 0;
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(): AsyncIterable<LLMEvent> {
      n++;
      yield { type: "message_start", id: "m", model: "t" } as LLMEvent;
      yield { type: "text_delta", text: `reply-${n}` } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

function ctxOf(s: Session, over: Partial<Parameters<typeof createCommandContext>[0]> = {}) {
  return createCommandContext({
    session: s,
    io: { lines: (async function* () {})(), write: () => {}, close: () => {} },
    baseDir: path.join(root, "ctx-base"),
    ...over,
  });
}

function mkSession(proj: string, home: string, provider?: ProviderAdapter): Session {
  // lang 钉 en（S7-2 教训：resolveLang 双通道任一 zh 即断言批量红）
  return createSession({ provider: provider ?? textProvider(), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home, trusted: true, env: { ...process.env, STANDARD_CODE_LANG: "en" } });
}

describe("R1-1/R1-2/R1-3：sessionGoal 为 Session 字段（原 ctx 闭包残留）", () => {
  it("R1-2：clearHistory 连带清目标——原 status 显示目标而注入轮已随 messages 消失", async () => {
    const { proj, home } = mkProj("r12");
    const s = mkSession(proj, home);
    const ctx = ctxOf(s);
    await ctx.goal("fix the bug");
    expect(s.sessionGoal).toBe("fix the bug");
    ctx.clearHistory();
    expect(s.messages).toHaveLength(0);
    const r = await ctx.goal("status");
    expect(r.text).toContain("no session goal"); // 修复前：闭包残留 → status 仍显示目标
  });

  it("R1-1/R1-3：newSession（switchSession）复位目标——/new 后不残留旧目标", async () => {
    const { proj, home } = mkProj("r11");
    const s = mkSession(proj, home);
    const ctx = ctxOf(s);
    await ctx.goal("keep me");
    await ctx.newSession();
    const r = await ctx.goal("status");
    expect(r.text).toContain("no session goal"); // 修复前：仅闭包清了 newSession 一行……闭包路径本就清；判别点在 Session 字段化后仍被清 + resume 同函数
    expect(s.sessionGoal).toBeUndefined();
  });

  it("R1-1 resume 路径（switchSession 单源）：/resume 后目标复位——见 resume-e2e（S5-1 合测）", () => {
    // /new 与 /resume 共用 switchSession（复位语义单源）；resume 专项断言在 S5-1 的 E2E 内一并钉
    expect(true).toBe(true);
  });
});

describe("S5-5：skills 注入三态复位", () => {
  it("resetInjectionState：sent 集合与激活态清零（/new /clear 后清单重发、白名单不再跨会话收窄）", async () => {
    const { proj, home } = mkProj("s55", { skill: true });
    const s = mkSession(proj, home);
    expect(s.skills.listing()).toContain("greet"); // 首发（newOnes 全量）
    expect(s.skills.listing()).toBeNull(); // 增量已发 → null
    const run1 = s.skills.runByName("greet", "");
    expect(s.skills.active()).not.toBeNull(); // 激活白名单在位
    expect(run1.injected).not.toBeNull();
    s.skills.resetInjectionState();
    expect(s.skills.listing()).toContain("greet"); // 修复前（无复位）恒 null → /new 后新会话永远看不到清单
    expect(s.skills.active()).toBeNull(); // 修复前：旧激活 allowedTools 继续收窄新会话工具面
    expect(s.skills.runByName("greet", "").injected).not.toBeNull(); // 已发送集合清零（原恒 already-loaded 注入 null）
    // clearHistory 生产接线
    const ctx = ctxOf(s);
    s.skills.runByName("greet", "");
    expect(s.skills.active()).not.toBeNull();
    ctx.clearHistory();
    expect(s.skills.active()).toBeNull();
  });
});

describe("S5-4：session.id 创建即赋+随切换", () => {
  it("createSession 即有非空 id（原空串至 runRepl 才赋，hooks 构造期捕获空）；/new 后更换", async () => {
    const { proj, home } = mkProj("s54");
    const s = mkSession(proj, home);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/); // 创建期 UUID（修复前 ""）
    const before = s.id;
    const ctx = ctxOf(s);
    await ctx.newSession();
    expect(s.id).not.toBe(before); // 修复前 switchSession 不更新 s.id → hooks/telemetry/skills 恒指启动 UUID
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("S5-3：reload 读随 session.cwd（写读同径）", () => {
  it("/cd 后 reload 读新目录 settings——原恒读启动期 projectRoot，/effort /config 写读分叉永不生效", async () => {
    const { proj, home } = mkProj("s53a");
    const dirB = path.join(root, "s53b");
    mkdirSync(path.join(dirB, ".standardcode"), { recursive: true });
    writeFileSync(path.join(dirB, ".standardcode", "settings.local.json"), JSON.stringify({ schemaVersion: 1, ui: { theme: "dark" } }), "utf8");
    const s = mkSession(proj, home);
    const ctx = ctxOf(s);
    ctx.changeDir(dirB);
    expect(s.cwd).toBe(dirB);
    ctx.reload();
    expect(s.settings.merged["ui.theme"]).toBe("dark"); // 修复前：读启动 proj → undefined（写读分叉）
  });
});

describe("S5-7：/compact 手动窗口重建带全量配置", () => {
  it("重建后 autocompact.enabled:false 保真——原单键 env 重建致 enabled 恒 true", async () => {
    const { proj, home } = mkProj("s57", { settings: { autocompact: { enabled: false } } });
    const s = mkSession(proj, home);
    expect(s.autocompact.evaluate(999_999, 1).shouldCompact).toBe(false); // 构造期即禁用
    const ctx = ctxOf(s);
    await ctx.compact(150_000, undefined).catch(() => {}); // 重建先行；runCompaction 触发 provider 桩抛错不影响重建断言
    const d = s.autocompact.evaluate(999_999, 5);
    expect(d.shouldCompact).toBe(false); // 修复前：单键重建 → enabled 恒 true → 999999≥阈 → shouldCompact true
    expect(d.reason).toContain("disabled");
  });
});

describe("S5-1＋R1-1 resume：撞锁不串盘（runRepl 生产路径 E2E）", () => {
  it("resume 目标锁被占：旧资产已摘（after-resume 不写进旧会话转录）、目标复位；提示 transcript 不可用", async () => {
    const { proj, home } = mkProj("s51");
    const baseDir = path.join(root, "s51-base");
    mkdirSync(baseDir, { recursive: true });
    // 预制 resume 目标会话 cr6-stuck：转录 + 本进程占锁（同进程二次 acquire 必抛）
    const transDir = transcriptsDir(proj, baseDir);
    mkdirSync(transDir, { recursive: true });
    const xId = "cr6-stuck";
    writeFileSync(
      path.join(transDir, `${xId}.jsonl`),
      JSON.stringify({ schemaVersion: 1, seq: 1, ts: new Date().toISOString(), kind: "user_message", message: { role: "user", content: [{ type: "text", text: "X hello" }] } }) + "\n",
      "utf8",
    );
    const heldLock = await SessionLock.acquire(proj, xId, baseDir);

    let providerCalls = 0;
    const provider: ProviderAdapter = {
      capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
      countTokens: async () => 0,
      async *stream(): AsyncIterable<LLMEvent> {
        providerCalls++;
        yield { type: "message_start", id: "m", model: "t" } as LLMEvent;
        yield { type: "text_delta", text: "A-reply" } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      },
    };

    const session = createSession({ provider, catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home, trusted: true, env: { ...process.env, STANDARD_CODE_LANG: "en" } });
    let out = "";
    const io: ReplIo = {
      lines: (async function* () {
        for (const l of ["/goal keep-me", "hello A", "/resume", "after-resume", "/goal status", "/exit"]) yield l;
      })(),
      write: (s) => (out += s),
      close: () => {},
    };
    await runRepl({
      session,
      io,
      baseDir,
      sessionPicker: {
        pick: async () => ({
          sessionId: xId,
          filePath: path.join(transDir, `${xId}.jsonl`),
          title: "X",
          startedAt: null,
          lastActivityAt: null,
          messageCount: 1,
          lastReason: null,
        }),
        rename: async () => {},
      },
    });
    await heldLock.release();

    // A 会话转录：含第一轮 "hello A"（sanity），但**不含** resume 后的 "after-resume"
    const files = readdirSync(transDir).filter((f) => f.endsWith(".jsonl") && f !== `${xId}.jsonl`);
    expect(files.length).toBeGreaterThan(0);
    const aContent = files.map((f) => readFileSync(path.join(transDir, f), "utf8")).join("\n");
    expect(aContent).toContain("hello A");
    expect(aContent).not.toContain("after-resume"); // 修复前：assets 未摘 → 串写旧会话 A 的 .jsonl
    // X 会话转录零新增（锁被占=创建失败，任何路径都不得写入）
    const xContent = readFileSync(path.join(transDir, `${xId}.jsonl`), "utf8");
    expect(xContent).not.toContain("after-resume");
    // 撞锁提示已打出（fail-visible）
    expect(out).toContain("transcript unavailable");
    // R1-1 resume：目标随 switchSession 复位（修复前后对照——残留时 status 显示 keep-me）
    expect(out).toContain("no session goal");
    expect(session.sessionGoal).toBeUndefined();
    expect(providerCalls).toBeGreaterThanOrEqual(1);
  });
});

