// M7-WP-08：/release-notes 命令面单测（DoD① 正常/缺文件/带参三例 + 只读断言 + 注册面 34→35）。
// 判据自足：数据源约定 [自定]=仓根 CHANGELOG.md（`## <version>` 节+条目行；ADR-0048）。
// 断言形制（承 WP-03/04/06 教训）：集合类用全集相等（toEqual 全量枚举）；凡有缺省回落/缺失分支
// 必须覆盖非缺省形（带参命中/前缀命中/未命中/多 token fail-closed）。正常用例用**测试内临时夹具**
// （tmp 项目根写 CHANGELOG），不得往产品仓提交伪造变更记录；只读断言=运行前后文件字节不变。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { CLI_VERSION } from "../src/version.ts";
import { parseChangelog, selectSection, normalizeVersion, CHANGELOG_FILENAME } from "../src/release-notes.ts";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in release-notes tests");
    },
    countTokens: async () => 0,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeTmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sc-rn-"));
  tmpDirs.push(d);
  return d;
}

/** 会话环境：lang 钉 en（文案断言确定化）；cwd/projectRoot=tmp 项目根（数据源定位面）。 */
function fixture(cwd: string) {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd, env: { STANDARD_CODE_LANG: "en" } });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  return { session, out, ctx: createCommandContext(deps) };
}

function rnCmd() {
  return CLI_COMMANDS.find((c) => c.name === "release-notes")!;
}

/** 夹具 CHANGELOG：当前版本节（CLI_VERSION）+ 更早版本节（0.0.9）。 */
function changelogFixture(): string {
  return `# Changelog\n\n## ${CLI_VERSION}\n\n- current release entry\n\n## 0.0.9\n\n- older release entry\n`;
}

describe("DoD① 三例（正常 / 缺文件 / 带参）", () => {
  it("正常：含当前版本节+更早版本节 → 输出含当前版本号与条目；运行前后文件字节不变（只读）", async () => {
    const cwd = makeTmp();
    const file = path.join(cwd, CHANGELOG_FILENAME);
    writeFileSync(file, changelogFixture(), "utf8");
    const before = readFileSync(file);
    const { ctx, out } = fixture(cwd);
    await rnCmd().execute("", ctx);
    const text = out.join("");
    expect(text).toContain(`current version: ${CLI_VERSION}`); // 当前版本（CLI_VERSION 单源）
    expect(text).toContain("- current release entry"); // 当前版本节条目
    expect(text).toContain("0.0.9"); // 更早版本名（older 列表，非静默）
    // 只读：运行前后文件字节不变 + 目录零新增文件
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(cwd)).toEqual([CHANGELOG_FILENAME]);
  });

  it("缺文件：tmp 项目根无 CHANGELOG → 明报约定文案 + 退出正常（不抛未捕获异常）", async () => {
    const cwd = makeTmp();
    const { ctx, out } = fixture(cwd);
    await expect(rnCmd().execute("", ctx)).resolves.toBeUndefined(); // 不抛
    const text = out.join("");
    expect(text).toContain(CHANGELOG_FILENAME);
    expect(text).toContain(path.join(cwd, CHANGELOG_FILENAME)); // 明报读哪个文件（绝对路径）
    expect(text).toMatch(/## <version>|- /); // 明报如何维护（节头/条目形）
    expect(readdirSync(cwd)).toEqual([]); // 零落地：不得自动创建文件
  });

  it("带参：命中某版本节（含 v 前缀与唯一前缀匹配）；未命中版本=明报不静默", async () => {
    const cwd = makeTmp();
    writeFileSync(path.join(cwd, CHANGELOG_FILENAME), changelogFixture(), "utf8");
    const { ctx, out } = fixture(cwd);

    // 精确命中（更早版本节）
    await rnCmd().execute("0.0.9", ctx);
    expect(out.join("")).toContain("- older release entry");
    // 非缺省形：`v` 前缀归一化命中
    const f2 = fixture(cwd);
    await rnCmd().execute(`v${CLI_VERSION}`, f2.ctx);
    expect(f2.out.join("")).toContain("- current release entry");
    // 非缺省形：唯一前缀命中（"0.0" 仅匹配 0.0.9）
    const f3 = fixture(cwd);
    await rnCmd().execute("0.0", f3.ctx);
    expect(f3.out.join("")).toContain("- older release entry");

    // 未命中：明报（值 + 可用列表），仍不抛
    const miss = fixture(cwd);
    await expect(rnCmd().execute("9.9.9", miss.ctx)).resolves.toBeUndefined();
    const missText = miss.out.join("");
    expect(missText).toContain("not found");
    expect(missText).toContain("9.9.9");
    expect(missText).toContain("0.0.9"); // 可用列表
    // 多 token = fail-closed 抛错
    const bad = fixture(cwd);
    await expect(rnCmd().execute("a b", bad.ctx)).rejects.toThrow(/unknown \/release-notes argument: a b/);
  });
});

describe("纯函数面（parseChangelog / selectSection：集合类全集相等）", () => {
  it("parseChangelog：仅识别 `## <version>` 节；节外一级标题忽略；`###` 子标题留作条目；空行忽略", () => {
    const text = "# Changelog\n\npreamble\n\n## 1.2.0\n\n- a\n\n### Added\n- b\n\n## 1.1.0\n- c\n";
    expect(parseChangelog(text)).toEqual([
      { version: "1.2.0", entries: ["- a", "### Added", "- b"] },
      { version: "1.1.0", entries: ["- c"] },
    ]);
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\nno sections here\n")).toEqual([]);
  });

  it("selectSection：精确优先→唯一前缀→多义/空=undefined（不猜）", () => {
    const secs = parseChangelog("## 2.0.0\n- x\n## 2.0.1\n- y\n## 1.9.0\n- z\n");
    expect(selectSection(secs, "2.0.1")).toEqual({ version: "2.0.1", entries: ["- y"] });
    expect(selectSection(secs, "v2.0.1")).toEqual({ version: "2.0.1", entries: ["- y"] });
    expect(selectSection(secs, "1.9.0")).toEqual({ version: "1.9.0", entries: ["- z"] });
    expect(selectSection(secs, "2.0.1 ")).toEqual({ version: "2.0.1", entries: ["- y"] });
    expect(selectSection(secs, "2.0")).toBeUndefined(); // 前缀命中两个=多义不猜
    expect(selectSection(secs, "9.9.9")).toBeUndefined();
    expect(selectSection(secs, "")).toBeUndefined();
    expect(normalizeVersion("  V2.0.1 ")).toBe("2.0.1");
  });
});

describe("DoD② 注册面（CLI_COMMANDS 34→35，末位）", () => {
  it("/release-notes 第 35 件且尾位；全集恰 35", () => {
    expect(CLI_COMMANDS).toHaveLength(35);
    expect(CLI_COMMANDS.at(-1)!.name).toBe("release-notes");
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("release-notes");
    expect(rnCmd().usage).toBe("[<version>]");
  });
});
