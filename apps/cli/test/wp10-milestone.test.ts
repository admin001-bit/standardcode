// WP-10（M5 收口）命令全集零增量+发布面负查（判据自足：板 WP-10 DoD⑤；与 M4 wp12-command-set.test.ts
// 集合相等同源互补——本文件=收口时点零增量复核+M5 新增面负查）。
// ①命令全集零增量：注册表名集合 ≡ §8.2 M1∪M2∪M3∪M4∪M7（M5 零新增；M7 命令随分期陆续注册）；
// ②postinstall 零提权负查（ADR-0044 决策：npm 包零生命周期脚本，postinstall 不做提权/不做任意执行）；
// ③斜杠零新增：-sdb（旗标）/uninstall（子命令）皆不在斜杠集合——/sandbox 属 §8.2 行 365 M7 分期面，
//   M7-WP-06 已注册（2026-09-23），故**不入**本 M5 负查名册。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
/** M7 正式面（M7-WP-01 /goal，2026-09-19；M7-WP-03 /theme、M7-WP-04 /keybindings、M7-WP-06 /sandbox，2026-09-23）。 */
const M7 = ["goal", "theme", "keybindings", "sandbox"];
/** M5 新增面（旗标/子命令）=不得进斜杠集合（/sandbox 属 M7 到期待注册面，不在此列）。 */
const M5_NOT_SLASH = ["sdb", "uninstall"];

const sorted = (xs: string[]) => [...xs].sort();
const names = CLI_COMMANDS.map((c) => c.name);

describe("WP-10 DoD⑤ 命令全集零增量+发布面负查", () => {
  it("命令全集=34 件【2026-09-19：M7-WP-01 注册 /goal 30→31；2026-09-23：M7-WP-03 /theme、M7-WP-04 /keybindings、M7-WP-06 /sandbox】且集合 ≡ §8.2 M1∪M2∪M3∪M4∪M7", () => {
    expect(names).toHaveLength(34);
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

  it("M5 新增面零注册：-sdb 旗标/uninstall 子命令皆不在斜杠命令集合（/sandbox 属 M7 已注册面，不在此列）", () => {
    for (const cmd of M5_NOT_SLASH) expect(names, `M5 面 /${cmd} 不得注册为斜杠命令`).not.toContain(cmd);
  });
});
