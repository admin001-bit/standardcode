// WP-01 命令注册门（ORC-050 行 299"发布默认关闭"的斜杠命令面）：flag 未开启时实验命令**不注册**。
// 分工：判定在 platform（resolveExperimental，纯函数）；本模块只做 flag→命令名的映射与表过滤——命令表属 L0（cli-terminal）。
// 门的**拒绝面**（默认关时被滤掉的名字）=FLAG_COMMANDS 并集＋侧信道命令（本 M=§8.2 行 365 七件）；**放行面**=对应 flag 开启时白名单命中名。
// 映射 [自定]（附录 C 登记义务随 M6-1 结果页；M7 落地见 ADR-0030 归属表＋mini-ADR-0049 四长尾语义）：
//   workflow → `/workflows`（WP-05）＋`/batch` `/loop`（WP-07）；
//   fork → `/fork` `/export`（WP-10）＋`/branch`（WP-07）；
//   teams → M6 无斜杠命令（工具面由 WP-06 起受同一门，BLK-08=① 对外工具集零增量）；`/btw` 为 teams flag 侧信道（WP-07，见下）。
// M7-WP-07（2026-09-24 X 会话）：四长尾从 EXPERIMENTAL_DEFERRED_COMMANDS 迁入对应 flag 映射并落地实现（门消费面不变语义，只加映射）。
//   `/branch`→fork、`/batch` `/loop`→workflow（均进注册表面，flag 开即注册）；`/btw`→teams 但为**侧信道**（teams:[] 永不进注册表，
//   仅 REPL 在 teams 开启时旁路派发——见 EXPERIMENTAL_SIDECHANNEL_COMMANDS 与 mini-ADR-0049）。CLI_COMMANDS 守恒 35 不变。

import { CLI_COMMANDS, type SlashCommand } from "./commands.ts";
import { SEND_MESSAGE_TOOL_NAME } from "@standardcode/capabilities";
import { EXPERIMENTAL_FLAGS, t, type ExperimentalFlag, type ExperimentalGate } from "@standardcode/platform";
import { workflowsCommand } from "./workflows-command.ts";
import { forkCommand } from "./fork-command.ts";
import { exportCommand } from "./export-command.ts";

/** 具名 flag → 门内斜杠命令名（缺项=该 flag 无命令面）。M7-WP-07：四长尾迁入——workflow 增 batch/loop、fork 增 branch（teams 仍无命令面，/btw 走侧信道）。 */
export const EXPERIMENTAL_FLAG_COMMANDS: Readonly<Record<ExperimentalFlag, readonly string[]>> = {
  workflow: ["workflows", "batch", "loop"],
  teams: [],
  fork: ["fork", "export", "branch"],
};

/**
 * 侧信道命令（永不进注册表的实验命令面）：teams flag 关联但 `teams:[]` 无斜杠命令面，
 * 故 /btw 不出现在 gatedRegistry（任一 flag 态都不注册），仅 REPL 在 teams 开启时以旁路单问派发（mini-ADR-0049）。
 * 仍入拒绝面——门关/未开一律拦截（与 BLK-06=① 七命令零注册同形）。
 */
export const EXPERIMENTAL_SIDECHANNEL_COMMANDS: readonly string[] = ["btw"];

/** M6 分期推后 M7 的四件——M7-WP-07 已迁入对应 flag 映射（或侧信道），本 M 清空（见 ADR-0030＋mini-ADR-0049）。 */
export const EXPERIMENTAL_DEFERRED_COMMANDS: readonly string[] = [];

/** 注册门管的命令名全集（FLAG_COMMANDS 并集＋侧信道命令；默认关时全数被过滤掉）。 */
export function experimentalCommandNames(): readonly string[] {
  const all = new Set<string>();
  for (const flag of EXPERIMENTAL_FLAGS) for (const name of EXPERIMENTAL_FLAG_COMMANDS[flag]) all.add(name);
  for (const name of EXPERIMENTAL_SIDECHANNEL_COMMANDS) all.add(name);
  return [...all];
}

/** 门内可用命令名（总闸关=空）。〔订正 2026-09-25 WP-14 收口：原注"推后 M7 四件恒不含"已过时——M7-WP-07 迁移后 `/branch`/`/batch`/`/loop` 已并入对应 flag，flag 开即属本函数返回集；`/btw` 为侧信道恒不含（仅 REPL 旁路派发）。〕 */
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

/**
 * 门内的命令实现（具名 flag → 斜杠命令体的映射面）。这些实现**不进** `CLI_COMMANDS`（维持其恰 35 件不变），
 * 仅作为候选并入后由 `gateCommands` 依门过滤：门关 → 被实验命令名全集滤除 → 注册表逐字等于 `CLI_COMMANDS`；
 * 对应 flag 开启 → 放行并入。WP-05 落 `/workflows`（flag=`workflow`）；/fork /export 由 WP-10 落；
 * M7-WP-07 落 `/branch`（fork）、`/batch` `/loop`（workflow）、`/btw`（侧信道，恒被滤除——见 EXPERIMENTAL_SIDECHANNEL_COMMANDS）。
 */
export function experimentalCommandImplementations(): readonly SlashCommand[] {
  // M6-WP-10：/fork /export 并入（flag=fork）；WP-05 /workflows 先例同形；M7-WP-07 增 /branch /batch /loop /btw。
  return [workflowsCommand, forkCommand, exportCommand, branchCommand, batchCommand, loopCommand, btwCommand];
}

// —— M7-WP-07：四长尾命令实现（flag 映射见 EXPERIMENTAL_FLAG_COMMANDS；语义+归属见 mini-ADR-0049）——
// 实现均委托 repl.ts 的 ctx 方法（走既有会话存储面/provider 面），本处只定义门内 SlashCommand 壳（i18n 双包 description/usage）。

/** `/branch [name]`（fork flag）：复制当前会话转录为新 session 并注册进会话索引（供 /resume），打印新分支 session id；不切换当前会话。 */
export const branchCommand: SlashCommand = {
  name: "branch",
  get usage() {
    return t("cmd.branch.usage");
  },
  get description() {
    return t("cmd.branch.desc");
  },
  async execute(args, ctx) {
    const r = await ctx.branch(args);
    ctx.write(r.text);
  },
};

/** `/btw <question>`（teams flag 侧信道）：旁路单问——用 provider 以最小上下文问、流式打印答案；不进主消息流、不写转录。 */
export const btwCommand: SlashCommand = {
  name: "btw",
  get usage() {
    return t("cmd.btw.usage");
  },
  get description() {
    return t("cmd.btw.desc");
  },
  async execute(args, ctx) {
    const r = await ctx.btw(args);
    ctx.write(r.text);
  },
};

/** `/loop <n> <prompt>`（workflow flag）：计数制循环——把 <prompt> 连续执行 <n> 次（上限防失控），无参=查看状态。 */
export const loopCommand: SlashCommand = {
  name: "loop",
  get usage() {
    return t("cmd.loop.usage");
  },
  get description() {
    return t("cmd.loop.desc");
  },
  async execute(args, ctx) {
    const r = await ctx.loop(args);
    ctx.write(r.text);
  },
};

/** `/batch <file>`（workflow flag）：读文件逐非空行作为 user turn 顺序执行（行数上限防失控）。 */
export const batchCommand: SlashCommand = {
  name: "batch",
  get usage() {
    return t("cmd.batch.usage");
  },
  get description() {
    return t("cmd.batch.desc");
  },
  async execute(args, ctx) {
    const r = await ctx.batch(args);
    ctx.write(r.text);
  },
};

/** 宿主默认装配：现表 + 门内实现 + 门（main.ts 消费）。门关时注册表逐字等于 `CLI_COMMANDS`（仍 35 件）。 */
export function gatedRegistry(gate: ExperimentalGate): readonly SlashCommand[] {
  return gateCommands([...CLI_COMMANDS, ...experimentalCommandImplementations()], gate);
}

// —— M6-WP-06：门内的**对外工具面**（DoD⑥"flag 默认关=工具零注册"）——
// 分工与命令面同形：判定在 platform（resolveExperimental），本模块只做 flag→工具名映射与表过滤。
// [自定] 接线点：工具面的实际装配（session.ts 把门内工具并入 `session.tools`）随 WP-07 成员注册表落地——
// 该卡提供 SendMessage 的投递口（deliver/router），本卡只落门映射与零注册断言（不落一个永远 not_reachable 的工具）。

/** 具名 flag → 门内对外工具名（缺项=该 flag 无工具面；BLK-08=① 团队任务工具集零增量，故 teams 只出 SendMessage）。 */
export const EXPERIMENTAL_FLAG_TOOLS: Readonly<Record<ExperimentalFlag, readonly string[]>> = {
  workflow: [],
  teams: [SEND_MESSAGE_TOOL_NAME],
  fork: [],
};

/** 门管的工具名全集（默认关时不得出现在装配面）。 */
export function experimentalToolNames(): readonly string[] {
  const all = new Set<string>();
  for (const flag of EXPERIMENTAL_FLAGS) for (const name of EXPERIMENTAL_FLAG_TOOLS[flag]) all.add(name);
  return [...all];
}

/** 门内可用工具名（总闸关=空；白名单未含某 flag=该 flag 工具仍不注册）。 */
export function activeExperimentalToolNames(gate: ExperimentalGate): readonly string[] {
  if (!gate.enabled) return [];
  const active = new Set<string>();
  for (const flag of gate.flags) for (const name of EXPERIMENTAL_FLAG_TOOLS[flag]) active.add(name);
  return [...active];
}
