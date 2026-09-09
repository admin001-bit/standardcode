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
  return { projectRoot: root, home: tmpRoot(), programData: tmpRoot(), cwd: root };
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
