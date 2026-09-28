// F12（2026-09-29 真机实测）修复回归：压缩协调器的窗口须随**模型能力窗口**（原缺 modelDefault → 落
// UNKNOWN_MODEL_ASSUMED_WINDOW=200k，与网格/模型真实的 128k 不一致：128k–192k 区间压缩门恒拒，
// 长会话超限只会 context_exhausted，自动压缩永不触发）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function stubProvider(ctx: number): ProviderAdapter {
  return {
    capabilities: () => ({
      contextWindow: ctx,
      maxOutputTokens: { default: 8192, upper: 8192 },
      thinking: "none",
      input: ["text"] as Array<"text" | "image" | "video" | "audio">,
      streaming: true,
      toolCalling: true,
      cache: { ttlLevels: [], explicitBreakpoints: false },
    }),
    countTokens: async () => 0,
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("unused in this test");
    },
  };
}

function sessionWith(ctx: number) {
  const dir = mkdtempSync(join(tmpdir(), "sc-f12-"));
  dirs.push(dir);
  return createSession({ provider: stubProvider(ctx), model: "m", catalog: ["m"], cwd: dir, home: dir, env: {} });
}

describe("压缩协调器窗口接线（F12 修复）", () => {
  it("128k 模型：125k 占用即达压缩阈（应压缩）", () => {
    const s = sessionWith(128_000);
    expect(s.autocompact.evaluate(125_000, 1).shouldCompact).toBe(true);
  });

  it("对照：200k 模型同值不触发（窗口差异确实生效，非恒定真）", () => {
    const s = sessionWith(200_000);
    expect(s.autocompact.evaluate(125_000, 1).shouldCompact).toBe(false);
  });

  it("未知模型（capabilities 抛错）：保持假定窗口兜底（fail-open 语义不回归）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-f12-"));
    dirs.push(dir);
    const p = stubProvider(1);
    p.capabilities = () => {
      throw new Error("unknown model");
    };
    const s = createSession({ provider: p, model: "unknown-m", catalog: ["unknown-m"], cwd: dir, home: dir, env: {} });
    expect(s.autocompact.evaluate(125_000, 1).shouldCompact).toBe(false); // 假定 200k → 未达阈
  });
});
