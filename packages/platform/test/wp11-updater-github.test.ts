// WP-11（M7）：updater 双源——GitHub Releases 新源（附录 E 行 630 双源其二；ADR-0050）+npm 源复验（M5 已验链路）。
// 全离线（fetchImpl 注入桩，零真实网络）；判据双向：不稳定/降级源注入「假成功必红」针，防恒绿真空断言。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_GITHUB_LATEST_URL,
  DEFAULT_REGISTRY_LATEST_URL,
  GITHUB_API_ACCEPT,
  GITHUB_REPO_NAME,
  GITHUB_REPO_OWNER,
  NPM_PACKAGE_NAME,
  UPDATE_CHECK_TIMEOUT_MS,
  checkGitHubLatest,
  checkRegistryLatest,
  compareVersions,
  normalizeReleaseTag,
} from "../src/updater.ts";

/** 记录 (url, opts) 的 JSON 桩；ok/status/json 可分别构造（用于降级针）。 */
function ghFetch(body: unknown, ok = true, status = ok ? 200 : 404) {
  const seen: { url: string; opts?: RequestInit } = { url: "" };
  const f = (async (url: string | URL, opts?: RequestInit) => {
    seen.url = String(url);
    seen.opts = opts;
    return { ok, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("DoD① GitHub Releases 源·成功与 v 前缀归一（ADR-0050 决策 5）", () => {
  it("tag_name=v0.2.0 → latest=0.2.0；缺省 URL=本仓 owner/repo + /releases/latest；带 signal 与 accept 头", async () => {
    const { f, seen } = ghFetch({ tag_name: "v0.2.0", html_url: "https://github.com/x/y/releases/tag/v0.2.0" });
    const r = await checkGitHubLatest({ fetchImpl: f });
    expect(r).toEqual({ ok: true, latest: "0.2.0" });
    expect(seen.url).toBe(DEFAULT_GITHUB_LATEST_URL);
    expect(seen.url).toBe(`https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`);
    expect(seen.url).toContain("admin001-bit/standardcode");
    expect(seen.opts?.signal).toBeTruthy();
    expect(JSON.stringify(seen.opts?.headers)).toContain(GITHUB_API_ACCEPT);
  });
  it("URL 可注入（releasesUrl 覆写）+归一后与 compareVersions 同口径（v 前缀剥除不影响比对）", async () => {
    const { f, seen } = ghFetch({ tag_name: "V1.10.3" });
    const r = await checkGitHubLatest({ fetchImpl: f, releasesUrl: "https://example.test/releases/latest" });
    expect(r).toEqual({ ok: true, latest: "1.10.3" });
    expect(seen.url).toBe("https://example.test/releases/latest");
    expect(compareVersions("1.10.3", "1.9.9")).toBe(1); // 归一后走同一比对面
  });
  it("normalizeReleaseTag：v/V 剥一前缀+trim；无前导数字（latest/nightly/M6）→null（fail-closed）", () => {
    expect(normalizeReleaseTag("v0.2.0")).toBe("0.2.0");
    expect(normalizeReleaseTag("V1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseTag("  v0.2.0  ")).toBe("0.2.0");
    expect(normalizeReleaseTag("0.2.0")).toBe("0.2.0");
    expect(normalizeReleaseTag("0.2.0-beta.1")).toBe("0.2.0-beta.1");
    expect(normalizeReleaseTag("latest")).toBeNull();
    expect(normalizeReleaseTag("nightly")).toBeNull();
    expect(normalizeReleaseTag("M6")).toBeNull();
    expect(normalizeReleaseTag("vv0.2.0")).toBeNull(); // 双 v=非版本形
    expect(normalizeReleaseTag("")).toBeNull();
  });
});

describe("DoD① GitHub Releases 源·fail-closed 四态（ADR-0050 决策 4）", () => {
  it("非 2xx（404=本仓尚无 release）→ok:false 点名状态码；**针**：即便体含合法 tag_name 也不得成功", async () => {
    const r = await checkGitHubLatest({ fetchImpl: ghFetch({ tag_name: "v9.9.9" }, false, 404).f });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("404");
    const r500 = await checkGitHubLatest({ fetchImpl: ghFetch({ tag_name: "v9.9.9" }, false, 500).f });
    expect(r500.ok).toBe(false);
    if (!r500.ok) expect(r500.reason).toContain("500");
  });
  it("脏 JSON（json() 抛）→ok:false 点名；**针**：不得回退为 ok", async () => {
    const bad = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token <"); } })) as unknown as typeof fetch;
    const r = await checkGitHubLatest({ fetchImpl: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not JSON");
  });
  it("tag_name 缺失/非 string/空串 →ok:false 点名字段", async () => {
    for (const body of [{ name: "standardcode" }, { tag_name: 42 }, { tag_name: "   " }]) {
      const r = await checkGitHubLatest({ fetchImpl: ghFetch(body).f });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("tag_name");
    }
  });
  it("tag 非版本形（latest/M6）→ok:false 点名 tag（不静默取号）", async () => {
    for (const tag of ["latest", "M6", "nightly"]) {
      const r = await checkGitHubLatest({ fetchImpl: ghFetch({ tag_name: tag }).f });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(`not version-like: ${tag}`);
    }
  });
  it("fetch 抛错（网络异常形态）→ok:false reason 透传", async () => {
    const r = await checkGitHubLatest({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });
  it("超时真实触发：timeoutMs=5 + abort 监听桩→AbortSignal 到期静默降级（同 npm 源口径）", async () => {
    const r = await checkGitHubLatest({
      timeoutMs: 5,
      fetchImpl: ((url: string | URL, opts?: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout signal")));
        })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "aborted by timeout signal" });
  });
});

describe("DoD① 双源同形（npm registry 复验 + GitHub 并列；ADR-0050 决策 1/3）", () => {
  it("npm 源（M5 已验链路复跑）：version 成功 / 非 2xx / 超时三态同形", async () => {
    const okRes = await checkRegistryLatest({
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ version: "0.2.0" }) })) as unknown as typeof fetch,
    });
    expect(okRes).toEqual({ ok: true, latest: "0.2.0" });
    expect((await checkRegistryLatest({ fetchImpl: ghFetch({}, false, 404).f })).ok).toBe(false);
    const to = await checkRegistryLatest({
      timeoutMs: 5,
      fetchImpl: ((url: string | URL, opts?: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout signal")));
        })) as unknown as typeof fetch,
    });
    expect(to).toEqual({ ok: false, reason: "aborted by timeout signal" });
  });
  it("两源对同一版本返回同形 latest（版本策略一致时），且超时上限同量级（UPDATE_CHECK_TIMEOUT_MS 共用）", async () => {
    const npm = await checkRegistryLatest({
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ version: "0.2.0" }) })) as unknown as typeof fetch,
    });
    const gh = await checkGitHubLatest({ fetchImpl: ghFetch({ tag_name: "v0.2.0" }).f });
    expect(npm).toEqual(gh); // {ok:true, latest:"0.2.0"} —— 任一源漂移即红
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_REGISTRY_LATEST_URL).toContain(encodeURIComponent(NPM_PACKAGE_NAME));
    expect(DEFAULT_GITHUB_LATEST_URL).not.toBe(DEFAULT_REGISTRY_LATEST_URL);
  });
  it("单源收敛：产品仓仅一处登记 GitHub Releases 源（updater.ts；禁双份漂移）", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/updater.ts"), "utf8");
    const hits = src.match(/releases\/latest/g) ?? [];
    expect(hits.length).toBe(1);
    expect(src).toContain(`export const GITHUB_REPO_OWNER = "admin001-bit"`);
    expect(src).toContain(`export const GITHUB_REPO_NAME = "standardcode"`);
  });
});
