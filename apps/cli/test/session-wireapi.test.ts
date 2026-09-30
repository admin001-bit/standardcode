// WP-02（M3）wire_api 线制键接线测试（ADR-0039；判据自足：板 WP-02 DoD③——wire_api 配置键解析+缺省 chat 不回归）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, type SessionInit } from "../src/session.ts";
import { ResponsesAdapter, OpenAIChatAdapter } from "@standardcode/providers";

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-wireapi-"));
}

function writeSettings(root: string, doc: unknown): void {
  mkdirSync(path.join(root, ".standardcode"), { recursive: true });
  writeFileSync(path.join(root, ".standardcode", "settings.json"), JSON.stringify(doc), "utf8");
}

function baseInit(root: string): SessionInit {
  // S1-1（全仓审查 2026-10-01）修复连带：嵌套 `env` 种子在项目共享层受信任门控——修复前经 bug 通道
  // 注入，修复后未信任被剥致 CI（无环境 key）缺 key 红；本文件测 wire_api/keychain 链非信任门，显式 trusted。
  return { projectRoot: root, home: tmpRoot(), programData: tmpRoot(), cwd: root, trusted: true };
}

describe("buildProvider wire_api 线制（WP-02 DoD③）", () => {
  it("缺省 chat 不回归：providers.openai.wire_api 未设 → OpenAIChatAdapter", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, { providers: { default: "openai", openai: { models: ["m1"] } }, env: { OPENAI_API_KEY: "sk-o" } });
      const s = createSession(baseInit(root));
      expect(s.provider).toBeInstanceOf(OpenAIChatAdapter);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings providers.openai.wire_api=responses → ResponsesAdapter", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, {
        providers: { default: "openai", openai: { models: ["m1"], wire_api: "responses" } },
        env: { OPENAI_API_KEY: "sk-o" },
      });
      const s = createSession(baseInit(root));
      expect(s.provider).toBeInstanceOf(ResponsesAdapter);
      expect(s.providerName).toBe("openai");
      expect([...s.catalog]).toEqual(["m1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("env STANDARD_CODE_WIRE_API 覆盖 settings（与 baseUrl 解析序一致）", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, {
        providers: { default: "openai", openai: { models: ["m1"], wire_api: "responses" } },
        env: { OPENAI_API_KEY: "sk-o" },
      });
      const s = createSession({ ...baseInit(root), env: { STANDARD_CODE_WIRE_API: "chat" } });
      expect(s.provider).toBeInstanceOf(OpenAIChatAdapter);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("非法 wire_api 值 fail-closed 抛错", () => {
    const root = tmpRoot();
    try {
      writeSettings(root, {
        providers: { default: "openai", openai: { models: ["m1"], wire_api: "grpc" } },
        env: { OPENAI_API_KEY: "sk-o" },
      });
      expect(() => createSession(baseInit(root))).toThrow(/wire_api/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// —— WP-05（M5）SEC-030 密钥优先级链接线：keychain 链首命中→无 env 亦可装配；未命中→报错含 keychain account ——
describe("SEC-030 keychain 链（WP-05 清偿）", () => {
  it("fake keychain 命中=空 env 下装配成功（链首生效）；未命中=missing API key 报错含 api-key:<provider>", () => {
    const root = tmpRoot();
    try {
      const s = createSession({ ...baseInit(root), env: {}, keychain: { name: "fake", getSecret: () => "sk-from-keychain" } });
      expect(s.providerName).toBe("anthropic");
      expect(() => createSession({ ...baseInit(root), env: {}, keychain: { name: "fake", getSecret: () => null } })).toThrow(/api-key:anthropic/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
