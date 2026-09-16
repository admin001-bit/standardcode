// WP-01（M2）settings 五来源合并序测试（v2.8 §7.7 实证段；判据自足：板 WP-01 DoD①-⑤）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SETTINGS_SOURCE_ORDER,
  loadSettings,
  settingsValue,
  applySettingsEnv,
  managedSettingsPath,
  type SettingsEnvHandle,
} from "../src/settings.ts";

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-settings-"));
}

function writeJson(dir: string, file: string, doc: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), JSON.stringify(doc), "utf8");
}

interface Fixture {
  root: string;
  home: string;
  programData: string;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = tmpRoot();
  const home = tmpRoot();
  const programData = tmpRoot();
  return {
    root,
    home,
    programData,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(programData, { recursive: true, force: true });
    },
  };
}

/** managed 文件写入（与 loadSettings 同源路径解析：managedSettingsPath(当前平台, f.programData)）——三平台矩阵下读写一致。 */
function writeManaged(f: Fixture, doc: Record<string, unknown>): void {
  writeJson(path.dirname(managedSettingsPath(process.platform, f.programData)), "managed-settings.json", doc);
}

function load(f: Fixture, opts: { flagOverrides?: Record<string, unknown>; platform?: NodeJS.Platform } = {}) {
  // platform 跟随当前 runner（三平台矩阵各自真跑 Q-3 语义）；programData=f.programData 在三平台下均为
  // managed 基目录（settings.ts 分平台 join 与实际 FS 一致），managed 文件由 fixture 用 managedSettingsPath 写（同源解析）。
  return loadSettings({
    projectRoot: f.root,
    home: f.home,
    programData: f.programData,
    ...opts,
  });
}

describe("settings 五来源合并序（§7.7）", () => {
  it("DoD① 优先序=managed > flag > 项目 local > 项目共享 > 用户（叶子键自末尾首中即返）", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.home, ".standardcode"), "settings.json", { model: { default: "user-m" } });
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { model: { default: "shared-m" } });
      writeJson(path.join(f.root, ".standardcode"), "settings.local.json", { model: { default: "local-m" } });
      writeManaged(f, { model: { default: "managed-m" } });
      const all = load(f, { flagOverrides: { model: { default: "flag-m" } } });
      expect(settingsValue<string>(all, "model.default")).toBe("managed-m");
      expect(all.effectiveSources).toEqual([...SETTINGS_SOURCE_ORDER].reverse());
      expect(all.docs.flag).toEqual({ model: { default: "flag-m" } });

      // 逐层撤除：managed 撤除 → flag 胜；无 flag → projectLocal；local 撤除 → projectShared；shared 撤除 → user
      rmSync(managedSettingsPath(process.platform, f.programData)); // 撤除=写入同源（writeManaged 同款当前平台解析）
      expect(settingsValue<string>(load(f, { flagOverrides: { model: { default: "flag-m" } } }), "model.default")).toBe("flag-m");
      const noFlag = loadSettings({ projectRoot: f.root, home: f.home, programData: f.programData });
      expect(settingsValue<string>(noFlag, "model.default")).toBe("local-m");
      rmSync(path.join(f.root, ".standardcode", "settings.local.json"));
      expect(settingsValue<string>(load(f), "model.default")).toBe("shared-m");
      rmSync(path.join(f.root, ".standardcode", "settings.json"));
      expect(settingsValue<string>(load(f), "model.default")).toBe("user-m");
    } finally {
      f.cleanup();
    }
  });

  it("DoD② 列表键跨层合并：高→低拼接去重；非数组值被忽略", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.home, ".standardcode"), "settings.json", {
        permissions: { allow: ["Bash(git status)", "Bash(ls *)"] },
      });
      writeJson(path.join(f.root, ".standardcode"), "settings.local.json", {
        permissions: { allow: ["Bash(git status)", "Edit(src/**)"], deny: "not-an-array" },
      });
      writeManaged(f, { permissions: { allow: ["Read(~/.zshrc)"] } });
      const loaded = load(f);
      expect(settingsValue<string[]>(loaded, "permissions.allow")).toEqual([
        "Read(~/.zshrc)", // managed 最高
        "Bash(git status)", // local（与 user 重复去重，保高来源位次）
        "Edit(src/**)",
        "Bash(ls *)", // user 最低
      ]);
      expect(settingsValue<string[]>(loaded, "permissions.deny")).toBeUndefined(); // 非数组值被忽略
    } finally {
      f.cleanup();
    }
  });

  it("DoD③ managed 路径=Q-3 原文（Windows ProgramData/macOS）且用户不可排除（最高覆盖）", () => {
    expect(managedSettingsPath("win32", "D:\\PD")).toBe("D:\\PD\\StandardCode\\managed-settings.json");
    expect(managedSettingsPath("win32", undefined)).toBe("C:\\ProgramData\\StandardCode\\managed-settings.json");
    // darwin/linux 缺省形状：programData 显式 undefined（防 Windows runner 的 process.env.ProgramData 渗入 posix 分支）
    expect(managedSettingsPath("darwin", undefined)).toBe("/Library/Application Support/StandardCode/managed-settings.json");
    // 用户不可排除：user 与 managed 同键 → managed 胜
    const f = fixture();
    try {
      writeJson(path.join(f.home, ".standardcode"), "settings.json", { providers: { default: "openai" } });
      writeManaged(f, { providers: { default: "anthropic" } });
      expect(settingsValue<string>(load(f), "providers.default")).toBe("anthropic");
    } finally {
      f.cleanup();
    }
  });

  it("DoD④ 键位全集 mini-ADR-0030 落盘", () => {
    expect(existsSync(path.join(import.meta.dirname, "..", "..", "..", "docs", "adr", "0030-settings-keys-merge.md"))).toBe(true);
  });

  it("DoD⑤ settings 注入 env 粘滞：注入后省略不解除、null 跳过、同键更新允许", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { env: { SC_A: "1", SC_B: "2" } });
      const handle: SettingsEnvHandle = { injected: new Set() };
      const env: Record<string, string | undefined> = {};
      const r1 = applySettingsEnv(load(f), env, handle);
      expect(r1.injected.sort()).toEqual(["SC_A", "SC_B"]);
      expect(env.SC_A).toBe("1");

      // 改写文件：SC_B 被省略 → 粘滞不解除；SC_A 更新为 9 → 允许；SC_C=null → 跳过
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { env: { SC_A: "9", SC_C: null } });
      const r2 = applySettingsEnv(load(f), env, handle);
      expect(env.SC_A).toBe("9");
      expect(env.SC_B).toBe("2"); // 粘滞
      expect(r2.injected).toEqual(["SC_A"]);
      expect(r2.skipped.sort()).toEqual(["SC_B", "SC_C"]); // B=被省略（粘滞保留）、C=null
    } finally {
      f.cleanup();
    }
  });

  it("坏 JSON / schemaVersion 不符 → 跳过+告警（fail-open 限单文件）", () => {
    const f = fixture();
    try {
      mkdirSync(path.join(f.root, ".standardcode"), { recursive: true });
      writeFileSync(path.join(f.root, ".standardcode", "settings.local.json"), "{ broken", "utf8");
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { schemaVersion: 99, model: { default: "x" } });
      writeJson(path.join(f.home, ".standardcode"), "settings.json", { model: { default: "user-m" } });
      const loaded = load(f);
      expect(loaded.docs.projectLocal).toBeNull();
      expect(loaded.docs.projectShared).toBeNull();
      expect(loaded.warnings.map((w) => w.source).sort()).toEqual(["projectLocal", "projectShared"]);
      expect(settingsValue<string>(loaded, "model.default")).toBe("user-m");
    } finally {
      f.cleanup();
    }
  });
});

// —— WP-05（M5）SEC-020b + SEC-030 疑似密钥告警（判据自足：卡 DoD② 审计清偿面）——
describe("SEC-020b settings env 注入键黑名单（WP-05 清偿）", () => {
  it("项目级源（projectShared/projectLocal）声明 PATH/LD_PRELOAD/NODE_OPTIONS → 拒注入+告警+blocked 登记", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { env: { PATH: "C://evil", LD_PRELOAD: "/tmp/evil.so", NODE_OPTIONS: "--require evil.js", SC_OK: "1" } });
      const loaded = load(f);
      const env: Record<string, string | undefined> = {};
      const r = applySettingsEnv(loaded, env, { injected: new Set<string>() });
      expect(r.blocked.sort()).toEqual(["LD_PRELOAD", "NODE_OPTIONS", "PATH"]);
      expect(env.PATH).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.SC_OK).toBe("1"); // 非黑名单键正常注入
      expect(loaded.warnings.some((w) => w.source === "projectShared" && w.reason.includes("SEC-020b blocked") && w.path.includes("env.PATH"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("projectLocal 源同面（大小写不敏感：env.Path 同拦）；user/flag 源不设限", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.root, ".standardcode"), "settings.local.json", { env: { Path: "C://evil2" } });
      const env1: Record<string, string | undefined> = {};
      const loaded1 = load(f);
      const r1 = applySettingsEnv(loaded1, env1, { injected: new Set<string>() });
      expect(r1.blocked).toEqual(["Path"]);
      expect(env1.Path).toBeUndefined();
      // user 源：黑名单键放行（本机自有设置 [自定] 级别域）——独立 fixture（与 projectLocal 用例隔离）
      const f2 = fixture();
      try {
        writeJson(path.join(f2.home, ".standardcode"), "settings.json", { env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
        const env2: Record<string, string | undefined> = {};
        const loaded2 = load(f2);
        const r2 = applySettingsEnv(loaded2, env2, { injected: new Set<string>() });
        expect(r2.blocked).toEqual([]);
        expect(env2.NODE_OPTIONS).toBe("--max-old-space-size=4096");
      } finally {
        f2.cleanup();
      }
    } finally {
      f.cleanup();
    }
  });
});

describe("SEC-030 疑似密钥告警（WP-05 清偿；≥20 字符赋 *KEY*/*TOKEN*/*SECRET* 命名键）", () => {
  it("env.OPENAI_API_KEY 明文（≥20 字符）→ 告警含 keychain 建议；键值本体不落告警", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.root, ".standardcode"), "settings.json", { env: { OPENAI_API_KEY: "sk-1234567890abcdefGHIJ" } });
      const loaded = load(f);
      const hit = loaded.warnings.find((w) => w.reason.includes("suspected plaintext secret"));
      expect(hit).toBeDefined();
      expect(hit!.source).toBe("projectShared");
      expect(hit!.path).toBe("settings(env.OPENAI_API_KEY)");
      expect(hit!.reason).toContain("prefer keychain");
      expect(JSON.stringify(loaded.warnings)).not.toContain("sk-1234567890abcdefGHIJ"); // 值不二次落盘
    } finally {
      f.cleanup();
    }
  });
  it("短值（<20 字符）不告警；monkey 类命名不误报；camelCase apiKey 命中", () => {
    const f = fixture();
    try {
      writeJson(path.join(f.root, ".standardcode"), "settings.json", {
        env: { SHORT_KEY: "sk-short" },
        monkeyBusiness: "x".repeat(40),
        providerApiKeyCamel: "sk-1234567890abcdefGHIJ",
      });
      const loaded = load(f);
      const hits = loaded.warnings.filter((w) => w.reason.includes("suspected plaintext secret"));
      expect(hits.map((h) => h.path)).toEqual(["settings(providerApiKeyCamel)"]);
    } finally {
      f.cleanup();
    }
  });
});
