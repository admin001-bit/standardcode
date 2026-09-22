// WP-12（M6 收口）命令全集零增量+发布面负查+M6 新增面零注册（判据自足：板 WP-12 DoD④；
// 与 M4 wp12-command-set / M5 wp10-milestone 同源互补——本文件=收口时点零增量复核+M6 新增面负查）。
// ①命令全集 30 零增量：注册表名集合 ≡ §8.2 M1∪M2∪M3∪M4（M6 零新增；workflows/fork/export 三件
//   走实验门内注册，不进基表 CLI_COMMANDS）；
// ②postinstall 零生命周期脚本负查（ADR-0044 决策：npm 包零生命周期脚本，postinstall 不做提权/不做任意执行）；
// ③M6 新增面零注册（默认关，ORC-050/§8.2 行 365）：斜杠面=§8.2 行 365 七件候选在基表零命中；
//   工具面=createStandardTools() 恰六件且不含 SendMessage（B-03 不提前实现）；
// ④实验门候选面守恒：experimentalCommandNames() 恰 7 件 ≡ §8.2 行 365（workflows/fork/export/batch/loop/btw/branch，
//   BLK-06=① M6 只落三件、余四件推后 M7 恒不放行）；缺省关=activeExperimentalCommandNames()=[]。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStandardTools } from "@standardcode/capabilities";
import { resolveExperimental } from "@standardcode/platform";
import { CLI_COMMANDS } from "../src/commands.ts";
import { activeExperimentalCommandNames, experimentalCommandNames } from "../src/experimental-gate.ts";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
/** §8.2 行 365 M7 分期（BLK-06=① 推后四件走实验门；正式面首件 /goal=M7-WP-01，2026-09-19）。 */
const M7 = ["goal", "theme"];
/** §8.2 行 365 M6 分期七命令（BLK-06=①：M6 只落 workflows/fork/export 三件，余四件推后 M7）。 */
const M6_COMMAND_NAMES = ["workflows", "batch", "loop", "btw", "branch", "fork", "export"];
/** M6 新增工具面（ORC-050 默认关=工具零注册；B-03 不提前实现）。 */
const M6_TOOL_NAMES = ["SendMessage", "Workflow"];

const sorted = (xs: readonly string[]) => [...xs].sort();
const names = CLI_COMMANDS.map((c) => c.name);

describe("WP-12 DoD④ 收口断言集：命令全集零增量+发布面负查+M6 新增面零注册", () => {
  it("命令全集=32 件【2026-09-19：M7-WP-01 注册 /goal 30→31，/goal=§8.2 M7 分期首件】且集合 ≡ §8.2 M1∪M2∪M3∪M4∪M7", () => {
    expect(names).toHaveLength(32);
    expect(sorted(names)).toEqual(sorted([...M1, ...M2, ...M3, ...M4, ...M7]));
  });

  it("postinstall 零提权负查：apps/cli/package.json 无 pre/install/post 生命周期脚本（ADR-0044）", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string>; name?: string };
    expect(pkg.name).toBe("@standardcode-oss/cli");
    const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "prepublishOnly", "prepare"];
    const present = Object.keys(pkg.scripts ?? {}).filter((s) => lifecycle.includes(s));
    expect(present).toEqual([]); // 零生命周期脚本=零提权零任意执行面
  });

  it("M6 新增面零注册（默认关）：基表对 §8.2 行 365 七件候选零命中+工具面恰六件不含 M6 实验工具", () => {
    for (const cmd of M6_COMMAND_NAMES) expect(names, `M6 分期命令 /${cmd} 不得注册进基表`).not.toContain(cmd);
    const toolNames = createStandardTools({ cwd: process.cwd() }).map((t) => t.name);
    expect(sorted(toolNames)).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    for (const tool of M6_TOOL_NAMES) expect(toolNames, `M6 实验工具 ${tool} 不得提前注册`).not.toContain(tool);
  });

  it("实验门候选面守恒：experimentalCommandNames() 恰 7 件 ≡ §8.2 行 365；缺省关=活跃放行面 []", () => {
    expect(sorted(experimentalCommandNames())).toEqual(sorted(M6_COMMAND_NAMES));
    const gate = resolveExperimental({ env: {}, settings: undefined });
    expect(gate.enabled).toBe(false);
    expect([...activeExperimentalCommandNames(gate)]).toEqual([]);
  });
});
