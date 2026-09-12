// L1 agent 注册表：内置 agent 集 + 发现链优先级（v2.8 §6 ORC-022、§5.3 扩展点契约；M3 WP-06）。
// 内置集四件（ORC-022 原文；逐字段锚=A 级 claude-code-subagent.md §5.1 TOe/_440.js:69638-69998）：
//   general-purpose（tools ["*"]=全工具，CC nR :69638-69646）
//   Explore（只读白名单+omitClaudeMd+model inherit+非最新模型压中档，CC sP :8802-8812/iP :8768+
//     cap 关断 env CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP :8784——本仓 STANDARD_CODE_ 同构 ADR-0007）
//   Plan（同 Explore 只读位，CC YTe :8886-8897）
//   statusline-setup（定义壳：tools Read,Edit+model sonnet，CC kSn :69817-69827；渲染消费 M5+，卡边界）
//   （[CC] claude 兜底/web-fetch/claude-code-guide 等其余内置型不进首版——卡边界 B-03。）
// 优先级链（ORC-022 原文 policy > flag > project > user > plugin > built-in；CC USn :70106-70128 同构：
// 数组 [built-in, plugin, user, project, flag, policy] 低→高、Map 后写覆盖先写=同名高来源胜——DoD③④）。
// plugin 层 M4 前恒空；project/user 层定义供给=.md 解析（WP-09，SEC-070 信任门控）——本卡注册表只消费注入面。

import type { SubagentDefinition } from "./subagent.ts";

export type AgentSource = "built-in" | "plugin" | "user" | "project" | "flag" | "policy";

/** 低→高序（CC USn 数组 `l=[t,n,r,s,a,i]` :70106-70128 同构：遍历时后写覆盖=高来源胜）。 */
export const AGENT_SOURCE_ORDER: readonly AgentSource[] = ["built-in", "plugin", "user", "project", "flag", "policy"];

export interface RegisteredAgent extends SubagentDefinition {
  source: AgentSource;
}

/** Explore/Plan 只读白名单（本仓六工具中读三件；CC disallowedTools 写死名单在混淆侧不可复用，白名单表达等价 [自定]）。 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** 中档模型落点（"非最新模型压到中等档"的本仓目录档位 [自定]：本仓目录最新=claude-opus-5，中档=claude-sonnet-4-6）。 */
export const MEDIUM_CAP_MODEL = "claude-sonnet-4-6";

/**
 * 内置 agent 四件（M3 首版全集，ORC-022）。tools 缺省=全工具（general-purpose 语义，CC ["*]）。
 * statusline-setup=定义壳：其 tools/model/color 形状照 CC kSn；渲染消费=M5+（卡边界）。
 */
export const BUILT_IN_AGENTS: readonly RegisteredAgent[] = [
  {
    source: "built-in",
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
    // tools 缺省=继承父会话全工具（CC nR tools:["*"] 等价）
  },
  {
    source: "built-in",
    name: "Explore",
    description: "Fast read-only agent specialized for exploring codebases: find files by pattern, search for keywords and symbols.",
    tools: [...READ_ONLY_TOOLS],
    omitClaudeMd: true,
    omitGitStatus: true,
    model: "inherit",
    inheritCap: true,
    systemPrompt: "You are a read-only exploration agent. Never create, modify, or delete files; report findings with file paths and line numbers.",
  },
  {
    source: "built-in",
    name: "Plan",
    description: "Software architect agent for planning implementation strategies from provided context.",
    tools: [...READ_ONLY_TOOLS],
    omitClaudeMd: true,
    omitGitStatus: true,
    model: "inherit",
    inheritCap: true,
    systemPrompt: "You are a planning agent. Read and analyze the codebase, then produce a step-by-step implementation plan with critical files. Do not write or run code.",
  },
  {
    source: "built-in",
    name: "statusline-setup",
    description: "Use this agent to configure the user's status line settings.",
    tools: ["Read", "Edit"],
    model: "claude-sonnet-4-6", // CC kSn model:"sonnet" 档位映射本仓目录 [自定]
    inheritCap: false,
  },
];

export interface AgentRegistryOptions {
  /** 各来源定义（plugin M4 前恒空；project/user 磁盘解析=WP-09 接线）。 */
  sources?: Partial<Record<Exclude<AgentSource, "built-in">, Iterable<SubagentDefinition>>>;
  /** 内置整体禁用（CC wOe "none" 路径同构：CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS→STANDARD_CODE_ ADR-0007）。 */
  disableBuiltins?: boolean;
  /** 同名去重日志钩子（CC CAo :70142-70164 告警面同构 [自定]：winner=胜出的高来源定义）。 */
  onDuplicate?: (name: string, winner: RegisteredAgent, loser: RegisteredAgent) => void;
}

export interface AgentRegistry {
  /** 大小写不敏感解析（CC QP 归一化 :62015 同构）。 */
  get(name: string): RegisteredAgent | undefined;
  /** 去重后全表（同名只存最高来源）。 */
  list(): RegisteredAgent[];
  /** 可用类型名（validateSpawn ctx.availableTypes 消费面）。 */
  names(): string[];
}

/** 发现链注册表：六层来源低→高遍历，同名后者覆盖（USn 语义）；DoD③ 逐层覆盖/DoD④ 去重。 */
export function createAgentRegistry(opts: AgentRegistryOptions = {}): AgentRegistry {
  const merged = new Map<string, RegisteredAgent>(); // key=lowercase(name)
  const layers: RegisteredAgent[][] = [];
  if (!opts.disableBuiltins) layers.push(BUILT_IN_AGENTS.map((d) => ({ ...d })));
  layers.push([...(opts.sources?.plugin ?? [])].map((d) => ({ ...d, source: "plugin" as const })));
  layers.push([...(opts.sources?.user ?? [])].map((d) => ({ ...d, source: "user" as const })));
  layers.push([...(opts.sources?.project ?? [])].map((d) => ({ ...d, source: "project" as const })));
  layers.push([...(opts.sources?.flag ?? [])].map((d) => ({ ...d, source: "flag" as const })));
  layers.push([...(opts.sources?.policy ?? [])].map((d) => ({ ...d, source: "policy" as const })));
  for (const layer of layers) {
    for (const def of layer) {
      const key = def.name.toLowerCase();
      const prev = merged.get(key);
      if (prev && opts.onDuplicate) opts.onDuplicate(def.name, def, prev);
      merged.set(key, def); // 后写覆盖：来源序低→高=高来源胜
    }
  }
  const all = [...merged.values()];
  return {
    get: (name) => merged.get(name.toLowerCase()),
    list: () => [...all],
    names: () => all.map((d) => d.name),
  };
}

/**
 * WP-06 inherit cap（CC iP :8768-8784 语义）：model:"inherit" 且 inheritCap 置真的定义，
 * 父会话跑非最新模型时压到中档；env STANDARD_CODE_DISABLE_EXPLORE_INHERIT_CAP 可关断。
 * 纯函数（消费接线=spawn/模型解析面，非本卡 DoD）。
 */
export function resolveInheritCap(
  def: SubagentDefinition,
  ctx: { sessionModelIsLatest: boolean; disableCapEnv?: string },
): { model: string | undefined; capped: boolean } {
  if (def.model !== "inherit") return { model: def.model, capped: false };
  const capped = def.inheritCap === true && ctx.sessionModelIsLatest === false && ctx.disableCapEnv === undefined;
  return { model: capped ? MEDIUM_CAP_MODEL : def.model, capped };
}
