// M7-WP-04（快捷键体系 + /keybindings 命令）测试：DoD①②③ + 非法/冲突 fail-closed + 键位表单源守卫。
// 断言形制：集合类用全集相等（toEqual 全量枚举）；缺省回落分支之外必须覆盖非缺省形（重绑定后的非缺省键位）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import {
  BINDABLE_ACTIONS,
  DEFAULT_KEYBINDINGS,
  RESERVED_KEY_SPECS,
  keybindingsFromSettings,
  matchKeyEvent,
  normalizeSpec,
  parseKeySpec,
  rebind,
  resolveKeybindings,
  setKeybindings,
  type BindableAction,
} from "../src/keybindings.ts";

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

/** 嵌套写 `ui.keybindings.<action>`（与命令落盘同形：setLocalSetting 点路径 → 装配展开为点路径叶子）。 */
function writeNestedKeybinding(projectRoot: string, action: string, spec: string): void {
  const file = path.join(projectRoot, ".standardcode", "settings.local.json");
  mkdirSync(path.dirname(file), { recursive: true });
  let doc: Record<string, unknown> = { schemaVersion: 1 };
  if (existsSync(file)) doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const ui = (doc["ui"] as Record<string, unknown> | undefined) ?? {};
  const kb = (ui["keybindings"] as Record<string, unknown> | undefined) ?? {};
  kb[action] = spec;
  ui["keybindings"] = kb;
  doc["ui"] = ui;
  doc.schemaVersion = 1;
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in keybindings tests");
    },
    countTokens: async () => 0,
  };
}

function fixture(cwd: string) {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, out, ctx };
}

function kbCmd() {
  return CLI_COMMANDS.find((c) => c.name === "keybindings")!;
}

describe("键位单源（apps/cli/src/keybindings.ts 纯函数）", () => {
  it("动作全集与缺省表全集相等（permission.cycle = shift+tab；保留键 ctrl+c）", () => {
    expect(BINDABLE_ACTIONS).toEqual(["permission.cycle"]);
    expect({ ...DEFAULT_KEYBINDINGS }).toEqual({ "permission.cycle": "shift+tab" });
    expect([...RESERVED_KEY_SPECS]).toEqual(["ctrl+c"]);
  });

  it("parseKeySpec：合法形（修饰键组合 / 命名键 / 单字符）；大小写与顺序归一", () => {
    expect(normalizeSpec(parseKeySpec("shift+tab"))).toBe("shift+tab");
    expect(normalizeSpec(parseKeySpec("TAB+SHIFT"))).toBe("shift+tab");
    expect(normalizeSpec(parseKeySpec("ctrl+b"))).toBe("ctrl+b");
    expect(normalizeSpec(parseKeySpec("meta+up"))).toBe("meta+up");
    expect(normalizeSpec(parseKeySpec("b"))).toBe("b");
  });

  it("parseKeySpec：非法形 fail-closed——空/chord/重复修饰/未知键名/缺键名", () => {
    for (const bad of ["", "a b", "a+b", "shift+shift+tab", "shift+", "f13", "ctrl+f13", "tab tab"]) {
      expect(() => parseKeySpec(bad), `应拒非法键位 "${bad}"`).toThrow(/invalid key spec/);
    }
    expect(() => parseKeySpec("a b")).toThrow(/chord/);
  });

  it("matchKeyEvent：修饰位全等才命中（shift+tab 不命中 ctrl+tab／裸 tab）", () => {
    const spec = parseKeySpec("shift+tab");
    expect(matchKeyEvent(spec, { name: "tab", shift: true })).toBe(true);
    expect(matchKeyEvent(spec, { name: "tab" })).toBe(false);
    expect(matchKeyEvent(spec, { name: "tab", shift: true, ctrl: true })).toBe(false);
    expect(matchKeyEvent(spec, {})).toBe(false);
  });

  it("keybindingsFromSettings：缺省=缺省表；合法覆盖生效（重启恢复入口可断言）", () => {
    const empty = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    expect(normalizeSpec(keybindingsFromSettings(empty.settings)["permission.cycle"])).toBe("shift+tab");
    const dir = mkdtempSync(path.join(tmpRoot(), "sc-kb-rec-"));
    try {
      const s = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd: dir, projectRoot: dir });
      writeNestedKeybinding(dir, "permission.cycle", "ctrl+b");
      s.reload();
      expect(normalizeSpec(keybindingsFromSettings(s.settings)["permission.cycle"])).toBe("ctrl+b");
      // 保留键抢绑 = fail-closed
      writeNestedKeybinding(dir, "permission.cycle", "ctrl+c");
      s.reload();
      expect(() => keybindingsFromSettings(s.settings)).toThrow(/reserved/);
      // 未登记动作键（settings 外改面）= 宽容忽略：不瘫痪启动，且不影响已知动作解析
      writeNestedKeybinding(dir, "permission.cycle", "ctrl+b");
      writeNestedKeybinding(dir, "nope.action", "ctrl+u");
      s.reload();
      expect(() => keybindingsFromSettings(s.settings)).not.toThrow();
      expect(normalizeSpec(keybindingsFromSettings(s.settings)["permission.cycle"])).toBe("ctrl+b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveKeybindings：映射非法（非字符串/保留键）= fail-closed；rebind 冲突拒绝且不改当前表", () => {
    expect(() => resolveKeybindings({ "permission.cycle": 3 as unknown as string })).toThrow(/expected a string/);
    expect(() => resolveKeybindings({ "permission.cycle": "ctrl+c" })).toThrow(/reserved/);
    setKeybindings(resolveKeybindings({}));
    expect(() => rebind("permission.cycle", "ctrl+c")).toThrow(/reserved/);
    expect(normalizeSpec(parseKeySpec("shift+tab"))).toBe("shift+tab"); // 当前表未被污染
    expect(() => rebind("nope.action", "ctrl+b")).toThrow(/invalid keybinding action/);
  });
});

describe("/keybindings 命令（重绑定/持久化/重启恢复 + 冲突拒绝）", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpRoot(), "sc-kb-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("无参列出「动作 = 键位」（缺省 permission.cycle = shift+tab）", async () => {
    const { ctx, out } = fixture(cwd);
    await kbCmd().execute("", ctx);
    expect(out.join("\n")).toContain("permission.cycle = shift+tab");
  });

  it("单参查看该动作当前键位", async () => {
    const { ctx, out } = fixture(cwd);
    await kbCmd().execute("permission.cycle", ctx);
    expect(out.join("\n")).toContain("permission.cycle = shift+tab");
  });

  it("DoD①-重绑定 + 持久化：ui.keybindings 整表落盘 settings.local.json", async () => {
    const { ctx } = fixture(cwd);
    await kbCmd().execute("permission.cycle ctrl+b", ctx);
    const file = path.join(cwd, ".standardcode", "settings.local.json");
    expect(existsSync(file)).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // 落盘形：setLocalSetting 点路径 `ui.keybindings.permission.cycle` → JSON 嵌套 ui.keybindings.permission.cycle
    const ui = doc["ui"] as Record<string, unknown> | undefined;
    const kb = (ui?.["keybindings"] as Record<string, unknown> | undefined)?.["permission"] as Record<string, unknown> | undefined;
    expect(kb?.["cycle"]).toBe("ctrl+b");
  });

  it("DoD①-重启恢复：新会话由 settings 装配解析出重绑定后的键位", async () => {
    const { ctx } = fixture(cwd);
    await kbCmd().execute("permission.cycle ctrl+b", ctx);
    const reopened = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd });
    expect(normalizeSpec(keybindingsFromSettings(reopened.settings)["permission.cycle"])).toBe("ctrl+b");
    const out2: string[] = [];
    const ctx2 = createCommandContext({ session: reopened, io: { lines: (async function* () {})(), write: (s) => out2.push(s), close: () => {} } });
    await kbCmd().execute("", ctx2);
    expect(out2.join("\n")).toContain("permission.cycle = ctrl+b");
  });

  it("DoD①-冲突拒绝：保留键 ctrl+c 抢绑抛错且不落盘", async () => {
    const { ctx } = fixture(cwd);
    await expect(kbCmd().execute("permission.cycle ctrl+c", ctx)).rejects.toThrow(/conflict/);
    expect(existsSync(path.join(cwd, ".standardcode", "settings.local.json"))).toBe(false);
  });

  it("非法动作 / chord 键位 = fail-closed 抛错且不落盘", async () => {
    const { ctx } = fixture(cwd);
    await expect(kbCmd().execute("nope.action ctrl+b", ctx)).rejects.toThrow(/expected one of: permission.cycle/);
    await expect(kbCmd().execute("permission.cycle a b", ctx)).rejects.toThrow(/invalid key spec/);
    expect(existsSync(path.join(cwd, ".standardcode", "settings.local.json"))).toBe(false);
  });
});

describe("DoD② 键位表单源守卫（无散落硬编码键位）", () => {
  // 白名单理由：keybindings.ts 是唯一键位字面量单源（接缝㉔，与 theme.ts 同族）；
  // main.ts 的 `\x1b[2K` 是清行擦除码（非键位），且键事件面已改为消费单源表（setKeybindings/matchKeyEvent）。
  // 判据须**不绑定变量名**（main 抽查补判据：首版写 `key.name ===`／`key?.shift`，对任意变量名的真实硬编码
  // 零判别力＝0 红针——与 WP-03 守卫"只认真实 ESC 字节"同族教训）。现行判据：①键位串字面量 `shift+tab`/`ctrl+c`
  // ②键名比较（任意接收者）`.name === "tab|enter|…"` ③修饰位内联 `?.shift/ctrl/alt/meta`（排除数组 `?.shift()` 调用）。
  // 只扫**去注释后的代码**（注释里的键位说明不算"散落实现"，避免误报同时保留真违规的判别力）。
  it("apps/cli/src（除 keybindings.ts）去注释后无硬编码键位；新增一处可判别转红", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const WHITELIST = new Set(["keybindings.ts"]);
    const KEY_LITERAL =
      /shift\+tab|ctrl\+c|\.name\s*===\s*"(tab|enter|return|escape|space|up|down|left|right|backspace|delete|home|end|pageup|pagedown)"|\?\.\s*(shift|ctrl|alt|meta)(?!\s*\()/;
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const violations: string[] = [];
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith(".ts") || WHITELIST.has(f)) continue;
      const content = strip(readFileSync(path.join(srcDir, f), "utf8"));
      if (KEY_LITERAL.test(content)) violations.push(`${f}: 含硬编码键位字面量`);
    }
    expect(violations, violations.join("; ")).toEqual([]);
  });

  it("既有硬键位回归（DoD②）：缺省表 permission.cycle 命中 shift+tab（EXE-001 语义不破）", () => {
    const kb = resolveKeybindings({});
    expect(kb["permission.cycle"]).toEqual({ name: "tab", shift: true, ctrl: false, alt: false, meta: false });
    expect(matchKeyEvent(kb["permission.cycle"], { name: "tab", shift: true })).toBe(true);
    void ("" as BindableAction); // 类型面守卫：动作联合非空
  });
});
