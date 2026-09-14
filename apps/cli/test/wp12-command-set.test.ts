// WP-12（M4 收口）命令集合同测试：命令全集与 v2.8 §8.2 三分期集合相等（判据自足：板 WP-12 DoD③）。
// §8.2 命令分期原文（StandardCode_v2.8.md :365，逐名抄录）：
//   M1 最小集 /help /clear /exit /model /permission；
//   M2 增 /new /resume /reload /rename /compact /context /diff /rewind /config /provider /doctor /cd /add-dir；
//   M3 增 /tasks /background /subtask /effort /init /status /usage；
//   M4 增 /mcp /plugin /skills /memory /update（BLK-01 用户裁决①=Plugin 进 M4，含 /plugin，全集 30）；
//   M6 增 /branch /fork /export /workflows /batch /loop /btw；M7 增 /goal /theme /keybindings /release-notes /sandbox。
// 与 commands.test.ts"恰三十"有序快照断言互补：本文件是**集合相等**（不依赖注册顺序），
// M6/M7 除名=负半（B-03 边界：未分期命令不得注册）。
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
const M6_M7 = ["branch", "fork", "export", "workflows", "batch", "loop", "btw", "goal", "theme", "keybindings", "release-notes", "sandbox"];

const sorted = (xs: string[]) => [...xs].sort();
const names = CLI_COMMANDS.map((c) => c.name);

describe("命令全集 × §8.2 三分期集合相等（WP-12 DoD③）", () => {
  it("注册表名集合 = M1∪M2∪M3∪M4 分期并集（30 件，BLK-01=①含 /plugin）", () => {
    expect(sorted(names)).toEqual(sorted([...M1, ...M2, ...M3, ...M4]));
    expect(names).toHaveLength(30);
  });

  it("M4 五件逐名在位（/mcp /plugin /skills /memory /update）", () => {
    for (const cmd of M4) expect(names, `M4 缺 /${cmd}`).toContain(cmd);
  });

  it("M6/M7 十二件全部未注册（B-03：未到期分期不提前实现）", () => {
    for (const cmd of M6_M7) expect(names, `越期注册 /${cmd}`).not.toContain(cmd);
  });

  it("无重名（注册表=集合非多重集）", () => {
    expect(new Set(names).size).toBe(names.length);
  });
});
