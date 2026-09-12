// WP-11 防伪造 Golden 采集（M3 DoD①"防伪造条目进提示词并 Golden 化"的采集器）。
// 用法：node evals/golden/capture-antifab.mjs > evals/golden/baselines/anti-fabrication.json
// 口径：快照=buildSubagentSystem 实际装配产物（生产同源函数——装配序/常量文本/omit 位变化必然反映到输出）；
// 夹具全合成（<memory>/<git> 占位段，无真实用户数据）；无时间戳/版本注入（跨机可比，同 capture.mjs 纪律）。
import { buildSubagentSystem, SUBAGENT_ANTI_FABRICATION } from "../../packages/harness/src/subagent.ts";
import { BUILT_IN_AGENTS } from "../../packages/harness/src/agent-registry.ts";

const parentContext = { memory: "<memory-section>", gitStatus: "<gitStatus-section>" };

const variants = {
  minimal: buildSubagentSystem({ name: "fixture", description: "fixture" }, undefined),
  minimalWithContext: buildSubagentSystem({ name: "fixture", description: "fixture" }, parentContext),
};
for (const def of BUILT_IN_AGENTS) {
  variants[`builtin:${def.name}`] = buildSubagentSystem(def, undefined);
  variants[`builtinWithContext:${def.name}`] = buildSubagentSystem(def, parentContext);
}

const snapshot = {
  schema: "standardcode-golden-antifabrication@1",
  constant: SUBAGENT_ANTI_FABRICATION,
  assemblyOrder: ["definition.systemPrompt?", "parentContext.memory?(unless omitClaudeMd)", "parentContext.gitStatus?(unless omitGitStatus)", "ANTI_FABRICATION(always)"],
  variants,
};

process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
