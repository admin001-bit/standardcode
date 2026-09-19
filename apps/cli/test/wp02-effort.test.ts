// WP-02（M7）/effort 细化测试（v2.8 §2 行 115「/effort 细化」× §8.2 行 365；判据自足：板 WP-02 DoD①-④ 逐条）。
// 纯追加面：既有 /effort 用例（wp07-commands.test.ts DoD②）零改动——本文件不动其任何断言。
// 细化三面：①档位语义表（每档 thinking 值+语义，当前档标 *）②model×effort 组合面 ③env 逃逸舱覆盖如实报告。
import { describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { EFFORT_SEMANTICS, EFFORT_TO_THINKING, type CommandContext } from "../src/commands.ts";
import { createSession } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CATALOG = ["m-a", "m-b"];

function stubProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 8_000, maxOutputTokens: { default: 1_000, upper: 4_000 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: [], explicitBreakpoints: false } }),
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: "text_delta", text: "x" } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
    countTokens: async () => 0,
  };
}

function fixture(env?: Record<string, string | undefined>): { session: ReturnType<typeof createSession>; ctx: CommandContext; root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "sc-wp02-"));
  const session = createSession({
    provider: stubProvider(),
    catalog: [...CATALOG],
    model: CATALOG[0]!,
    cwd: root,
    projectRoot: root,
    ...(env !== undefined ? { env: { ...env } } : {}),
  });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("DoD① 细化语义每档一例（档位语义表：thinking 值+语义说明）", () => {
  it("off：不发 thinking 字段 + 语义行点名 no reasoning", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const r = await ctx.effort("off");
      expect(session.thinking).toBeUndefined();
      expect(r.text).toContain("off");
      expect(r.text).toContain("no reasoning");
      expect(EFFORT_SEMANTICS.off.thinking).toBe(EFFORT_TO_THINKING.off);
    } finally {
      cleanup();
    }
  });

  it("low：budget 4000 + 语义行点名 light reasoning", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const r = await ctx.effort("low");
      expect(session.thinking).toEqual({ type: "budget", budgetTokens: 4000 });
      expect(r.text).toContain("budget:4000");
      expect(r.text).toContain("light reasoning");
    } finally {
      cleanup();
    }
  });

  it("medium：budget 8000 + 语义行点名 balanced reasoning（= resolveThinking 缺省）", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const r = await ctx.effort("medium");
      expect(session.thinking).toEqual({ type: "budget", budgetTokens: 8000 });
      expect(r.text).toContain("budget:8000");
      expect(r.text).toContain("balanced reasoning");
    } finally {
      cleanup();
    }
  });

  it("high：adaptive + 语义行点名 adaptive reasoning", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const r = await ctx.effort("high");
      expect(session.thinking).toEqual({ type: "adaptive" });
      expect(r.text).toContain("adaptive reasoning");
    } finally {
      cleanup();
    }
  });

  it("语义表：当前档标 * 且四档齐全（标记错位可判别）", async () => {
    const { ctx, cleanup } = fixture();
    try {
      await ctx.effort("medium");
      const shown = (await ctx.effort("")).text;
      expect(shown).toContain("  * medium"); // 当前档标 *
      expect(shown).toContain("    off"); // 非当前档不标 *
      expect(shown).toContain("    high");
    } finally {
      cleanup();
    }
  });

  it("语义表 thinking 值单源=EFFORT_TO_THINKING（四档逐档对质，漂移必红）", async () => {
    const { ctx, cleanup } = fixture();
    try {
      // 单源不变量：语义表不得与档位→thinking 映射漂移（针 D 曾 0 红→本例补判别）
      for (const lv of ["off", "low", "medium", "high"] as const) {
        expect(EFFORT_SEMANTICS[lv].thinking).toBe(EFFORT_TO_THINKING[lv]);
      }
      await ctx.effort("medium");
      const shown = (await ctx.effort("")).text;
      expect(shown).toContain("  * medium  budget:8000"); // 语义表行内的值形（非 set 行）
      expect(shown).toContain("    high  adaptive");
    } finally {
      cleanup();
    }
  });
});

describe("DoD② 与 /model 组合语义（切换模型后档位保持=local 层持久）", () => {
  it("/model 切 m-b 后：组合面显示 m-b × effort low，档位仍 budget 4000", async () => {
    const { session, ctx, cleanup } = fixture();
    try {
      await ctx.effort("low");
      ctx.switchModel("m-b");
      expect(ctx.currentModel()).toBe("m-b");
      const shown = (await ctx.effort("")).text;
      expect(shown).toContain("combo: model m-b × effort low"); // 组合面（model×effort）
      expect(session.thinking).toEqual({ type: "budget", budgetTokens: 4000 }); // 档位随模型切换保持
    } finally {
      cleanup();
    }
  });
});

describe("细化面③：生效面如实报告（env 逃逸舱优先于 settings）", () => {
  it("STANDARD_CODE_THINKING=adaptive 时点名覆盖：local 档位 low 暂不生效、实际生效 high", async () => {
    const { session, ctx, cleanup } = fixture({ STANDARD_CODE_THINKING: "adaptive" });
    try {
      const r = await ctx.effort("low");
      expect(r.text).toContain("env override active: STANDARD_CODE_THINKING=adaptive");
      expect(r.text).toContain("effective=high"); // env 优先，实际生效档=high
      expect(session.thinking).toEqual({ type: "adaptive" }); // 下一 turn 生效值取自 env
    } finally {
      cleanup();
    }
  });

  it("无 env 覆盖时不出覆盖行（缺省形可判别）", async () => {
    const { ctx, cleanup } = fixture();
    try {
      const r = await ctx.effort("low");
      expect(r.text).not.toContain("env override active");
      expect(r.text).not.toContain("effective="); // 无 override 行（缺省形可判别）
    } finally {
      cleanup();
    }
  });
});

describe("既有语义保持（细化不得破坏 M3 基础版契约）", () => {
  it("非法档位仍点名报错 unknown effort；枚举与键位不变", async () => {
    const { ctx, cleanup } = fixture();
    try {
      await expect(ctx.effort("turbo")).rejects.toThrow(/unknown effort/);
      await expect(ctx.effort("auto")).rejects.toThrow(/unknown effort/); // 不引入第五档（§8.3 行 378）
    } finally {
      cleanup();
    }
  });
});
