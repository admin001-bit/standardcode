// M4-WP-08：platform updater 单测（DoD① registry 查询/版本比对+SEC-080 共享剥离面+npm 执行注入面）。
// 全离线桩（fetchImpl/runner 注入，卡交付物"网络注入面离线测试"）；零真实网络/子进程。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUTO_UPDATE_ENV_KEY,
  DEFAULT_REGISTRY_LATEST_URL,
  NPM_INSTALL_ARGS,
  NPM_PACKAGE_NAME,
  UPDATE_CHECK_TIMEOUT_MS,
  checkRegistryLatest,
  compareVersions,
  npmCliCommand,
  runNpmUpdate,
} from "../src/updater.ts";
import { stripEnvBaseline } from "../src/env-baseline.ts";

function jsonFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

describe("DoD①：checkRegistryLatest（npm registry 通道——附录 E）", () => {
  it("成功：返回 latest；缺省 URL=scoped 包名 percent-encode+/latest；带 signal（超时接线）与 accept 头", async () => {
    let seenUrl = "";
    let seenOpts: RequestInit | undefined;
    const f = (async (url: string | URL, opts?: RequestInit) => {
      seenUrl = String(url);
      seenOpts = opts;
      return { ok: true, status: 200, json: async () => ({ version: "9.9.9" }) };
    }) as unknown as typeof fetch;
    const r = await checkRegistryLatest({ fetchImpl: f });
    expect(r).toEqual({ ok: true, latest: "9.9.9" });
    expect(seenUrl).toBe(DEFAULT_REGISTRY_LATEST_URL);
    expect(seenUrl).toContain(encodeURIComponent(NPM_PACKAGE_NAME)); // @standardcode%2Fcli
    expect(seenUrl.endsWith("/latest")).toBe(true);
    expect(seenOpts?.signal).toBeTruthy();
    expect(JSON.stringify(seenOpts?.headers)).toContain("application/json");
  });
  it("HTTP 非 2xx → ok:false（不抛）", async () => {
    const r = await checkRegistryLatest({ fetchImpl: jsonFetch({}, false) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("500");
  });
  it("响应体非 JSON → ok:false；无 string version 字段 → ok:false", async () => {
    const badJson = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token <"); } })) as unknown as typeof fetch;
    expect(await checkRegistryLatest({ fetchImpl: badJson })).toMatchObject({ ok: false });
    const noVersion = await checkRegistryLatest({ fetchImpl: jsonFetch({ name: NPM_PACKAGE_NAME }) });
    expect(noVersion).toMatchObject({ ok: false });
    if (!noVersion.ok) expect(noVersion.reason).toContain("version");
  });
  it("fetch 抛错（网络异常形态）→ ok:false reason 透传", async () => {
    const r = await checkRegistryLatest({
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });
  it("超时真实触发：永不 resolve 的 fetch+timeoutMs=5 → AbortSignal 到期静默降级（DoD③）", async () => {
    const r = await checkRegistryLatest({
      timeoutMs: 5,
      fetchImpl: ((url: string | URL, opts?: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout signal")));
        })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "aborted by timeout signal" });
  });
  it("缺省常量在位：超时 10s（DoD③ [自定] 上限）；env 键对位附录 C 行 616", () => {
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(10_000);
    expect(AUTO_UPDATE_ENV_KEY).toBe("STANDARD_CODE_AUTO_UPDATE");
  });
});

describe("DoD①：compareVersions（三段数值简式 [自定]）", () => {
  it("相等/领先/落后三段逐位比较，缺位补 0，容忍 v 前缀与脏值", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1); // 数值位非字典序
    expect(compareVersions("0.9.9", "0.10.0")).toBe(-1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0); // 缺位补 0
    expect(compareVersions("1.0.0", "abc")).toBe(1); // 脏值=零段
  });
});

describe("DoD①：SEC-080 env 基线剥离（共享面=installer git clone 与 updater npm 同面）", () => {
  it("STANDARD_CODE_*/KEY/TOKEN/SECRET/GIT_CONFIG_*/NODE_OPTIONS/BASH_ENV/ENV 剥除；PATH/HOME 保留", () => {
    const out = stripEnvBaseline({
      PATH: "/usr/bin",
      HOME: "/h",
      STANDARD_CODE_AUTO_UPDATE: "1",
      STANDARD_CODE_API_KEY: "k",
      OPENAI_API_KEY: "secret",
      GH_TOKEN: "t",
      AWS_SECRET: "s",
      GIT_CONFIG_GLOBAL: "/x",
      NODE_OPTIONS: "--inspect",
      BASH_ENV: "/evil",
      ENV: "prod",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH"]);
  });
  it("共享化回归：installer 与 updater 均消费 env-baseline（就地实现清出，禁双份漂移）", () => {
    const installerSrc = readFileSync(path.resolve(import.meta.dirname, "../src/plugin/installer.ts"), "utf8");
    const updaterSrc = readFileSync(path.resolve(import.meta.dirname, "../src/updater.ts"), "utf8");
    expect(installerSrc).toContain('import { stripEnvBaseline } from "../env-baseline.ts"');
    expect(installerSrc).not.toContain("GIT_ENV_STRIP");
    expect(updaterSrc).toContain('import { stripEnvBaseline } from "./env-baseline.ts"');
  });
});

describe("DoD①：runNpmUpdate（子进程注入面+全硬编码零用户输入 [自定]）", () => {
  it("win32→npm.cmd；其余→npm", () => {
    expect(npmCliCommand("win32")).toBe("npm.cmd");
    expect(npmCliCommand("linux")).toBe("npm");
    expect(npmCliCommand("darwin")).toBe("npm");
  });
  it("缺省命令=i -g @standardcode/cli@latest；env 源过 SEC-080 剥离后交付 runner", async () => {
    let seen: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv } | null = null;
    const r = await runNpmUpdate({
      platform: "linux",
      env: { PATH: "/usr/bin", STANDARD_CODE_AUTO_UPDATE: "1", MY_TOKEN: "secret" },
      runner: (async (cmd, args, env) => {
        seen = { cmd, args, env };
        return { status: 0 };
      }),
    });
    expect(r.status).toBe(0);
    expect(seen).not.toBeNull();
    expect(seen!.cmd).toBe("npm");
    expect(seen!.args).toEqual(["i", "-g", `${NPM_PACKAGE_NAME}@latest`]);
    expect(seen!.args).toEqual([...NPM_INSTALL_ARGS]);
    expect(seen!.env.PATH).toBe("/usr/bin");
    expect(seen!.env.STANDARD_CODE_AUTO_UPDATE).toBeUndefined();
    expect(seen!.env.MY_TOKEN).toBeUndefined();
  });
});
