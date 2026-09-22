// WP-07（M4）i18n 单测：ADR-0042 三要素（选择链/缺失策略/收敛范围守卫）+DoD③④⑥。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EN, I18N_TERMS_KEEP, ZH_CN, configureI18n, createI18n, resolveLang, tEn } from "../src/index.ts";

describe("DoD③ 双包键集合全等", () => {
  it("ZH_CN 与 EN 键集合相等（双向）", () => {
    expect(Object.keys(ZH_CN).sort()).toEqual(Object.keys(EN).sort());
  });
  it("tEn 全键可解析（无 key 回退告警面）", () => {
    for (const k of Object.keys(EN)) expect(tEn(k)).toBe(EN[k]);
  });
});

describe("DoD② 选择链（env > settings.language > en）", () => {
  it("env STANDARD_CODE_LANG=zh-CN 胜出", () => {
    expect(resolveLang({ STANDARD_CODE_LANG: "zh-CN" }, "en")).toBe("zh-CN");
  });
  it("settings.language 次之；非法值=告警回退 en（fail-closed）", () => {
    expect(resolveLang({}, "zh-CN")).toBe("zh-CN");
    expect(resolveLang({}, "fr")).toBe("en");
    expect(resolveLang({ STANDARD_CODE_LANG: "de" }, "zh-CN")).toBe("en");
  });
  it("双缺省=en", () => {
    expect(resolveLang({}, undefined)).toBe("en");
    expect(resolveLang({ STANDARD_CODE_LANG: "" }, "  ")).toBe("en");
  });
});

describe("O2/O3 加固（复验后）", () => {
  it("settings.language 非字符串→告警回退（不崩）", () => {
    expect(resolveLang({}, 42 as unknown as string)).toBe("en");
  });
  it("env 空串=未设置→落 settings.language", () => {
    expect(resolveLang({ STANDARD_CODE_LANG: "  " }, "zh-CN")).toBe("zh-CN");
  });
});

describe("DoD③ 缺失策略", () => {
  it("zh 缺失键→回退 EN 同键（DoD③）", () => {
    const e = createI18n("zh-CN");
    (EN as Record<string, string>).__probe_only_en__ = "EN-ONLY";
    expect(e.t("__probe_only_en__")).toBe("EN-ONLY");
    delete (EN as Record<string, string>).__probe_only_en__;
  });
  it("双缺→返回 key 本身（一次性告警不崩溃）", () => {
    const e = createI18n("en");
    expect(e.t("no.such.key.at.all")).toBe("no.such.key.at.all");
  });
  it("参数插值 {name} 形", () => {
    const e = createI18n("zh-CN");
    expect(e.t("repl.model.switched", { value: "claude-opus-5" })).toBe("[model] 已切换到 claude-opus-5");
    expect(createI18n("en").t("repl.model.switched", { value: "m" })).toBe("[model] switched to m");
  });
});

describe("DoD④ 命令面收敛守卫（源码级 grep 型——ADR-0042 决策 4，复验后全量形）", () => {
  const cmdSrc = readFileSync(path.resolve(import.meta.dirname, "../../../apps/cli/src/commands.ts"), "utf8");
  const replSrc = readFileSync(path.resolve(import.meta.dirname, "../../../apps/cli/src/repl.ts"), "utf8");
  const sessSrc = readFileSync(path.resolve(import.meta.dirname, "../../../apps/cli/src/session.ts"), "utf8");
  it("commands.ts 零残留 description/usage 字面量（全经运行时 getter t）", () => {
    expect(cmdSrc).not.toMatch(/description: "/);
    expect(cmdSrc).not.toMatch(/usage: "/);
    expect((cmdSrc.match(/get description\(\) \{/g) ?? []).length).toBe(33); // +WP-08 /update（2026-09-15）+M7-WP-01 /goal（2026-09-19）+M7-WP-03 /theme（2026-09-23）
    expect((cmdSrc.match(/get usage\(\) \{/g) ?? []).length).toBe(19); // +M7-WP-01 /goal usage（2026-09-19）+M7-WP-03 /theme usage（2026-09-23）
  });
  it("全部 catalog 键被消费（死键守卫；动态拼装基名豁免）", () => {
    const allSrc = cmdSrc + replSrc + sessSrc;
    const dynamicAssembled = new Set(["repl.mcp.done.approve", "repl.mcp.done.reject", "repl.mcp.done.enable", "repl.mcp.done.disable"]);
    const dead: string[] = [];
    for (const key of Object.keys(EN)) {
      if (dynamicAssembled.has(key)) continue;
      if (!allSrc.includes(`"${key}"`)) dead.push(key);
    }
    expect(dead).toEqual([]);
  });
  it("repl.ts 渲染写点零固定字面（双引号+反引号模板头+throw 三路扫描）", () => {
    const lits = [...replSrc.matchAll(/io\.write\("([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== "\n" && v.trim() !== "");
    expect(lits).toEqual([]);
    const bt = [...replSrc.matchAll(/io\.write\(`([^`$]*)/g)].map((m) => m[1]!).filter((v) => v.trim() !== "" && v !== "\n" && v !== "\\n");
    expect(bt).toEqual([]);
    const th = [...replSrc.matchAll(/throw new Error\(`([^`$]*)/g)].map((m) => m[1]!).filter((v) => v.trim() !== "");
    expect(th).toEqual([]);
    const thLit = [...replSrc.matchAll(/throw new Error\("([^"]*)"\)/g)].map((m) => m[1]!).filter((v) => v.trim() !== "");
    expect(thLit).toEqual([]);
  });
  it("mcp errorCol 空格形钉（基线 status 后 2 空格；防换位静默回归）", () => {
    expect(EN["repl.mcp.errorCol"]).toBe("error: {value}");
    expect(replSrc).toContain("${v.error ? `  ${s.i18n.t(\"repl.mcp.errorCol\"");
  });
  it("session 装配点钉（R3：configureI18n 接线不得静默脱落）", () => {
    expect(sessSrc).toContain("configureI18n(session.i18n.lang)");
  });
  it("引用的全部 catalog 键 ∈ EN（含运行时 t 键）", () => {
    const keys = new Set<string>();
    for (const m of cmdSrc.matchAll(/t\("(cmd\.[\w.-]+|repl\.[\w.-]+)"/g)) keys.add(m[1]!);
    for (const m of replSrc.matchAll(/i18n\.t\("(cmd\.[\w.-]+|repl\.[\w.-]+)"/g)) keys.add(m[1]!);
    for (const m of sessSrc.matchAll(/i18n\.t\("(cmd\.[\w.-]+|repl\.[\w.-]+)"/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThanOrEqual(80);
    for (const k of keys) expect(EN[k], `missing key ${k}`).toBeTypeOf("string");
  });
});

describe("R3 修复：命令面/渲染运行时按 active lang（zh 消费实证）", () => {
  it("configureI18n(zh-CN) → CLI_COMMANDS description 出中文；恢复 en", async () => {
    const { CLI_COMMANDS } = await import("../../../apps/cli/src/commands.ts");
    configureI18n("zh-CN");
    try {
      expect(CLI_COMMANDS.find((c) => c.name === "help")!.description).toBe("列出全部可用命令");
      expect(CLI_COMMANDS.find((c) => c.name === "model")!.usage).toBe("[name]");
    } finally {
      configureI18n("en");
    }
    expect(CLI_COMMANDS.find((c) => c.name === "help")!.description).toBe("list all available commands");
  });
});

describe("DoD⑥ 技术术语保留清单（抽查）", () => {
  it("ZH_CN 关键值内术语保留英文原形", () => {
    const joined = Object.values(ZH_CN).join("\n");
    for (const term of I18N_TERMS_KEEP) expect(joined, `term ${term}`).toContain(term);
    expect(ZH_CN["cmd.model.desc"]).toContain("model");
    expect(ZH_CN["cmd.mcp.desc"]).toContain("MCP");
    expect(ZH_CN["cmd.skills.desc"]).toContain("skill");
    expect(ZH_CN["cmd.status.desc"]).toContain("provider");
  });
});

describe("DoD⑤ 装配面（i18n 只触 L0；prompt 装配零涉及）", () => {
  it("platform i18n 模块不引 providers/context（L6 顶层单向依赖不新增）+catalog 无提示词形文本", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/i18n.ts"), "utf8");
    expect(src).not.toMatch(/@standardcode\/(providers|context|harness|capabilities)/);
    // 无系统提示词风格长段落（纪律性断言：catalog 值均 <220 字符=渲染面文案形）
    for (const v of Object.values(EN)) expect(v.length).toBeLessThan(220);
  });
});
