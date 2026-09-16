// WP-03 沙箱装配解析单测（键位/优先序/fail-closed 形/danger 确认闸——DoD①②③⑥ 的 L0 半）。
import { describe, expect, it } from "vitest";
import { gateDangerTier, resolveSandboxSettings } from "../src/sandbox-config.ts";

const EMPTY = {};

describe("wp03 resolveSandboxSettings（env > -sdb > settings > 缺省关）", () => {
  it("DoD① 全缺省=关（tier 位无意义但仍产 workspace-write 缺省档）", () => {
    const r = resolveSandboxSettings({ cliFlag: false, env: EMPTY, settings: EMPTY });
    expect(r).toEqual({ enabled: false, tier: "workspace-write" });
  });

  it("-sdb 旗标=开，默认档 workspace-write（EXE-011 行 427 原文档名）", () => {
    expect(resolveSandboxSettings({ cliFlag: true, env: EMPTY, settings: EMPTY })).toEqual({ enabled: true, tier: "workspace-write" });
  });

  it("settings sandbox.enabled=true 独立开；=false 与旗标叠加仍开（旗标=显式）", () => {
    expect(resolveSandboxSettings({ cliFlag: false, env: EMPTY, settings: { enabled: true } })).toMatchObject({ enabled: true });
    expect(resolveSandboxSettings({ cliFlag: true, env: EMPTY, settings: { enabled: false } })).toMatchObject({ enabled: true });
  });

  it("env 逃逸舱总闸：=0 凌驾旗标/settings；=1 独立开（STANDARD_CODE_SANDBOX）", () => {
    expect(resolveSandboxSettings({ cliFlag: true, env: { STANDARD_CODE_SANDBOX: "0" }, settings: { enabled: true } }).enabled).toBe(false);
    expect(resolveSandboxSettings({ cliFlag: false, env: { STANDARD_CODE_SANDBOX: "1" }, settings: EMPTY })).toMatchObject({ enabled: true, tier: "workspace-write" });
  });

  it("档位序：env TIER > settings tier > 缺省；三档名外全拒（不猜档 fail-closed）", () => {
    expect(resolveSandboxSettings({ cliFlag: true, env: { STANDARD_CODE_SANDBOX_TIER: "read-only" }, settings: { tier: "danger-full-access" } })).toMatchObject({ enabled: true, tier: "read-only" });
    expect(resolveSandboxSettings({ cliFlag: true, env: EMPTY, settings: { tier: "workspace-write" } })).toMatchObject({ tier: "workspace-write" });
    const bad = resolveSandboxSettings({ cliFlag: true, env: EMPTY, settings: { tier: "yolo" } });
    expect(bad.enabled).toBe(false);
    expect(bad.notice).toMatch(/不启用而非猜档/);
  });

  it("非法 env 形/非布尔 settings=不启用+提示（fail-closed 无静默）", () => {
    expect(resolveSandboxSettings({ cliFlag: true, env: { STANDARD_CODE_SANDBOX: "maybe" }, settings: EMPTY }).enabled).toBe(false);
    expect(resolveSandboxSettings({ cliFlag: true, env: EMPTY, settings: { enabled: "yes" } }).enabled).toBe(false);
  });
});

describe("wp03 gateDangerTier（DoD③ 显式确认；拒绝=不启用非降档）", () => {
  it("非 danger 直通闸（确认不被调用）", async () => {
    let called = false;
    const r = await gateDangerTier({ enabled: true, tier: "workspace-write" }, async () => {
      called = true;
      return false;
    });
    expect(called).toBe(false);
    expect(r.enabled).toBe(true);
  });
  it("danger+确认=开；拒绝=关+提示（不降档）", async () => {
    expect((await gateDangerTier({ enabled: true, tier: "danger-full-access" }, async () => true)).enabled).toBe(true);
    const denied = await gateDangerTier({ enabled: true, tier: "danger-full-access" }, async () => false);
    expect(denied.enabled).toBe(false);
    expect(denied.notice).toMatch(/非降档|不启用/);
  });
});
