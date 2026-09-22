// M7-WP-06（/sandbox 命令与用户开关 UI）测试：DoD①①②③④⑤⑥ + 计数同步。
// 断言形制（承 WP-03/WP-04 教训）：集合类用全集相等（toEqual 全量枚举）；凡有缺省回落分支
// 必须覆盖**非缺省形**（开态/重绑后的非缺省 tier/env 逃逸舱）。状态恒以 resolveSandboxSettings
// 单源对账——命令面不得自写第二套判定。后端探针经注入面提供（不依赖本机真实装没装 rust 臂）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";
import { settingsValue } from "@standardcode/platform";
import { SANDBOX_TIERS } from "@standardcode/capabilities";
import { createCommandContext, type ReplDeps, type SandboxCommandDeps } from "../src/repl.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { probeSandboxBackend, resolveSandboxSettings, sandboxActivationSource } from "../src/sandbox-config.ts";

const LOCAL_FILE = [".standardcode", "settings.local.json"];

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in sandbox command tests");
    },
    countTokens: async () => 0,
  };
}

function localPath(cwd: string): string {
  return path.join(cwd, ...LOCAL_FILE);
}

function readLocal(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(localPath(cwd), "utf8")) as Record<string, unknown>;
}

/** 会话环境：lang 钉 en（文案断言确定化）+ 沙箱 env 注入面同源。 */
const BASE_ENV: NodeJS.ProcessEnv = { STANDARD_CODE_LANG: "en" };

function fixture(cwd: string, sandbox?: SandboxCommandDeps) {
  const env = sandbox?.env ?? BASE_ENV;
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd, env });
  const out: string[] = [];
  const deps: ReplDeps = {
    session,
    io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} },
    sandbox: { ...sandbox, env },
  };
  const ctx = createCommandContext(deps);
  return { session, out, ctx };
}

function sbCmd() {
  return CLI_COMMANDS.find((c) => c.name === "sandbox")!;
}

const OK_PROBE = () => "/opt/fake/standardcode-sandbox";

describe("WP-06 注册面（CLI_COMMANDS 33→34，末位）", () => {
  it("/sandbox 第 34 件且尾位；全集恰 34", () => {
    expect(CLI_COMMANDS).toHaveLength(34);
    expect(CLI_COMMANDS.at(-1)!.name).toBe("sandbox");
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("sandbox");
    expect(sbCmd().usage).toBe("[on | off | tier <name>]");
  });
});

describe("WP-06 纯函数面（来源判定/探针/档位名——集合类全集相等）", () => {
  it("sandboxActivationSource：env > flag > settings > default（显式空串=未设置）", () => {
    expect(sandboxActivationSource({ cliFlag: false, env: {}, settings: {} })).toBe("default");
    expect(sandboxActivationSource({ cliFlag: true, env: {}, settings: {} })).toBe("flag");
    expect(sandboxActivationSource({ cliFlag: false, env: {}, settings: { enabled: true } })).toBe("settings");
    expect(sandboxActivationSource({ cliFlag: true, env: { STANDARD_CODE_SANDBOX: "1" }, settings: { enabled: true } })).toBe("env");
    expect(sandboxActivationSource({ cliFlag: true, env: { STANDARD_CODE_SANDBOX: "   " }, settings: { enabled: true } })).toBe("flag");
    expect(sandboxActivationSource({ cliFlag: false, env: { STANDARD_CODE_SANDBOX: "   " }, settings: { enabled: true } })).toBe("settings");
  });

  it("probeSandboxBackend：ok=路径 / ok=false 带原因（不吞错）", () => {
    expect(probeSandboxBackend(() => "/bin/sb")).toEqual({ ok: true, path: "/bin/sb" });
    expect(probeSandboxBackend(() => { throw new Error("binary missing"); })).toEqual({ ok: false, reason: "binary missing" });
  });

  it("档位全集相等（命令面校验单源=SANDBOX_TIERS）", () => {
    expect([...SANDBOX_TIERS]).toEqual(["read-only", "workspace-write", "danger-full-access"]);
  });
});

describe("WP-06 /sandbox 三态 + 持久化 + 新会话生效", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "sc-sb-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("DoD① 缺省态：无参查看=不启用/来源 default/档 workspace-write；不落盘", async () => {
    const { ctx, out } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await sbCmd().execute("", ctx);
    const text = out.join("\n");
    expect(text).toContain("enabled: off");
    expect(text).toContain("tier: workspace-write");
    expect(text).toContain("source: default");
    // 单源对账（同参同判，命令面不自写第二套判定）
    expect(resolveSandboxSettings({ cliFlag: false, env: {}, settings: {} })).toEqual({ enabled: false, tier: "workspace-write" });
    expect(existsSync(localPath(cwd))).toBe(false);
  });

  it("DoD① 开态：/sandbox on 落盘 sandbox.enabled=true（点路径展开为叶子，非字面点键）", async () => {
    const { ctx } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await sbCmd().execute("on", ctx);
    const doc = readLocal(cwd);
    expect(doc["sandbox"]).toEqual({ enabled: true });
    expect(doc["sandbox.enabled"]).toBeUndefined(); // 对象值取不到=键铁律
  });

  it("DoD① 关态：/sandbox off 落盘 sandbox.enabled=false（非缺省形覆盖）", async () => {
    const { ctx } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await sbCmd().execute("off", ctx);
    expect(readLocal(cwd)["sandbox"]).toEqual({ enabled: false });
  });

  it("DoD① 开态查看：settings 开时状态=on/来源 settings（由 resolveSandboxSettings 单源产出）", async () => {
    const { ctx, out } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await sbCmd().execute("on", ctx);
    out.length = 0;
    await sbCmd().execute("", ctx);
    const text = out.join("\n");
    expect(text).toContain("enabled: on");
    expect(text).toContain("source: settings");
    expect(resolveSandboxSettings({ cliFlag: false, env: {}, settings: { enabled: true } }).enabled).toBe(true);
  });

  it("DoD② 持久化+新会话生效：新会话经 resolveSandboxSettings 判为启用并可装配沙箱句柄", async () => {
    const { ctx } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await sbCmd().execute("on", ctx);
    const reopened = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd, env: BASE_ENV });
    const settings = {
      enabled: settingsValue<boolean>(reopened.settings, "sandbox.enabled"),
      tier: settingsValue<string>(reopened.settings, "sandbox.tier"),
    };
    const assembly = resolveSandboxSettings({ cliFlag: false, env: {}, settings });
    expect(assembly.enabled).toBe(true);
    expect(sandboxActivationSource({ cliFlag: false, env: {}, settings })).toBe("settings");
    // 装配点同源（main.ts 形）：判定即装配
    const s2 = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd, projectRoot: cwd, env: BASE_ENV, sandbox: { tier: assembly.tier } });
    expect(s2.sandbox).toBeDefined();
  });

  it("/sandbox tier <name>：三档全集逐一落盘；缺省档与显式档非缺省形均覆盖", async () => {
    const { ctx } = fixture(cwd, { probe: OK_PROBE, env: {} });
    for (const tier of SANDBOX_TIERS) {
      await sbCmd().execute(`tier ${tier}`, ctx);
      expect(readLocal(cwd)["sandbox"]).toEqual({ tier });
      expect(resolveSandboxSettings({ cliFlag: false, env: {}, settings: { enabled: true, tier } })).toMatchObject({ enabled: true, tier });
    }
  });
});

describe("WP-06 边界（fail-closed / 在途会话语义 / env 逃逸舱）", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "sc-sb2-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("DoD③ 后端缺席：/sandbox on 拒绝且零落盘（写盘会让下次启动失败）；off 不需后端恒可关", async () => {
    const { ctx } = fixture(cwd, { probe: () => { throw new Error("standardcode-sandbox binary not found"); }, env: {} });
    await expect(sbCmd().execute("on", ctx)).rejects.toThrow(/standardcode-sandbox binary not found/);
    expect(existsSync(localPath(cwd))).toBe(false);
    // 对照非对称：关向不需探针
    await sbCmd().execute("off", ctx);
    expect(readLocal(cwd)["sandbox"]).toEqual({ enabled: false });
  });

  it("DoD⑤ 非法 tier：fail-closed 抛错且零落盘（三档名外全拒）", async () => {
    const { ctx } = fixture(cwd, { probe: OK_PROBE, env: {} });
    await expect(sbCmd().execute("tier yolo", ctx)).rejects.toThrow(/read-only, workspace-write, danger-full-access/);
    await expect(sbCmd().execute("tier", ctx)).rejects.toThrow(/on \| off \| tier/);
    await expect(sbCmd().execute("frobnicate", ctx)).rejects.toThrow(/on \| off \| tier/);
    expect(existsSync(localPath(cwd))).toBe(false);
  });

  it("DoD④ 在途会话语义 [自定]：开关后当前会话装配不变（不重建 session/不触碰工具装配），仅 settings 重载", async () => {
    const { ctx, session } = fixture(cwd, { probe: OK_PROBE, env: {} });
    const toolsBefore = session.tools.map((t) => t.name);
    expect(session.sandbox).toBeUndefined(); // 起手未装配（缺省关）
    await sbCmd().execute("on", ctx);
    expect(session.sandbox).toBeUndefined(); // 当前会话保持原状（沙箱句柄未因开关而生）
    expect(session.tools.map((t) => t.name)).toEqual(toolsBefore); // 工具面未被重建
    expect(settingsValue<boolean>(session.settings, "sandbox.enabled")).toBe(true); // 仅 settings 重载（新会话消费）
  });

  it("DoD⑥ env 逃逸舱凌驾：STANDARD_CODE_SANDBOX 显式设定时 on/off 明示 env 优先（不静默）", async () => {
    const env = { STANDARD_CODE_LANG: "en", STANDARD_CODE_SANDBOX: "0" };
    const { ctx, out } = fixture(cwd, { probe: OK_PROBE, env });
    await sbCmd().execute("on", ctx);
    expect(out.join("\n")).toContain("STANDARD_CODE_SANDBOX"); // 文案点名逃逸舱（EN/ZH 同字面）
    expect(readLocal(cwd)["sandbox"]).toEqual({ enabled: true }); // [自定]：仍落盘留用户意图
    // 状态查看：来源=env，enabled 由单源判为 false（env=0 凌驾 settings=true）
    const stale = resolveSandboxSettings({ cliFlag: false, env: { STANDARD_CODE_SANDBOX: "0" }, settings: { enabled: true } });
    expect(stale.enabled).toBe(false);
    expect(sandboxActivationSource({ cliFlag: false, env: { STANDARD_CODE_SANDBOX: "0" }, settings: { enabled: true } })).toBe("env");
    out.length = 0;
    await sbCmd().execute("", ctx);
    expect(out.join("\n")).toContain("source: env");
  });

  it("-sdb 旗标态：来源=flag（显式开启），查看面反映旗标来源", async () => {
    const { ctx, out } = fixture(cwd, { cliFlag: true, probe: OK_PROBE, env: {} });
    await sbCmd().execute("", ctx);
    const text = out.join("\n");
    expect(text).toContain("enabled: on");
    expect(text).toContain("source: flag");
    expect(existsSync(localPath(cwd))).toBe(false); // 查看不改盘
  });
});
