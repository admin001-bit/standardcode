// WP-06（M2）session thinking 解析测试（判据自足：板 WP-06 DoD③ 能力位开关缺省关闭）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, resolveThinking } from "../src/session.ts";
import { loadSettings } from "@standardcode/platform";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-think-"));
}

describe("resolveThinking（WP-06 DoD③）", () => {
  it("缺省关闭：env/settings 均无 → undefined（不发 thinking 字段）", () => {
    const root = tmp();
    const s = loadSettings({ projectRoot: root, home: tmp(), programData: tmp() });
    expect(resolveThinking(undefined, {}, s)).toBeUndefined();
    expect(resolveThinking(undefined, { STANDARD_CODE_THINKING: "off" }, s)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("env 逃逸舱 > settings；budget:N 语法与无效值回落关闭", () => {
    const root = tmp();
    const s = loadSettings({ projectRoot: root, home: tmp(), programData: tmp() });
    expect(resolveThinking(undefined, { STANDARD_CODE_THINKING: "adaptive" }, s)).toEqual({ type: "adaptive" });
    expect(resolveThinking(undefined, { STANDARD_CODE_THINKING: "budget:1500" }, s)).toEqual({ type: "budget", budgetTokens: 1500 });
    expect(resolveThinking(undefined, { STANDARD_CODE_THINKING: "budget" }, s)).toEqual({ type: "budget", budgetTokens: 8_000 });
    expect(resolveThinking(undefined, { STANDARD_CODE_THINKING: "bogus" }, s)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("createSession 装配 thinking（settings model.thinking 键）+ init 直接注入", () => {
    const root = tmp();
    const home = tmp();
    const s = createSession({
      projectRoot: root,
      home,
      programData: tmp(),
      cwd: root,
      env: { ANTHROPIC_API_KEY: "sk-x", STANDARD_CODE_THINKING: "adaptive" },
    });
    expect(s.thinking).toEqual({ type: "adaptive" });
    const s2 = createSession({
      projectRoot: root,
      home,
      programData: tmp(),
      cwd: root,
      env: { ANTHROPIC_API_KEY: "sk-x" },
      thinking: { type: "budget", budgetTokens: 1234 },
    });
    expect(s2.thinking).toEqual({ type: "budget", budgetTokens: 1234 });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
