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
  // S1-1（全仓审查 2026-10-01）修复连带：本文件种子在**项目共享层**的嵌套 `env`（settings.json）受
  // 信任门控——修复前经嵌套形绕门注入（bug 通道，CI 无环境 key 时靠它供凭据），修复后未信任必被剥。
  // 本文件测 settings 装配/注入机制而非信任门（信任门断言在 session-trust/trust.test），故显式 trusted
  // 模拟"已接受信任对话框"。
  // S7-5（全仓审查 2026-10-01）：env 缺省=空映射——ambient STANDARD_CODE_PROVIDER/MODEL 会击穿
  // 「env 逃逸舱 > settings > 默认」等优先序断言的非覆写分支（本机设过即假红）。
  return { projectRoot: root, home: tmpRoot(), programData: tmpRoot(), cwd: root, trusted: true, env: {} };
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

  it("settings 注入 env 粘滞（同 handle）：注入真发生；会话内 reload 省略不解除；handle 跨会话延续登记", () => {
    // S7-6（全仓审查 2026-10-01）：原断言 settingsEnvInjectedOf(handle).has("SC_STICKY") 完全由第一
    // 会话的只增 Set 决定——第二会话复用与否均恒真，标题承诺行为零覆盖。session env 恒为 init.env 的
    // 拷贝（session.ts:301「注入只进 env 副本」），值不跨会话迁移——故真判据钉在：
    // ①注入链真发生（session.env 上可见）；②**会话内 reload**（session.ts:592 同 target 再喂）省略
    // 该键后值仍在＝粘滞不解除（省略即消失则红）；③handle 登记跨会话延续（第二会话复用不丢）。
    // handle 的 skipped 报告语义由 platform settings.test:133 钉，此处不重复。
    const root = tmpRoot();
    try {
      writeSettings(root, "settings.json", { env: { SC_STICKY: "1", ANTHROPIC_API_KEY: "sk-a" } });
      const handle = { injected: new Set<string>() };
      const first = createSession({ ...baseInit(root), env: {}, settingsEnv: handle });
      expect(first.settings.warnings).toEqual([]);
      expect(first.env.SC_STICKY).toBe("1"); // ①首会话注入真发生（原测试从未验证）
      expect(first.env.ANTHROPIC_API_KEY).toBe("sk-a"); // settings 注入面覆盖同键（接线判据）
      // 会话内 reload：settings 省略全部 env 键 → 同 target 上值不解除（粘滞）
      writeSettings(root, "settings.json", {});
      first.reload();
      expect(first.env.SC_STICKY).toBe("1"); // ②粘滞真判据（粘滞环断裂即红）
      expect(first.env.ANTHROPIC_API_KEY).toBe("sk-a");
      expect(settingsEnvInjectedOf(handle).has("SC_STICKY")).toBe(true);
      // 跨会话：第二会话复用同一 handle——登记面延续；值不跨会话迁移（env=拷贝，口径如实）
      const second = createSession({ ...baseInit(root), env: { ANTHROPIC_API_KEY: "sk-a" }, settingsEnv: handle });
      expect(settingsEnvInjectedOf(handle).has("SC_STICKY")).toBe(true); // ③handle 延续登记
      expect(second.env.SC_STICKY).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
