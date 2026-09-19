// WP-01（M6 首卡）flag 矩阵单测：实验特性位基座 + 命令注册门。
// 判据自足（板 WP-01 DoD①-⑤）：
//   ①默认关闭：flag 全缺省=七命令不注册、工具面零新增（命令全集断言随 M7-WP-01 /goal 同步 30→31，2026-09-19）
//   ②开启路径两源生效序按 §7.7（env 逃逸舱 > settings，明文于模块头注），非法值 fail-closed 不猜
//   ③未知/非法 flag 名=告警不静默丢弃（M4 WP-05 O1 同族教训）
//   ④八包 tsc 0  ⑤文档标 experimental
// 七命令口径（BLK-06=①，2026-09-18 用户裁决）：M6 只落 /workflows /fork /export（本门覆盖三件）；
//   /branch /batch /loop /btw 推后 M7 且未实现——七件**皆不在注册表**（B-03 不提前实现）。
import { describe, expect, it } from "vitest";
import {
  EXPERIMENTAL_ENV_KEY,
  EXPERIMENTAL_FLAGS,
  EXPERIMENTAL_FLAGS_SETTINGS_KEY,
  EXPERIMENTAL_SETTINGS_KEY,
  experimentalSettingsFrom,
  resolveExperimental,
} from "@standardcode/platform";
import { createStandardTools } from "@standardcode/capabilities";
import { CLI_COMMANDS } from "../src/commands.ts";
import {
  EXPERIMENTAL_DEFERRED_COMMANDS,
  EXPERIMENTAL_FLAG_COMMANDS,
  activeExperimentalCommandNames,
  experimentalCommandNames,
  gateCommands,
  gatedRegistry,
} from "../src/experimental-gate.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { createSession } from "../src/session.ts";
import type { ProviderAdapter } from "@standardcode/providers";

/** §8.2 行 365 M6 分期七件（板 WP-01 DoD① 口径）。 */
const M6_COMMAND_NAMES = ["branch", "fork", "export", "workflows", "batch", "loop", "btw"];
/** 门覆盖面=M6 三件（BLK-06=①）；其余四件 M7。 */
const GATED_M6 = ["workflows", "fork", "export"];

/** 只读数组排序副本（readonly string[] 无 sort）。 */
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in WP-01 gate tests");
    },
    countTokens: async () => 0,
  };
}

/** 合成候选表：七命令 + 一条既有命令，用于验证门的过滤面（M6 实物命令由 WP-05/10 落）。 */
const candidates = [
  ...M6_COMMAND_NAMES.map((name) => ({ name, description: `${name} (candidate)`, execute: () => {} })),
  ...CLI_COMMANDS.filter((c) => c.name === "help"),
];

describe("WP-01 DoD① 默认关闭=零注册零回归", () => {
  it("flag 全缺省：门关、零 flag、零告警（静默=默认态，非静默丢弃）", () => {
    const gate = resolveExperimental({ env: {}, settings: undefined });
    expect(gate.enabled).toBe(false);
    expect(gate.flags).toEqual([]);
    expect(gate.notices).toEqual([]);
  });

  it("门关时七命令全不在候选表过滤结果内（实验命令不注册）", () => {
    const gate = resolveExperimental({ env: {}, settings: undefined });
    const gated = gateCommands(candidates, gate).map((c) => c.name);
    for (const name of M6_COMMAND_NAMES) expect(gated, `/${name} 不得注册`).not.toContain(name);
    expect(gated).toEqual(["help"]); // 非实验命令原样保留
  });

  it("真实表默认关=恰 31 件且逐字等于 CLI_COMMANDS（wp10 命令全集断言同步 +1 口径）", () => {
    const gate = resolveExperimental({ env: {}, settings: undefined });
    const registry = gatedRegistry(gate);
    expect(registry.map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(registry).toHaveLength(31);
  });

  it("M6 七命令在真实注册表内零命中（B-03：四件 M7 未实现，三件门控未开启）", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    for (const name of M6_COMMAND_NAMES) expect(names, `M6 分期命令 /${name} 不得提前注册`).not.toContain(name);
  });

  it("工具面零新增：现有六工具无 M6 实验工具名（Workflow/SendMessage/TaskCreate/TaskGet/TaskUpdate）", () => {
    const toolNames = createStandardTools({ cwd: process.cwd() }).map((t) => t.name);
    expect(toolNames.sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    for (const forbidden of ["Workflow", "SendMessage", "TaskCreate", "TaskGet", "TaskUpdate"]) {
      expect(toolNames, `M6 实验工具 ${forbidden} 不得提前注册`).not.toContain(forbidden);
    }
  });
});

describe("WP-01 DoD② 开启路径两源生效序 + 非法值 fail-closed", () => {
  it("settings experimental.enabled=true 开启，缺 flags 时注册表全量生效", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true } });
    expect(gate.enabled).toBe(true);
    expect(gate.flags).toEqual([...EXPERIMENTAL_FLAGS]);
    expect(sorted(activeExperimentalCommandNames(gate))).toEqual(sorted(GATED_M6));
  });

  it(`env ${EXPERIMENTAL_ENV_KEY}=1 逃逸舱开启（无 settings）`, () => {
    expect(resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "1" }, settings: undefined }).enabled).toBe(true);
    expect(resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "true" }, settings: undefined }).enabled).toBe(true);
    expect(resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "on" }, settings: undefined }).enabled).toBe(true);
  });

  it("两源生效序：env 逃逸舱 > settings（env=0 压 settings.enabled=true；env=1 压 settings.enabled=false）", () => {
    const off = resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "0" }, settings: { enabled: true } });
    expect(off.enabled).toBe(false);
    expect(off.flags).toEqual([]);
    const on = resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "1" }, settings: { enabled: false } });
    expect(on.enabled).toBe(true);
  });

  it("env 非法值 fail-closed：不启用且不回退 settings（settings.enabled=true 亦无效）+告警", () => {
    const gate = resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "maybe" }, settings: { enabled: true } });
    expect(gate.enabled).toBe(false);
    expect(gate.notices.join("\n")).toContain("fail-closed");
    expect(gate.notices.join("\n")).toContain("maybe");
  });

  it("settings 非布尔 fail-closed + 告警（不猜 truthy）", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: "yes" } });
    expect(gate.enabled).toBe(false);
    expect(gate.notices.join("\n")).toContain(EXPERIMENTAL_SETTINGS_KEY);
  });

  it("空白 env 值=缺席（回落 settings），不判非法", () => {
    const gate = resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "   " }, settings: { enabled: true } });
    expect(gate.enabled).toBe(true);
    expect(gate.notices).toEqual([]);
  });

  it("开启后门放行 M6 三件、仍拦 M7 四件（白名单未含=M7 未实现不入映射）", () => {
    const gate = resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "1" }, settings: undefined });
    const gated = gateCommands(candidates, gate).map((c) => c.name);
    for (const name of GATED_M6) expect(gated).toContain(name);
    for (const name of ["branch", "batch", "loop", "btw"]) expect(gated).not.toContain(name);
  });
});

describe("WP-01 DoD③ 未知/非法 flag 名=告警不静默丢弃", () => {
  it("未知 flag 名=告警（含名与已知集）+忽略该条，其余生效条目照常", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true, flags: ["workflow", "branch", "teams"] } });
    expect(gate.enabled).toBe(true);
    expect(gate.flags).toEqual(["workflow", "teams"]); // "branch"=M7 未注册 → 丢弃
    const text = gate.notices.join("\n");
    expect(text).toContain("branch");
    expect(text).toContain("未知实验 flag 名");
  });

  it("flags 非数组=fail-closed 零 flag + 告警（不猜意图）", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true, flags: "workflow" } });
    expect(gate.flags).toEqual([]);
    expect(gate.notices.join("\n")).toContain(EXPERIMENTAL_FLAGS_SETTINGS_KEY);
  });

  it("非法条目（非字符串/空串）=告警 + 忽略该条", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true, flags: [42, "", "fork"] } });
    expect(gate.flags).toEqual(["fork"]);
    const text = gate.notices.join("\n");
    expect(text).toContain("42");
    expect(text).toContain("条目非法");
  });

  it("未知配置键 experimental.*=告警（不静默丢弃）", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true, experimentalX: 1, workflo: 2 } });
    const text = gate.notices.join("\n");
    expect(text).toContain("experimental.experimentalX");
    expect(text).toContain("experimental.workflo");
    expect(text).toContain("未知配置键");
  });

  it("白名单收窄：flags=[\"fork\"] 时 /workflows 仍不注册（门内选择性开启）", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: true, flags: ["fork"] } });
    const gated = gateCommands(candidates, gate).map((c) => c.name);
    expect(gated).toContain("fork");
    expect(gated).toContain("export");
    expect(gated).not.toContain("workflows");
  });

  it("门关时白名单不生效（零解锁面）", () => {
    const gate = resolveExperimental({ env: {}, settings: { enabled: false, flags: ["fork"] } });
    expect(gate.enabled).toBe(false);
    expect(gate.flags).toEqual([]);
    expect(gateCommands(candidates, gate).map((c) => c.name)).not.toContain("fork");
  });
});

describe("WP-01 配置面接线（settings 子树切取 + /help 同源）", () => {
  it("experimentalSettingsFrom 自扁平合并值切出子树；无前缀键=undefined", () => {
    expect(experimentalSettingsFrom({ "experimental.enabled": true, "experimental.flags": ["fork"], "model.default": "m" })).toEqual({ enabled: true, flags: ["fork"] });
    expect(experimentalSettingsFrom({ "model.default": "m" })).toBeUndefined();
  });

  it("斜杠命令映射与注册表一致（flag→命令名 [自定] 登记面）", () => {
    expect(sorted(experimentalCommandNames())).toEqual(sorted(M6_COMMAND_NAMES)); // 拒绝面=M6 七件
    expect(sorted(activeExperimentalCommandNames(resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "1" }, settings: undefined })))).toEqual(sorted(GATED_M6)); // 放行面=三件
    expect(EXPERIMENTAL_FLAG_COMMANDS.workflow).toEqual(["workflows"]);
    expect(EXPERIMENTAL_FLAG_COMMANDS.teams).toEqual([]); // M6 无斜杠命令面（工具面同门，WP-06 起）
    expect(EXPERIMENTAL_FLAG_COMMANDS.fork).toEqual(["fork", "export"]);
    expect(EXPERIMENTAL_DEFERRED_COMMANDS).toEqual(["branch", "batch", "loop", "btw"]);
  });

  it("/help 与派发同源（门关=实验命令不出现在帮助表；开启=出现）", () => {
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a" });
    const out: string[] = [];
    const base: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };

    const off = gateCommands(candidates, resolveExperimental({ env: {}, settings: undefined }));
    createCommandContext({ ...base, commands: off }).commands();
    CLI_COMMANDS[0]!.execute("", createCommandContext({ ...base, commands: off }));
    expect(out.join("\n")).not.toContain("/workflows");
    expect(out.join("\n")).not.toContain("/fork");
    expect(out.join("\n")).toContain("/help"); // 既有面零回归

    out.length = 0;
    const on = gateCommands(candidates, resolveExperimental({ env: { [EXPERIMENTAL_ENV_KEY]: "1" }, settings: undefined }));
    CLI_COMMANDS[0]!.execute("", createCommandContext({ ...base, commands: on }));
    expect(out.join("\n")).toContain("/workflows");
    expect(out.join("\n")).toContain("/export");
  });
});
