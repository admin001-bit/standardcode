// M7-WP-03（主题体系 + /theme 命令）测试：DoD①②③ + 非法值 fail-closed + 渲染单源守卫。
// 断言形制：集合类用全集相等（toEqual 全量枚举）；缺省回落分支之外必须覆盖非缺省形（dark/light）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, type SessionInit } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import {
  THEMES,
  resolveTheme,
  colorize,
  setTheme,
  themeTokens,
  themeFromSettings,
  type Theme,
  type ThemeToken,
} from "../src/theme.ts";

const ESC = "\x1b";
const COLOR_RE = new RegExp(ESC + "\\[[0-9;]*m"); // ANSI SGR 颜色码（含 reset）；擦除码 [2K 不匹配（结尾非 m）

function fixture(cwd: string) {
  const init: SessionInit = { provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd };
  const session = createSession(init);
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, out, ctx };
}

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in theme tests");
    },
    countTokens: async () => 0,
  };
}

const TOKENS: ThemeToken[] = ["tool", "ok", "err", "recovery", "interrupted", "done"];

describe("主题单源（apps/cli/src/theme.ts 纯函数）", () => {
  it("THEMES 全集相等（plain 缺省 + light/dark 非缺省着色主题）", () => {
    expect(THEMES).toEqual(["plain", "light", "dark"]);
  });

  it("themeTokens：plain = 全空串映射（无着色）；light/dark = ANSI 码（非缺省形必覆盖）", () => {
    const plain = themeTokens("plain");
    for (const tk of TOKENS) expect(plain[tk]).toBe("");
    for (const t of ["light", "dark"] as Theme[]) {
      const pal = themeTokens(t);
      for (const tk of TOKENS) expect(COLOR_RE.test(pal[tk]), `${t}.${tk} 应着色`).toBe(true);
    }
  });

  it("resolveTheme：合法值通过；非法/未知值 fail-closed 抛错（不静默回落缺省）", () => {
    expect(resolveTheme("plain")).toBe("plain");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    for (const bad of ["", "neon", "DARK", "blue", "plain ", "dark\tx1b"]) {
      expect(() => resolveTheme(bad), `应拒非法主题 "${bad}"`).toThrow(/invalid theme/);
    }
  });

  it("colorize：plain 原样返回；dark/light 包裹 ANSI（非缺省形必覆盖，reset 收尾）", () => {
    setTheme("plain");
    expect(colorize("ok", "✓")).toBe("✓");
    setTheme("dark");
    const d = colorize("ok", "✓");
    expect(d.startsWith(ESC)).toBe(true);
    expect(d.endsWith(ESC + "[0m")).toBe(true);
    expect(d).toContain("✓");
    setTheme("light");
    const l = colorize("err", "✗");
    expect(l.startsWith(ESC)).toBe(true);
    expect(l.endsWith(ESC + "[0m")).toBe(true);
    setTheme("plain"); // 复位，避免污染其余用例
  });

  it("themeFromSettings：缺省=plain；ui.theme 合法=解析；非法=fail-closed 抛错（重启恢复入口可断言）", () => {
    const empty = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    expect(themeFromSettings(empty.settings)).toBe("plain");
    // 直接落盘合法值，模拟重启后 settings 装配
    const dir = mkdtempSync(path.join(tmpRoot(), "sc-theme-rec-"));
    try {
      const s = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd: dir, projectRoot: dir });
      writeLocalSetting(dir, "ui.theme", "light");
      s.reload();
      expect(themeFromSettings(s.settings)).toBe("light");
      // 非法落盘值 → 重启恢复 fail-closed
      writeLocalSetting(dir, "ui.theme", "neon");
      s.reload();
      expect(() => themeFromSettings(s.settings)).toThrow(/invalid theme/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/theme 命令（切换/持久化/重启恢复 + 非法 fail-closed）", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpRoot(), "sc-theme-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function themeCmd() {
    return CLI_COMMANDS.find((c) => c.name === "theme")!;
  }

  it("无参展示当前主题 + 可选主题（缺省=plain 标 *）", async () => {
    const { ctx, out } = fixture(cwd);
    await themeCmd().execute("", ctx);
    expect(out.join("\n")).toContain("[theme] current: plain");
    expect(out.join("\n")).toContain("* plain");
  });

  it("DoD①-切换：带参切换并回显", async () => {
    const { ctx, out } = fixture(cwd);
    await themeCmd().execute("dark", ctx);
    expect(out.join("\n")).toContain("[theme] set to dark");
  });

  it("DoD①-持久化：ui.theme 落盘 settings.local.json 且 session 合并可见（可查）", async () => {
    const { ctx, session } = fixture(cwd);
    await themeCmd().execute("dark", ctx);
    const file = path.join(cwd, ".standardcode", "settings.local.json");
    expect(existsSync(file)).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect((doc["ui"] as Record<string, unknown> | undefined)?.["theme"]).toBe("dark"); // 持久化落盘可查（ui.theme 为点路径嵌套）
    expect((session.settings.merged as Record<string, unknown>)["ui.theme"]).toBe("dark"); // reload 后合并可见
  });

  it("DoD①-重启恢复：新会话由 settings 装配解析出当前主题", async () => {
    const { ctx } = fixture(cwd);
    await themeCmd().execute("light", ctx);
    // 模拟重启：同 cwd 新建会话（从落盘 settings.local.json 装配）
    const reopened = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd });
    expect(themeFromSettings(reopened.settings)).toBe("light");
    // 新会话下 /theme 无参应展示恢复后的主题
    const out2: string[] = [];
    const ctx2 = createCommandContext({ session: reopened, io: { lines: (async function* () {})(), write: (s) => out2.push(s), close: () => {} } });
    await themeCmd().execute("", ctx2);
    expect(out2.join("\n")).toContain("[theme] current: light");
  });

  it("非法值 fail-closed 抛错（不静默回落缺省，且不写盘）", async () => {
    const { ctx } = fixture(cwd);
    await expect(themeCmd().execute("neon", ctx)).rejects.toThrow(/invalid theme/);
    const file = path.join(cwd, ".standardcode", "settings.local.json");
    expect(existsSync(file)).toBe(false); // 失败不落盘
  });
});

describe("DoD② 渲染单源守卫（grep 无散落硬编码色）", () => {
  // 白名单理由：theme.ts 是唯一颜色字面量单源（接缝㉔）；main.ts:207 的 \x1b[2K 是清行擦除码（非颜色，
  // 本正则 [0-9;]*m 不匹配），允许保留。其余 apps/cli/src 任何文件出现裸 ANSI 颜色码 → 本用例转红。
  it("apps/cli/src（除 theme.ts/main.ts）无裸 ANSI 颜色码；新增一处硬编码色可判别转红", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const WHITELIST = new Set(["theme.ts", "main.ts"]);
    const violations: string[] = [];
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      if (WHITELIST.has(f)) continue;
      const content = readFileSync(path.join(srcDir, f), "utf8");
      if (COLOR_RE.test(content)) violations.push(`${f}: 含裸 ANSI 颜色码`);
    }
    expect(violations, violations.join("; ")).toEqual([]);
  });
});

// —— 测试辅助 ——
function tmpRoot(): string {
  return tmpdir();
}
function writeLocalSetting(projectRoot: string, key: string, value: unknown): void {
  const file = path.join(projectRoot, ".standardcode", "settings.local.json");
  mkdirSync(path.dirname(file), { recursive: true });
  let doc: Record<string, unknown> = { schemaVersion: 1 };
  if (existsSync(file)) doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  doc[key] = value;
  doc.schemaVersion = 1;
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
}
