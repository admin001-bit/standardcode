// M8-WP-06（ADR-0053）：/update 接 GitHub Releases 源——三态（成功/404/超时）＋非法源值 fail-closed
// ＋npm 源既有路径零改动对照（DoD②③④；网络/子进程全注入桩，零真实请求）。
// 断言面＝命令 ctx.write 输出（/update 注册形制：execute 内 `ctx.write(r.text)`；既有测试同形）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import { createSession } from "../src/session.ts";
import { createCommandContext, type ReplDeps, type UpdateDeps } from "../src/repl.ts";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in update tests");
    },
    countTokens: async () => 0,
  };
}

function fixture(update: UpdateDeps) {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} }, update };
  return { deps, out, ctx: createCommandContext(deps) };
}

const updateCmd = CLI_COMMANDS.find((c) => c.name === "update")!;
const ghEnv = { STANDARD_CODE_UPDATE_SOURCE: "github" };

describe("M8-WP-06 DoD② GitHub 源成功态（只报告不安装）", () => {
  it("有新版：报告 latest＋明示本源不安装＋两条安装通道；零 npm 执行", async () => {
    let npmCalls = 0;
    let githubCalls = 0;
    const { ctx, out } = fixture({
      env: ghEnv,
      currentVersion: "0.1.0",
      checkGitHub: async () => {
        githubCalls++;
        return { ok: true, latest: "0.2.0" };
      },
      check: async () => {
        throw new Error("npm 源不应被调用");
      },
      runNpm: async () => {
        npmCalls++;
        return { status: 0 };
      },
    });
    await updateCmd.execute("", ctx);
    const text = out.join("");
    expect(githubCalls).toBe(1);
    expect(npmCalls).toBe(0); // 决策 3：GitHub 源不含安装动作
    expect(text).toContain("new version 0.2.0 (current 0.1.0)");
    expect(text).toContain("GitHub Releases reports versions only (no install)");
    expect(text).toContain("npm i -g @standardcode-oss/cli@latest");
    expect(text).toContain("https://github.com/admin001-bit/standardcode/releases/latest");
  });

  it("同版（真实 Release 形：tag v0.1.0 归一后＝当前 0.1.0）：已是最新，零安装", async () => {
    let npmCalls = 0;
    const { ctx, out } = fixture({ env: ghEnv, currentVersion: "0.1.0", checkGitHub: async () => ({ ok: true, latest: "0.1.0" }), runNpm: async () => { npmCalls++; return { status: 0 }; } });
    await updateCmd.execute("", ctx);
    expect(out.join("")).toContain("already up to date — current 0.1.0 (GitHub Releases latest: 0.1.0)");
    expect(npmCalls).toBe(0);
  });
});

describe("M8-WP-06 DoD③ 失败两态 fail-closed", () => {
  it("404（releases 为空/资源不存在）→ 抛错点名源与 reason", async () => {
    const { ctx } = fixture({ env: ghEnv, checkGitHub: async () => ({ ok: false, reason: "github releases responded HTTP 404" }) });
    await expect(updateCmd.execute("", ctx)).rejects.toThrow(/GitHub Releases latest-release query failed[\s\S]*HTTP 404[\s\S]*npm i -g @standardcode-oss\/cli@latest/);
  });

  it("超时（AbortSignal.timeout 抛错透传）→ 抛错点名 reason", async () => {
    const { ctx } = fixture({ env: ghEnv, checkGitHub: async () => ({ ok: false, reason: "The operation was aborted due to timeout" }) });
    await expect(updateCmd.execute("", ctx)).rejects.toThrow(/query failed[\s\S]*aborted due to timeout/);
  });

  it("非法源值 → fail-closed 点名原值（不静默回落 npm）", async () => {
    const { ctx } = fixture({ env: { STANDARD_CODE_UPDATE_SOURCE: "gh" }, check: async () => ({ ok: true, latest: "9.9.9" }) });
    await expect(updateCmd.execute("", ctx)).rejects.toThrow(/STANDARD_CODE_UPDATE_SOURCE has an invalid value[\s\S]*got "gh"[\s\S]*npm \| github/);
  });
});

describe("M8-WP-06 DoD④ npm 源既有路径零改动对照", () => {
  it("无 env（缺省）→ 走既有 npm 路（文案与安装动作逐字不变；github 探针零调用）", async () => {
    let githubCalls = 0;
    let npmCalls = 0;
    const { ctx, out } = fixture({
      currentVersion: "1.2.3",
      check: async () => ({ ok: true, latest: "9.9.9" }),
      checkGitHub: async () => {
        githubCalls++;
        return { ok: true, latest: "9.9.9" };
      },
      runNpm: async () => {
        npmCalls++;
        return { status: 0 };
      },
    });
    await updateCmd.execute("", ctx);
    expect(githubCalls).toBe(0);
    expect(npmCalls).toBe(1);
    expect(out[0]).toContain("new version 9.9.9 (current 1.2.3) — running: npm i -g @standardcode-oss/cli@latest");
    expect(out[out.length - 1]).toContain("installed 9.9.9 — restart standardcode");
  });

  it("env=npm（显式）→ 仍走既有 npm 路（大小写/空白归一形）", async () => {
    let npmCalls = 0;
    const { ctx, out } = fixture({ env: { STANDARD_CODE_UPDATE_SOURCE: " NPM " }, currentVersion: "9.9.9", check: async () => ({ ok: true, latest: "9.9.9" }), runNpm: async () => { npmCalls++; return { status: 0 }; } });
    await updateCmd.execute("", ctx);
    expect(out.join("")).toContain("already up to date — current 9.9.9 (registry latest: 9.9.9)");
    expect(npmCalls).toBe(0);
  });

  it("/update 无参契约不变（既有断言面零改）", async () => {
    const { ctx } = fixture({ currentVersion: "1.0.0", check: async () => ({ ok: true, latest: "1.0.0" }) });
    await expect(updateCmd.execute("github", ctx)).rejects.toThrow("takes no arguments");
  });
});
