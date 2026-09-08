// WP-01（M2）session 装配 settings 迁移测试（M1 env 直读偏差清偿；判据自足：板 WP-01 DoD⑥）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, settingsEnvInjectedOf, type SessionInit } from "../src/session.ts";
import type { SettingsEnvHandle } from "@standardcode/platform";

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-session-"));
}

function writeSettings(root: string, file: string, doc: unknown): void {
  mkdirSync(path.join(root, ".standardcode"), { recursive: true });
  writeFileSync(path.join(root, ".standardcode", file), JSON.stringify(doc), "utf8");
}

function baseInit(root: string): SessionInit {
  return { projectRoot: root, home: tmpRoot(), programData: tmpRoot(), cwd: root };
}

describe("createSession settings 装配（WP-01）", () => {
  it("settings 供给 provider/catalog/baseUrl，env.* 注入供给凭据；process.env 不被污染", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, "settings.json", {
        providers: { default: "openai", openai: { models: ["m1", "m2"], baseUrl: "http://localhost:9" } },
        env: { OPENAI_API_KEY: "sk-from-settings" },
      });
      const before = process.env.OPENAI_API_KEY;
      const s = createSession(baseInit(root));
      expect(s.providerName).toBe("openai");
      expect([...s.catalog]).toEqual(["m1", "m2"]);
      expect(s.model).toBe("m1");
      expect(process.env.OPENAI_API_KEY).toBe(before); // 注入只进 env 副本
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("env 逃逸舱 > settings > 默认（MDL-010~013 保留）", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, "settings.json", {
        providers: { default: "openai", openai: { models: ["m1"] } },
        env: { OPENAI_API_KEY: "sk-o" },
      });
      // 无 env 覆写 → settings providers.default=openai 生效
      expect(createSession(baseInit(root)).providerName).toBe("openai");
      // env 逃逸舱赢 settings（凭据随通道取）
      const s = createSession({ ...baseInit(root), env: { STANDARD_CODE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-env" } });
      expect(s.providerName).toBe("anthropic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings 注入 env 粘滞跨会话（同 handle）：后续会话不再提供该键也不解除", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, "settings.json", { env: { SC_STICKY: "1", ANTHROPIC_API_KEY: "sk-a" } });
      const handle = { injected: new Set<string>() };
      const first = createSession({ ...baseInit(root), settingsEnv: handle });
      expect(first.settings.warnings).toEqual([]);
      // 第二会话：改写 settings 去掉 SC_STICKY → env 副本仍保留（粘滞）
      writeSettings(root, "settings.json", {});
      const secondEnv = { ANTHROPIC_API_KEY: "sk-a" } as NodeJS.ProcessEnv; // 凭据走 env；粘滞语义由 platform 测试覆盖，此处验证 handle 复用不抛错
      const second = createSession({ ...baseInit(root), env: secondEnv, settingsEnv: handle });
      expect(settingsEnvInjectedOf(handle).has("SC_STICKY")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
