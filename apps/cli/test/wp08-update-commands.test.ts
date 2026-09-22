// M4-WP-08：/update 命令面+启动后台检查 glue 单测（DoD①②③④⑤；网络/子进程全注入桩，零真实请求）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { NPM_INSTALL_ARGS } from "@standardcode/platform";
import { CLI_COMMANDS } from "../src/commands.ts";
import { createSession } from "../src/session.ts";
import { createCommandContext, startAutoUpdateCheck, type ReplDeps, type UpdateDeps } from "../src/repl.ts";

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

describe("DoD① /update 命令四态（手动路=检查+提示+执行；失败=ADR-0034 三件套+手动兜底）", () => {
  it("同版/落后 → 显示当前不执行安装", async () => {
    let npmCalls = 0;
    const { ctx, out } = fixture({ currentVersion: "9.9.9", check: async () => ({ ok: true, latest: "9.9.9" }), runNpm: async () => { npmCalls++; return { status: 0 }; } });
    await updateCmd.execute("", ctx);
    expect(out.join("")).toContain("already up to date — current 9.9.9 (registry latest: 9.9.9)");
    expect(npmCalls).toBe(0);
    // 落后（dev 版高于 registry）同路：compare<=0 静默于安装
    const f2 = fixture({ currentVersion: "99.0.0", check: async () => ({ ok: true, latest: "9.9.9" }), runNpm: async () => { npmCalls++; return { status: 0 }; } });
    await updateCmd.execute("", f2.ctx);
    expect(f2.out.join("")).toContain("already up to date");
    expect(npmCalls).toBe(0);
  });
  it("新版 → 提示先上屏，再执行安装；成功=重启提示", async () => {
    let npmCalls = 0;
    const { ctx, out } = fixture({
      currentVersion: "1.2.3",
      check: async () => ({ ok: true, latest: "9.9.9" }),
      runNpm: async () => { npmCalls++; return { status: 0 }; },
    });
    await updateCmd.execute("", ctx);
    expect(npmCalls).toBe(1);
    expect(out[0]).toContain("new version 9.9.9 (current 1.2.3) — running: npm i -g @standardcode-oss/cli@latest"); // 提示先于执行（[自定] 写入时机）
    expect(out[out.length - 1]).toContain("installed 9.9.9 — restart standardcode");
  });
  it("安装失败（含 Windows 文件锁 EBUSY 形态）→ 三件套+手动兜底（发生了什么/为什么/建议）", async () => {
    const { ctx } = fixture({
      currentVersion: "1.2.3",
      check: async () => ({ ok: true, latest: "9.9.9" }),
      runNpm: async () => ({ status: 1, stderrTail: "npm ERR! code EBUSY: resource busy or locked, rename standardcode" }),
    });
    await expect(updateCmd.execute("", ctx)).rejects.toThrow(/install failed[\s\S]*what happened[\s\S]*why:[\s\S]*EBUSY[\s\S]*suggestion[\s\S]*npm i -g @standardcode-oss\/cli@latest/);
  });
  it("查询失败 → 三件套（不静默于手动路）", async () => {
    const { ctx } = fixture({ currentVersion: "1.2.3", check: async () => ({ ok: false, reason: "registry responded HTTP 500" }) });
    await expect(updateCmd.execute("", ctx)).rejects.toThrow(/check failed[\s\S]*HTTP 500[\s\S]*suggestion/);
  });
  it("带参拒绝（无子命令面 [自定]）", async () => {
    const { ctx } = fixture({ check: async () => ({ ok: true, latest: "9.9.9" }) });
    await expect(updateCmd.execute("--force", ctx)).rejects.toThrow("/update takes no arguments");
  });
  it("缺省接线（注入 fetch+runner）：facade 走 platform 真面——SEC-080 剥离同面+命令全硬编码 DoD①", async () => {
    let seenEnv: NodeJS.ProcessEnv | null = null;
    let seenArgs: readonly string[] | null = null;
    const { ctx, out } = fixture({
      currentVersion: "1.2.3",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ version: "9.9.9" }) })) as unknown as typeof fetch,
      runner: (async (_cmd, args, env) => {
        seenArgs = args;
        seenEnv = env;
        return { status: 0 };
      }),
      env: { PATH: "/usr/bin", STANDARD_CODE_AUTO_UPDATE: "1", MY_SECRET: "x" },
    });
    await updateCmd.execute("", ctx);
    expect(out[out.length - 1]).toContain("installed 9.9.9");
    expect(seenArgs).toEqual([...NPM_INSTALL_ARGS]); // ["i","-g","@standardcode-oss/cli@latest"]
    expect(seenEnv!.PATH).toBe("/usr/bin");
    expect(seenEnv!.STANDARD_CODE_AUTO_UPDATE).toBeUndefined(); // SEC-080 基线剥离（env-baseline 共享面）
    expect(seenEnv!.MY_SECRET).toBeUndefined();
  });
});

describe("DoD②③④ startAutoUpdateCheck（启动后台非阻塞检查）", () => {
  it("env 未设=零请求（DoD④ 缺省关）；非 \"1\" 值同样关（取严 [自定]）", async () => {
    let calls = 0;
    const mk = (env: NodeJS.ProcessEnv) => fixture({ check: async () => { calls++; return { ok: true, latest: "9.9.9" }; }, currentVersion: "0.1.0", env });
    await startAutoUpdateCheck(mk({}).deps, {});
    await startAutoUpdateCheck(mk({ STANDARD_CODE_AUTO_UPDATE: "0" }).deps, { STANDARD_CODE_AUTO_UPDATE: "0" });
    await startAutoUpdateCheck(mk({ STANDARD_CODE_AUTO_UPDATE: "yes" }).deps, { STANDARD_CODE_AUTO_UPDATE: "yes" });
    expect(calls).toBe(0);
  });
  it("=1 且新版=仅一行提示，不自动安装（边界\"不静默安装\"）", async () => {
    let npmCalls = 0;
    const f = fixture({
      currentVersion: "0.1.0",
      check: async () => ({ ok: true, latest: "9.9.9" }),
      runNpm: async () => { npmCalls++; return { status: 0 }; },
    });
    await startAutoUpdateCheck(f.deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(f.out.filter((l) => l.includes("new version 9.9.9"))).toHaveLength(1);
    expect(f.out.join("")).toContain("run /update to install");
    expect(npmCalls).toBe(0);
  });
  it("=1 同版/落后 → 零提示；查询失败 → 静默不影响会话（DoD③）；桩抛错亦静默", async () => {
    const same = fixture({ currentVersion: "9.9.9", check: async () => ({ ok: true, latest: "9.9.9" }) });
    await startAutoUpdateCheck(same.deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(same.out).toEqual([]);
    const failed = fixture({ currentVersion: "0.1.0", check: async () => ({ ok: false, reason: "HTTP 500" }) });
    await startAutoUpdateCheck(failed.deps, { STANDARD_CODE_AUTO_UPDATE: "1" });
    expect(failed.out).toEqual([]);
    const thrown = fixture({ currentVersion: "0.1.0", check: () => Promise.reject(new Error("socket hang up")) });
    await expect(startAutoUpdateCheck(thrown.deps, { STANDARD_CODE_AUTO_UPDATE: "1" })).resolves.toBeUndefined();
    expect(thrown.out).toEqual([]);
  });
});

describe("DoD⑤ 命令清单 34 适配", () => {
  it("/update=M4 末件注册（§8.2 M4 五件全；M7-WP-01 /goal 30→31，2026-09-19；Tab 候选含之——双义面钉在 wp10/tab-complete 测试）", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(names).toHaveLength(34);
    expect(names[names.length - 1]).toBe("sandbox"); // M7-WP-06 /sandbox=第 34 件（尾项随清单递增，2026-09-23）
  });
});
