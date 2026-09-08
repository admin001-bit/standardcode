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

function load(f: Fixture, opts: { flagOverrides?: Record<string, unknown>; platform?: NodeJS.Platform } = {}) {
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
      writeJson(path.join(f.programData, "StandardCode"), "managed-settings.json", { model: { default: "managed-m" } });
      const all = load(f, { flagOverrides: { model: { default: "flag-m" } } });
      expect(settingsValue<string>(all, "model.default")).toBe("managed-m");
      expect(all.effectiveSources).toEqual([...SETTINGS_SOURCE_ORDER].reverse());
      expect(all.docs.flag).toEqual({ model: { default: "flag-m" } });

      // 逐层撤除：managed 撤除 → flag 胜；无 flag → projectLocal；local 撤除 → projectShared；shared 撤除 → user
      rmSync(path.join(f.programData, "StandardCode", "managed-settings.json"));
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
      writeJson(path.join(f.programData, "StandardCode"), "managed-settings.json", {
        permissions: { allow: ["Read(~/.zshrc)"] },
      });
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
    expect(managedSettingsPath("darwin")).toBe("/Library/Application Support/StandardCode/managed-settings.json");
    // 用户不可排除：user 与 managed 同键 → managed 胜
    const f = fixture();
    try {
      writeJson(path.join(f.home, ".standardcode"), "settings.json", { providers: { default: "openai" } });
      writeJson(path.join(f.programData, "StandardCode"), "managed-settings.json", { providers: { default: "anthropic" } });
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
