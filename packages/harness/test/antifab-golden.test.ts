// WP-11（M3 DoD①）防伪造条目 Golden 化 CI 守卫：基线=evals/golden/baselines/anti-fabrication.json
// （npm run golden:capture:antifab 采集）。改装配（buildSubagentSystem 顺序/omit 分支/常量文本）不重采
// 基线 → 本测试红（compact-summarizer 同型纪律闸口）。"进提示词"断言：常量恒尾段且逐变体在位。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSubagentSystem, SUBAGENT_ANTI_FABRICATION } from "../src/subagent.ts";
import { BUILT_IN_AGENTS } from "../src/agent-registry.ts";

const baselinePath = fileURLToPath(new URL("../../../evals/golden/baselines/anti-fabrication.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
  schema: string;
  constant: string;
  variants: Record<string, string>;
};

describe("防伪造 Golden 守卫（ORC-041；M3 DoD①）", () => {
  it("常量文本与基线逐字一致（文本漂移=红，改文本须显式重采集）", () => {
    expect(SUBAGENT_ANTI_FABRICATION).toBe(baseline.constant);
    expect(baseline.schema).toBe("standardcode-golden-antifabrication@1");
  });

  it("逐变体与基线字节一致（装配顺序/omit 分支/内置定义提示词漂移=红）", () => {
    const parentContext = { memory: "<memory-section>", gitStatus: "<gitStatus-section>" };
    const rebuilt: Record<string, string> = {
      minimal: buildSubagentSystem({ name: "fixture", description: "fixture" }, undefined),
      minimalWithContext: buildSubagentSystem({ name: "fixture", description: "fixture" }, parentContext),
    };
    for (const def of BUILT_IN_AGENTS) {
      rebuilt[`builtin:${def.name}`] = buildSubagentSystem(def, undefined);
      rebuilt[`builtinWithContext:${def.name}`] = buildSubagentSystem(def, parentContext);
    }
    expect(rebuilt).toEqual(baseline.variants);
  });

  it("进提示词断言：常量恒为尾段（每变体 endsWith；带父上下文时记忆/状态段在前）", () => {
    for (const [name, system] of Object.entries(baseline.variants)) {
      expect(system.endsWith(SUBAGENT_ANTI_FABRICATION), name).toBe(true);
    }
    const withCtx = baseline.variants["builtinWithContext:general-purpose"];
    expect(withCtx.indexOf("<memory-section>")).toBeLessThan(withCtx.indexOf(SUBAGENT_ANTI_FABRICATION));
    expect(withCtx.indexOf("<gitStatus-section>")).toBeLessThan(withCtx.indexOf(SUBAGENT_ANTI_FABRICATION));
    // omit 面（Explore/Plan 不带记忆/gitStatus 段，防伪造条目仍在）
    for (const ro of ["Explore", "Plan"]) {
      const v = baseline.variants[`builtinWithContext:${ro}`];
      expect(v.includes("<memory-section>"), ro).toBe(false);
      expect(v.includes("<gitStatus-section>"), ro).toBe(false);
      expect(v.endsWith(SUBAGENT_ANTI_FABRICATION), ro).toBe(true);
    }
  });
});
