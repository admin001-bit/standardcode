// WP-10（M5 收口）命令全集零增量+发布面负查（判据自足：板 WP-10 DoD⑤；与 M4 wp12-command-set.test.ts
// 集合相等同源互补——本文件=收口时点零增量复核+M5 新增面负查）。
// ①命令全集 30 零增量：注册表名集合 ≡ §8.2 M1∪M2∪M3∪M4（M5 零新增）；
// ②postinstall 零提权负查（ADR-0044 决策：npm 包零生命周期脚本，postinstall 不做提权/不做任意执行）；
// ③斜杠零新增：-sdb（旗标）/uninstall（子命令）/sandbox（=M7 命令，本 M 不注册）皆不在斜杠集合（§8.2 行 365）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
/** M5 新增面（旗标/子命令/M7 分期命令）=不得进斜杠集合。 */
const M5_NOT_SLASH = ["sdb", "uninstall", "sandbox"];

const sorted = (xs: string[]) => [...xs].sort();
const names = CLI_COMMANDS.map((c) => c.name);

describe("WP-10 DoD⑤ 命令全集 30 零增量+发布面负查", () => {
  it("命令全集仍=30 件且集合 ≡ §8.2 M1∪M2∪M3∪M4（M5 零新增）", () => {
    expect(names).toHaveLength(30);
    expect(sorted(names)).toEqual(sorted([...M1, ...M2, ...M3, ...M4]));
  });

  it("postinstall 零提权负查：apps/cli/package.json 无 pre/install/post 生命周期脚本（ADR-0044）", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string>; name?: string };
    expect(pkg.name).toBe("@standardcode-oss/cli");
    const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "prepublishOnly", "prepare"];
    const present = Object.keys(pkg.scripts ?? {}).filter((s) => lifecycle.includes(s));
    expect(present).toEqual([]); // 零生命周期脚本=零提权零任意执行面
  });

  it("M5 新增面零注册：-sdb 旗标/uninstall 子命令//sandbox（M7）皆不在斜杠命令集合", () => {
    for (const cmd of M5_NOT_SLASH) expect(names, `M5 面 /${cmd} 不得注册为斜杠命令`).not.toContain(cmd);
  });
});
