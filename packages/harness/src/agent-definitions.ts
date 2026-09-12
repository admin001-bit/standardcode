// WP-09（M3）：项目级 agent 定义 .md 解析（frontmatter 逐键照 A 级 claude-code-subagent.md §5.3 `IAo`
// _440.js:70356-70513）+ SEC-070 信任门/提权二次确认（纯函数面；磁盘枚举与 local 留痕落盘=platform 装配）。
// 规格：v2.8 §11 SEC-070（:459 规则原文）、§6 ORC-022（frontmatter 逐键照 A 级 §5.3）、§12.4 ENG-080（:504 schemaVersion）。
// 卡边界：skills/mcpServers 解析告警不实现（M4）；isolation=worktree 标记透传（remote 拒绝=WP-03 校验序列面）；
//   plugin 目录位留空（M4）；解析失败告警继续（[CC] RAo 失败回退纯内置同构 _440.js:70184-70233）。

import type { SubagentDefinition } from "./subagent.ts";
import type { PermissionMode } from "./permission-broker/index.ts";

// —— frontmatter 切分（最小 YAML 子集：`key: value` / 块列表 `- item` / 行内 `[a, b]`；# 注释）——

export interface FrontmatterSplit {
  fields: Record<string, string | string[]>;
  body: string;
}

/** `---` 包围的 frontmatter 切分；缺失/未闭合返回 null（文件按解析失败处理，DoD④ 告警继续）。 */
export function splitFrontmatter(text: string): FrontmatterSplit | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields: Record<string, string | string[]> = {};
  const lines = m[1]!.split(/\r?\n/);
  let pendingList: string[] | null = null;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const listM = /^\s*-\s+(.*)$/.exec(line);
    if (listM && pendingList) {
      pendingList.push(unquote(listM[1]!));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue; // 非 key:value 行（嵌套映射等）：值侧无消费面，容忍跳过（告警由逐键校验产生）
    const key = kv[1]!;
    const raw = kv[2]!.trim();
    if (raw === "") {
      pendingList = [];
      fields[key] = pendingList;
      continue;
    }
    pendingList = null;
    const inline = /^\[(.*)\]$/.exec(raw);
    fields[key] = inline ? inline[1]!.split(",").map((s) => unquote(s.trim())).filter((s) => s !== "") : unquote(raw);
  }
  return { fields, body: text.slice(m[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}
function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.filter((x) => x !== "");
  const inline = /^\[(.*)\]$/.exec(v.trim());
  const src = inline ? inline[1]! : v;
  const out = src.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return out.length > 0 ? out : undefined;
}

// —— 逐键校验（A 级 §5.3 行号=IAo 内锚点）——

/** M3 无消费面的 §5.3 键（解析合法但仅告警；对应里程碑见各分支文案）。 */
const NOT_CONSUMED_KEYS: readonly string[] = ["color", "memory", "effort", "disallowedTools", "observer", "observerMessage", "observeSubagents"];

const PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "plan", "bypassPermissions"]; // 本仓四模式（EXE-001；[CC] ix 的 dontAsk CI 档非 def 面）
const ISOLATION_VALUES: readonly string[] = ["worktree", "remote"]; // :70407-70415
const MEMORY_VALUES: readonly string[] = ["user", "project", "local"]; // :70398-70406
const EFFORT_ENUM: readonly string[] = ["off", "low", "medium", "high"]; // LD 枚举本仓档位面（WP-07 [自定] 同源）

export const AGENT_SCHEMA_VERSION = 1;

/** 单文件解析产物：def=null=文件整体拒收（错误/缺必填，调用方告警继续=DoD④）；warnings=丢键/告警位。 */
export interface ParsedAgentFile {
  file: string;
  def: SubagentDefinition | null;
  warnings: string[];
}

export function parseAgentMarkdown(text: string, file: string): ParsedAgentFile {
  const warnings: string[] = [];
  const fm = splitFrontmatter(text);
  if (!fm) {
    return { file, def: null, warnings: [`${file}: missing or unterminated frontmatter (--- block required)`] };
  }
  const f = fm.fields;

  // name（:70359-70375）：必填；不得以 '-' 开头；NFKC 后不得含 ':'（插件命名空间保留）。
  const name = asString(f.name);
  if (!name) return { file, def: null, warnings: [`${file}: frontmatter 'name' is required`] };
  if (name.startsWith("-")) return { file, def: null, warnings: [`${file}: agent name must not start with '-'`] };
  if (name.normalize("NFKC").includes(":")) return { file, def: null, warnings: [`${file}: names must not contain ':' (reserved for plugin namespacing)`] };

  // description（:70376-70385）：必填；`\n` 字面量转真实换行（成为 whenToUse）。
  const rawDesc = asString(f.description);
  if (rawDesc === undefined || rawDesc === "") return { file, def: null, warnings: [`${file}: frontmatter 'description' is required`] };
  const description = rawDesc.replace(/\\n/g, "\n");

  // schemaVersion（ENG-080 DoD⑤，[自定] 键位——CC §5.3 无此键，本仓落盘契约统一带版本）：缺失=迁移提示，不拒收。
  const schemaRaw = asString(f.schemaVersion);
  if (schemaRaw === undefined) {
    warnings.push(`${file}: schemaVersion missing (ENG-080 migration hint: agent manifest contract takes schemaVersion:${AGENT_SCHEMA_VERSION})`);
  } else if (schemaRaw !== String(AGENT_SCHEMA_VERSION)) {
    warnings.push(`${file}: unknown schemaVersion '${schemaRaw}' (current contract = ${AGENT_SCHEMA_VERSION}; parsed best-effort)`);
  }

  const def: SubagentDefinition = { name, description };

  // 正文=getSystemPrompt 主体（A 级 §5.3 产出对象 70466-70508；memory 拼接位 M4 前无载体）。空正文=缺省最小提示词（既有语义）。
  const body = fm.body.trim();
  if (body !== "") def.systemPrompt = body;

  // model（:70386-70391）：字符串，"inherit" 特判（inheritCap 压档位内置集专用，项目定义不注入）。
  const model = asString(f.model);
  if (model !== undefined && model !== "") def.model = model;

  // tools（:70435 mF 逗号/列表解析）→ 白名单；缺省=继承父全工具。disallowedTools（:70440）本仓只读面用白名单表达（WP-06 偏差先例）→告警。
  const tools = asList(f.tools);
  if (tools) def.tools = tools;

  // permissionMode（:70422-70427）：本仓四模式枚举，越枚=丢键告警。
  const pm = asString(f.permissionMode);
  if (pm !== undefined && pm !== "") {
    if ((PERMISSION_MODES as readonly string[]).includes(pm)) def.permissionMode = pm as PermissionMode;
    else warnings.push(`${file}: permissionMode '${pm}' not in {${PERMISSION_MODES.join("|")}} — ignored`);
  }

  // maxTurns（:70428-70433）：正整数。
  const mt = asString(f.maxTurns);
  if (mt !== undefined && mt !== "") {
    if (/^\d+$/.test(mt) && Number(mt) >= 1) def.maxTurns = Number(mt);
    else warnings.push(`${file}: maxTurns must be a positive integer — ignored`);
  }

  // background（:70392-70397）：仅 'true'/'false'。
  const bg = asString(f.background);
  if (bg !== undefined && bg !== "") {
    if (bg === "true" || bg === "false") def.background = bg === "true";
    else warnings.push(`${file}: background must be 'true' or 'false' — ignored`);
  }

  // isolation（:70407-70415）：worktree=标记透传；remote 拒绝在 WP-03 校验序列既有段（def 位只携带标记）。
  const iso = asString(f.isolation);
  if (iso !== undefined && iso !== "") {
    if ((ISOLATION_VALUES as readonly string[]).includes(iso)) def.isolation = iso as "worktree" | "remote";
    else warnings.push(`${file}: isolation '${iso}' not in {${ISOLATION_VALUES.join(",")}} — ignored`);
  }

  // initialPrompt（:70443-70444；SEC-070 列举字段）：透传位（spawn 消费=后续卡，登记观察）。
  const ip = asString(f.initialPrompt);
  if (ip !== undefined && ip !== "") def.initialPrompt = ip;

  // hooks（:70451-70463 表内 `PAo` 70251-70259）：M4 前无实体消费（卡边界），但键在场=SEC-070 提权请求判定输入。
  if (f.hooks !== undefined) def.hooksRequested = true;

  // skills / mcpServers（70442 / 70451-70463）：卡边界=解析告警不实现（M4）。
  if (f.skills !== undefined) warnings.push(`${file}: skills ignored (M4 — not implemented)`);
  if (f.mcpServers !== undefined) warnings.push(`${file}: mcpServers ignored (M4 — not implemented)`);

  // 其余 §5.3 键（本里程碑无消费面）：枚举合法=丢键告警；非法值=值面告警。
  for (const key of NOT_CONSUMED_KEYS) {
    if (f[key] === undefined) continue;
    if (key === "memory") {
      const v = asString(f.memory);
      if (v !== undefined && !(MEMORY_VALUES as readonly string[]).includes(v)) {
        warnings.push(`${file}: memory '${v}' not in {${MEMORY_VALUES.join(",")}} — ignored`);
        continue;
      }
    }
    if (key === "effort") {
      const v = asString(f.effort);
      if (v !== undefined && !(EFFORT_ENUM as readonly string[]).includes(v) && !/^\d+$/.test(v)) {
        warnings.push(`${file}: effort '${v}' not a known level or positive integer — ignored`);
        continue;
      }
    }
    warnings.push(`${file}: ${key} parsed but not consumed in M3 — ignored`);
  }

  // 未知键（§5.3 清单外）：告警忽略（不拒收整文件，DoD④ 保守面）。
  const known = new Set(["name", "description", "schemaVersion", "model", "tools", "permissionMode", "maxTurns", "background", "isolation", "initialPrompt", "hooks", "skills", "mcpServers", ...NOT_CONSUMED_KEYS]);
  for (const key of Object.keys(f)) {
    if (!known.has(key)) warnings.push(`${file}: unknown frontmatter key '${key}' — ignored`);
  }

  return { file, def, warnings };
}

// —— SEC-070 信任门 + 提权二次确认（:459 规则原文；UI-061 信任位=platform trust store 消费方注入）——

/**
 * 提权模式判定 [自定]：相对 default 仲裁更弱即提权请求——acceptEdits（免确认放行编辑）与
 * bypassPermissions（SEC-070 原文示例）；plan/default 非提权（plan=更严）。
 */
export const ESCALATING_PERMISSION_MODES: readonly PermissionMode[] = ["acceptEdits", "bypassPermissions"];

/** local 层留痕记录（settings.local.json `agentTrust` 映射的值形状；键=定义 name 小写归一）。 */
export interface AgentTrustRecord {
  permissionMode?: PermissionMode;
  hooks?: boolean;
  confirmedAt?: string;
}

export interface ProjectTrustGateInput {
  /** 工作区信任态（UI-061 通过与否；platform isTrusted/createTrustGate effectiveTrusted 供给）。 */
  trusted: boolean;
  /** local 层既有留痕（readAgentTrust 供给）。 */
  records?: Record<string, AgentTrustRecord>;
  /** 二次确认 UI 面（缺席=无确认通道 → 提权字段 fail-closed 剥离）。 */
  confirm?: (name: string, fields: string[]) => Promise<boolean>;
  /** 确认通过后的落盘钩子（platform recordAgentTrust 供给=“落 local 层留痕”动作位）。 */
  onConfirmed?: (name: string, record: AgentTrustRecord) => void | Promise<void>;
  now?: () => string;
}

export interface ProjectAgentGateResult {
  /** 可注册进 registry 的定义（project 层注入面）。 */
  loadable: SubagentDefinition[];
  /** 未信任整层不加载（SEC-070"未信任时仅内置 agent 可用"；调用方据此传空 sources.project）。 */
  layerWithheld: boolean;
  /** 逐件留痕：提权未确认被剥离的字段。 */
  stripped: { file: string; name: string; fields: string[] }[];
  warnings: string[];
}

/**
 * 项目级定义门控（SEC-070 全规则）：
 * ① trusted=false → 一律不加载（layerWithheld，含提权字段与否）；
 * ② trusted=true → 提权字段（permissionMode∈ESCALATING ∥ hooks 在场）无 local 留痕 → MUST 二次确认；
 *    确认=通过并落留痕（onConfirmed）；拒绝/无通道 → 剥离提权字段后保留定义（fail-closed=字段不生效，非整件丢弃）。
 */
export async function gateProjectAgentDefinitions(defs: ParsedAgentFile[], ctx: ProjectTrustGateInput): Promise<ProjectAgentGateResult> {
  if (!ctx.trusted) {
    return {
      loadable: [],
      layerWithheld: true,
      stripped: [],
      warnings: defs.filter((d) => d.def).map((d) => `${d.file}: project-level agent not loaded (workspace untrusted — SEC-070)`),
    };
  }
  const loadable: SubagentDefinition[] = [];
  const stripped: ProjectAgentGateResult["stripped"] = [];
  const warnings: string[] = [];
  for (const parsed of defs) {
    if (!parsed.def) continue; // 拒收文件由调用方告警（DoD④）
    const def = parsed.def;
    const record = ctx.records?.[def.name.toLowerCase()] ?? {};
    const need: string[] = [];
    if (def.permissionMode && (ESCALATING_PERMISSION_MODES as readonly string[]).includes(def.permissionMode) && record.permissionMode !== def.permissionMode) {
      need.push(`permissionMode=${def.permissionMode}`);
    }
    if (def.hooksRequested && record.hooks !== true) need.push("hooks");
    if (need.length > 0) {
      const ok = ctx.confirm ? await ctx.confirm(def.name, need) : false;
      if (ok) {
        const next: AgentTrustRecord = { ...record };
        if (need.some((x) => x.startsWith("permissionMode="))) next.permissionMode = def.permissionMode;
        if (need.includes("hooks")) next.hooks = true;
        next.confirmedAt = (ctx.now ?? (() => new Date().toISOString()))();
        if (ctx.onConfirmed) await ctx.onConfirmed(def.name, next);
      } else {
        const gone: string[] = [];
        if (need.some((x) => x.startsWith("permissionMode="))) {
          delete def.permissionMode;
          gone.push(`permissionMode (escalating ${need.find((x) => x.startsWith("permissionMode=")) ?? ""} unconfirmed)`);
        }
        if (need.includes("hooks")) {
          delete def.hooksRequested;
          gone.push("hooks (unconfirmed)");
        }
        stripped.push({ file: parsed.file, name: def.name, fields: gone });
        warnings.push(`${parsed.file}: escalation unconfirmed — ${gone.join(", ")} stripped (SEC-070 fail-closed)`);
      }
    }
    loadable.push(def);
  }
  return { loadable, layerWithheld: false, stripped, warnings };
}
