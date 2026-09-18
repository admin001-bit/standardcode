// WP-01 命令注册门（ORC-050 行 299"发布默认关闭"的斜杠命令面）：flag 未开启时实验命令**不注册**。
// 分工：判定在 platform（resolveExperimental，纯函数）；本模块只做 flag→命令名的映射与表过滤——命令表属 L0（cli-terminal）。
// 门的**拒绝面**（默认关时被滤掉的名字）=§8.2 行 365 M6 分期七件；**放行面**（开启且白名单命中）=M6 三件。
// 映射 [自定]（附录 C 登记义务随 M6-1 结果页）：
//   workflow → `/workflows`（WP-05）；teams → M6 无斜杠命令（工具面由 WP-06 起受同一门，BLK-08=① 对外工具集零增量）；
//   fork → `/fork` `/export`（WP-10）。
// BLK-06=①（2026-09-18 用户裁决）：`/branch` `/batch` `/loop` `/btw` 推后 M7——不进任何 flag 映射（本 M 无实现者，
// B-03 不提前实现）但**留在拒绝面内**：即便被误注册，门关时同样不注册、开启时也不因总闸放行（七命令零注册=DoD① 字面）。
// M7 落地时把这四名从 EXPERIMENTAL_DEFERRED_COMMANDS 移入对应 flag 映射（一行迁移，随 M7 命令分期登记）。
// 命令全集断言（M5 `wp10-milestone.test.ts` 恰 30 件）在默认关态逐字不变。

import { CLI_COMMANDS, type SlashCommand } from "./commands.ts";
import { EXPERIMENTAL_FLAGS, type ExperimentalFlag, type ExperimentalGate } from "@standardcode/platform";

/** 具名 flag → 门内斜杠命令名（缺项=该 flag 无命令面）。 */
export const EXPERIMENTAL_FLAG_COMMANDS: Readonly<Record<ExperimentalFlag, readonly string[]>> = {
  workflow: ["workflows"],
  teams: [],
  fork: ["fork", "export"],
};

/** M6 分期但推后 M7 的四件（§8.2 行 365，BLK-06=①）：入拒绝面、无 flag 归属 ⇒ 本 M 恒不放行。 */
export const EXPERIMENTAL_DEFERRED_COMMANDS: readonly string[] = ["branch", "batch", "loop", "btw"];

/** 注册门管的命令名全集（M6 七件=未开启时被过滤掉的面）。 */
export function experimentalCommandNames(): readonly string[] {
  const all = new Set<string>();
  for (const flag of EXPERIMENTAL_FLAGS) for (const name of EXPERIMENTAL_FLAG_COMMANDS[flag]) all.add(name);
  for (const name of EXPERIMENTAL_DEFERRED_COMMANDS) all.add(name);
  return [...all];
}

/** 门内可用命令名（总闸关=空；推后 M7 四件恒不含）。 */
export function activeExperimentalCommandNames(gate: ExperimentalGate): readonly string[] {
  if (!gate.enabled) return [];
  const active = new Set<string>();
  for (const flag of gate.flags) for (const name of EXPERIMENTAL_FLAG_COMMANDS[flag]) active.add(name);
  return [...active];
}

/**
 * 注册门：从候选表里滤掉"属于实验命令面但当前未开启"的条目。
 * 默认关（gate.enabled=false）=实验命令名全数不注册；开启但白名单未含某 flag=该 flag 命令仍不注册。
 * 非实验命令一律原样保留（M1–M5 既有命令行为零变化）。
 */
export function gateCommands(all: readonly SlashCommand[], gate: ExperimentalGate): readonly SlashCommand[] {
  const gated = new Set(experimentalCommandNames());
  const active = new Set(activeExperimentalCommandNames(gate));
  return all.filter((c) => !gated.has(c.name) || active.has(c.name));
}

/** 宿主默认装配：现表 + 门（main.ts 消费）。 */
export function gatedRegistry(gate: ExperimentalGate): readonly SlashCommand[] {
  return gateCommands(CLI_COMMANDS, gate);
}
