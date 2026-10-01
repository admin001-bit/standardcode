// F29（2026-09-30 可用性实测）回归：/theme list 与 usage 对齐。
// 缺陷原形：i18n cmd.theme.usage 广告 `[<theme> | list]`，实现只认空参——`/theme list`
// 落 resolveTheme fail-closed 抛 "invalid theme: list"。
// 判别：list 返回当前主题＋全集清单；非法值仍 fail-closed（既有语义不动）。
import { describe, expect, it } from "vitest";
import { createSession, type SessionInit } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { THEMES } from "../src/theme.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("provider must not be called");
    },
    countTokens: async () => 0,
  } as unknown as ProviderAdapter;
}

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "stdcode-f29-"));
  // R1-4（全仓审查 2026-10-01，f28 同族）：传 home + 自钉 lang（英文串断言不随本机语言/真实设置漂移）
  const init: SessionInit = {
    provider: fakeProvider(),
    catalog: ["m-a"],
    model: "m-a",
    cwd,
    projectRoot: cwd,
    home: path.join(cwd, "home"),
    env: { ...process.env, STANDARD_CODE_LANG: "en" },
  };
  const session = createSession(init);
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: () => {}, close: () => {} } as unknown as ReplDeps["io"] };
  const ctx = createCommandContext(deps);
  return { ctx, cwd };
}

describe("F29 /theme list 口径对齐", () => {
  it("list 返回当前主题＋全集清单，不抛错", async () => {
    const { ctx, cwd } = fixture();
    try {
      const r = await ctx.theme("list");
      for (const t of THEMES) expect(r.text).toContain(t); // 全集相等纪律：plain/light/dark 逐一在列
      expect(r.text).toContain("*"); // 当前主题标记
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("非法主题仍 fail-closed 抛错（既有语义不动）", async () => {
    const { ctx, cwd } = fixture();
    try {
      await expect(ctx.theme("blue")).rejects.toThrow(/invalid theme/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
