// WP-07（M4）i18n 单测：ADR-0042 三要素（选择链/缺失策略/收敛范围守卫）+DoD③④⑥。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EN, I18N_TERMS_KEEP, ZH_CN, createI18n, resolveLang, tEn } from "../src/index.ts";

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

describe("DoD④ 命令面收敛守卫（源码级 grep 型——ADR-0042 决策 4）", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../../apps/cli/src/commands.ts"), "utf8");
  it("commands.ts 零残留 description:/usage: 英文字面量（全经 tEn）", () => {
    expect(src).not.toMatch(/description: "/);
    expect(src).not.toMatch(/usage: "[^[ ]/); // usage: tEn(...) 或 usage: ""（memory 空参形状）
    expect((src.match(/tEn\("cmd\./g) ?? []).length).toBeGreaterThanOrEqual(43); // 28 desc + 15 usage（13 命令无 usage 参数形=可选字段缺席）
  });
  it("commands.ts 引用的全部 catalog 键 ∈ EN（含运行时 t 键）", () => {
    const keys = new Set<string>();
    for (const m of src.matchAll(/tEn\("(cmd\.[\w.-]+)"\)/g)) keys.add(m[1]!);
    for (const m of src.matchAll(/ctx\.t\("(cmd\.[\w.-]+|repl\.[\w.-]+)"/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThanOrEqual(45);
    for (const k of keys) expect(EN[k], `missing key ${k}`).toBeTypeOf("string");
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
