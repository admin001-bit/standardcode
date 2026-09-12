// WP-07（M3）/subtask /effort /init 测试（v2.8 §8.2 M3 分期；判据自足：板 WP-07 DoD①-④ 逐条）。
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { AGENTS_SKELETON, CLI_COMMANDS, deriveSubtaskName, type CommandContext } from "../src/commands.ts";
import { createSession, resolveThinking } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { completeInput } from "../src/tab-complete.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-wp07-"));
}

function textProvider(text = "sub answer"): { provider: ProviderAdapter; requests: any[][] } {
  const requests: any[][] = [];
  const provider: ProviderAdapter = {
    capabilities: () => ({ contextWindow: 8_000, maxOutputTokens: { default: 1_000, upper: 4_000 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: [], explicitBreakpoints: false } }),
    async *stream(req): AsyncGenerator<LLMEvent> {
      requests.push(JSON.parse(JSON.stringify(req.messages))); // 快照（loop 收尾会同数组追加 assistant 轮）
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
    countTokens: async () => 0,
  };
  return { provider, requests };
}

function fixture(provider?: ProviderAdapter): { session: ReturnType<typeof createSession>; ctx: CommandContext; root: string; cleanup: () => void } {
  const root = tmpRoot();
  const session = createSession({ provider: provider ?? textProvider().provider, catalog: ["m-a"], model: "m-a", cwd: root, projectRoot: root });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("DoD① /subtask 同步子任务执行+结果注入", () => {
  it("同步执行（独立上下文）+报告注入会话", async () => {
    const { provider, requests } = textProvider("sub answer");
    const { session, ctx, cleanup } = fixture(provider);
    try {
      session.messages.push({ role: "user", content: [{ type: "text", text: "parent turn" }] });
      const r = await ctx.subtask("check the files");
      expect(r.text).toContain("sub answer");
      expect(r.text).toContain("general-purpose completed (18 tokens");
      // 独立上下文：发往 provider 的 messages 仅含本次 prompt（不携带父会话消息）
      expect(requests[0]).toEqual([{ role: "user", content: [{ type: "text", text: "check the files" }] }]);
      // 结果注入：最后一条=注入的 user 消息（<subtask> 包裹报告），原父消息保留
      const last = session.messages.at(-1)!;
      expect(last.role).toBe("user");
      const injectedText = JSON.stringify(last.content);
      expect(injectedText).toContain("<subtask");
      expect(injectedText).toContain("sub answer");
      expect(session.messages.at(-2)!.role).toBe("user");
    } finally {
      cleanup();
    }
  });

  it("首轮前拒绝（CC :328 同构）与空参报错", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      await expect(ctx.subtask("x")).rejects.toThrow(/Cannot start a subtask before the first conversation turn/);
      session.messages.push({ role: "user", content: [{ type: "text", text: "t" }] });
      const subtaskCmd = CLI_COMMANDS.find((c) => c.name === "subtask")!;
      await expect(subtaskCmd.execute!("", ctx)).rejects.toThrow(/prompt required/);
    } finally {
      cleanup();
    }
  });

  it("deriveSubtaskName：CC Te :347 逐字同构（前 3 词/清洗/截 24/兜底）", () => {
    expect(deriveSubtaskName("Check the Files Now please")).toBe("check-the-files");
    expect(deriveSubtaskName("!!!")).toBe("subtask");
    expect(deriveSubtaskName("a b c d e")).toBe("a-b-c");
    expect(deriveSubtaskName("x".repeat(40))).toBe("x".repeat(24));
  });
});

describe("DoD② /effort 档位写 settings+下一 turn 生效", () => {
  it("设置 high → local 层 model.thinking=adaptive 且 session.thinking 下一 turn 生效", async () => {
    const { session, ctx, root, cleanup } = fixture();
    try {
      const r = await ctx.effort("high");
      expect(r.text).toContain("[effort] high");
      expect(session.thinking).toEqual({ type: "adaptive" }); // 下一 turn 生效
      const local = JSON.parse(readFileSync(path.join(root, ".standardcode", "settings.local.json"), "utf8"));
      expect(local.model?.thinking).toBe("adaptive"); // setLocalSetting 点路径嵌套（config-store.ts:24-31）
      expect(resolveThinking(undefined, session.env, session.settings)).toEqual({ type: "adaptive" });
    } finally {
      cleanup();
    }
  });

  it("off/low 档位映射；无参查看当前；非法值报错", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      await ctx.effort("off");
      expect(session.thinking).toBeUndefined();
      await ctx.effort("low");
      expect(session.thinking).toEqual({ type: "budget", budgetTokens: 4000 });
      const shown = await ctx.effort("");
      expect(shown.text).toContain("current: low");
      await expect(ctx.effort("turbo")).rejects.toThrow(/unknown effort/);
    } finally {
      cleanup();
    }
  });
});

describe("DoD③ /init 生成 AGENTS.md 骨架+已存在不覆盖", () => {
  it("首次生成骨架文件；再次运行提示已存在且内容不变", async () => {
    const { ctx, root, cleanup } = fixture();
    try {
      const r1 = await ctx.init();
      expect(r1.text).toContain("created");
      const p = path.join(root, "AGENTS.md");
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(AGENTS_SKELETON);
      expect(AGENTS_SKELETON).toContain("This file provides guidance to StandardCode");
      const r2 = await ctx.init();
      expect(r2.text).toContain("already exists");
      expect(readFileSync(p, "utf8")).toBe(AGENTS_SKELETON); // 内容不变
    } finally {
      cleanup();
    }
  });

  it("已存在用户的 AGENTS.md → 不覆盖", async () => {
    const { ctx, root, cleanup } = fixture();
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "AGENTS.md"), "# my own agents file\n", "utf8");
      const r = await ctx.init();
      expect(r.text).toContain("already exists");
      expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# my own agents file\n");
    } finally {
      cleanup();
    }
  });
});

describe("DoD④ 三命令 Tab 补全（UI-001）", () => {
  it("唯一命中走 insert；/ 全清单包含三件", () => {
    // 唯一命中：insert=补全文本（含尾随空格）、candidates=[]（tab-complete.ts:25-27）
    expect(completeInput("/su", CLI_COMMANDS).insert).toBe("/subtask ");
    expect(completeInput("/ef", CLI_COMMANDS).insert).toBe("/effort ");
    expect(completeInput("/in", CLI_COMMANDS).insert).toBe("/init ");
    const all = completeInput("/", CLI_COMMANDS).candidates;
    expect(all).toContain("/subtask");
    expect(all).toContain("/effort");
    expect(all).toContain("/init");
  });
});
