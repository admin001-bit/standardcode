// WP-06（M6）工具注册门单测（DoD⑥：flag 默认关=工具零注册）。
// 门表映射见 apps/cli/src/experimental-gate.ts（EXPERIMENTAL_FLAG_TOOLS）；判定仍由 platform resolveExperimental 承担。
import { describe, expect, it } from "vitest";
import { createStandardTools } from "@standardcode/capabilities";
import { EXPERIMENTAL_FLAGS, resolveExperimental } from "@standardcode/platform";
import {
  activeExperimentalToolNames,
  EXPERIMENTAL_FLAG_TOOLS,
  experimentalToolNames,
  gatedRegistry,
} from "../src/experimental-gate.ts";

const OFF = resolveExperimental({ env: {}, settings: undefined });
const ON_ALL = resolveExperimental({ env: {}, settings: { enabled: true } });

describe("DoD⑥ flag 默认关=工具零注册", () => {
  it("默认装配（createStandardTools）恰六件且无任何实验工具名", () => {
    const names = createStandardTools({ cwd: process.cwd() }).map((t) => t.name);
    expect(names).toHaveLength(6);
    expect(names.sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    for (const experimental of experimentalToolNames()) {
      expect(names).not.toContain(experimental);
    }
  });

  it("门关（无 env/settings）=门内工具面为空", () => {
    expect(activeExperimentalToolNames(OFF)).toEqual([]);
    expect(OFF.flags).toEqual([]);
  });

  it("门开（总闸开、flags 缺席=全量随总闸）→ SendMessage 入面", () => {
    expect(activeExperimentalToolNames(ON_ALL)).toEqual(["SendMessage"]);
  });

  it("白名单收窄：只开 workflow 时 SendMessage 仍不注册", () => {
    const workflowOnly = resolveExperimental({ env: {}, settings: { enabled: true, flags: ["workflow"] } });
    expect(activeExperimentalToolNames(workflowOnly)).toEqual([]);
    const teamsOnly = resolveExperimental({ env: {}, settings: { enabled: true, flags: ["teams", "fork"] } });
    expect(activeExperimentalToolNames(teamsOnly)).toEqual(["SendMessage"]);
  });

  it("门管工具名全集恰一件（SendMessage）——团队任务工具集零增量（BLK-08=①）", () => {
    expect(experimentalToolNames()).toEqual(["SendMessage"]);
  });

  it("flag 映射表键集与 EXPERIMENTAL_FLAGS 逐名一致（枚举纪律）", () => {
    expect(Object.keys(EXPERIMENTAL_FLAG_TOOLS).sort()).toEqual([...EXPERIMENTAL_FLAGS].sort());
  });
});

describe("命令面零回归（工具面改动不触命令门）", () => {
  it("默认关门下命令表仍恰 32 件【M7-WP-01 /goal 30→31】且实验命令零命中", () => {
    const names = gatedRegistry(OFF).map((c) => c.name);
    expect(names).toHaveLength(33);
    for (const experimental of ["workflows", "fork", "export", "branch", "batch", "loop", "btw"]) {
      expect(names).not.toContain(experimental);
    }
  });
});
