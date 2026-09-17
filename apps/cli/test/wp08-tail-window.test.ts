// WP-08（M5）DoD③：auto 更新通知尾窗形制——readline 宿主在位=行重绘通道（清行+写+prompt(true) 保留
// 已输入缓冲）；无宿主=回落 write。M4 WP-08 未解决②清偿（并发书写乱码处置 [自定] 择一=行重绘）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { startAutoUpdateCheck, type ReplDeps, type UpdateDeps } from "../src/repl.ts";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream() {
      throw new Error("not used");
    },
    countTokens: async () => 0,
  };
}

function fixture(update: UpdateDeps & { env?: NodeJS.ProcessEnv }, redrawNotice?: (line: string) => void) {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
  const written: string[] = [];
  const redrawn: string[] = [];
  const deps: ReplDeps = {
    session,
    io: {
      lines: (async function* () {})(),
      write: (s) => void written.push(s),
      close: () => {},
      ...(redrawNotice ? { redrawNotice: (l: string) => void redrawn.push(l) } : {}),
    },
    update,
  };
  return { deps, written, redrawn };
}

const NEWER: UpdateDeps = { currentVersion: "1.2.3", check: async () => ({ ok: true, latest: "9.9.9" }) };

describe("DoD③ auto 通知尾窗形制（M4 未解决②清偿）", () => {
  it("readline 宿主在位：redrawNotice 承载通知（write 零尾窗），清行+重绘由宿主实现", async () => {
    const { deps, written, redrawn } = fixture(NEWER, (line) => {
      // 模拟 main.ts 宿主形制：清当前行→写通知→prompt(true)（stub 只记录）
      written.push("REDRAW:" + line);
    });
    await startAutoUpdateCheck(deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(redrawn.length).toBe(1);
    expect(redrawn[0]).toContain("9.9.9");
    expect(written.filter((w) => !w.startsWith("REDRAW:"))).toHaveLength(0); // 通知不经 write=无并发尾窗
  });
  it("无宿主（测试/非 TTY）回落 write：行为与 M4 通知面零差", async () => {
    const { deps, written, redrawn } = fixture(NEWER);
    await startAutoUpdateCheck(deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(redrawn).toHaveLength(0);
    expect(written.length).toBe(1);
    expect(written[0]).toContain("9.9.9");
  });
  it("同版不通知（两通道皆静默）+env 缺省关=零调用", async () => {
    const a = fixture({ currentVersion: "9.9.9", check: async () => ({ ok: true, latest: "9.9.9" }) }, () => {});
    await startAutoUpdateCheck(a.deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(a.redrawn).toHaveLength(0);
    expect(a.written).toHaveLength(0);
    const b = fixture(NEWER, () => {});
    await startAutoUpdateCheck(b.deps, {});
    expect(b.redrawn).toHaveLength(0);
    expect(b.written).toHaveLength(0);
  });
  it("检查失败静默（DoD③ 同族）——重绘通道不因异常破坏", async () => {
    const { deps, redrawn, written } = fixture({ currentVersion: "1.2.3", check: async () => ({ ok: false, reason: "x" }) }, () => {});
    await expect(startAutoUpdateCheck(deps, { STANDARD_CODE_AUTO_UPDATE: "1" })).resolves.toBeUndefined();
    expect(redrawn).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});
