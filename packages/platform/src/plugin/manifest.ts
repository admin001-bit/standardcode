// WP-09：plugin.json manifest 解析（ECO-030/031；schemaVersion:1=ENG-080 落盘契约）。
// 键位 [自定]（卡 DoD①：照 ECO-031 四组件+manifest 名版本）——通用信封 name/version/description/schemaVersion，
// 组件声明 commands/agents/skills/hooks/mcpServers。commands=M6+ 消费（本卡仅解析+确认清单展示+持久化）；
// hooks/mcpServers=内联声明（形状复用 settings.hooks / mcpServers，消费经 WP-04/WP-01 各源位）；
// agents/skills=目录位声明（缺省 agents/、skills/；声明值=相对 pluginRoot 的目录）。
// 坏件告警继续（[CC] 同构形制：单件解析失败=def null+告警，不抛不阻断他件）。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_SCHEMA_VERSION = 1;
/** 组件目录缺省位（未显式声明且目录存在时生效）。 */
export const DEFAULT_AGENTS_DIR = "agents";
export const DEFAULT_SKILLS_DIR = "skills";

/** manifest 内联 hooks 声明（settings.hooks 同形：事件 → matcher 组数组；非法形状=整键丢弃+告警）。 */
export type PluginHooksDeclaration = Record<string, unknown>;

export interface PluginComponentPaths {
  /** 组件名（确认清单逐名用）。 */
  commands: string[];
  /** agent .md 目录（pluginRoot 相对）。 */
  agentsDirs: string[];
  /** 技能目录（各子目录含 SKILL.md）。 */
  skillsDirs: string[];
  /** 内联 hooks 声明（null=无声明）。 */
  hooks: PluginHooksDeclaration | null;
  /** 内联 MCP server 声明（键=server 名；null=无声明）。 */
  mcpServers: Record<string, unknown> | null;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  components: PluginComponentPaths;
}

export interface ParsedPluginManifest {
  file: string;
  manifest: PluginManifest | null;
  warnings: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** 字符串数组声明（行内数组形；非数组/非串元素=丢+告警）。 */
function strArray(v: unknown, key: string, warnings: string[]): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    warnings.push(`${key} must be a string array (ignored)`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s === undefined) warnings.push(`${key} contains a non-string entry (dropped)`);
    else out.push(s);
  }
  return out;
}

/** 目录声明归一：去重+拒绝越出 pluginRoot（.. 上跳）。 */
function normalizeDirs(raw: string[] | undefined, fallback: string | undefined, pluginRoot: string, key: string, warnings: string[]): string[] {
  const src = raw && raw.length > 0 ? raw : fallback ? [fallback] : [];
  const out: string[] = [];
  for (const rel of src) {
    const abs = path.resolve(pluginRoot, rel);
    if (abs !== pluginRoot && !abs.startsWith(pluginRoot + path.sep)) {
      warnings.push(`${key} "${rel}" escapes plugin root (ignored)`);
      continue;
    }
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

function strRecord(v: unknown, key: string, warnings: string[]): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    warnings.push(`${key} must be an object (ignored)`);
    return undefined;
  }
  return v as Record<string, unknown>;
}

/** plugin.json 文本解析（不抛：坏 JSON/缺必填=manifest null+告警继续）。 */
export function parsePluginManifest(text: string, file: string, pluginRoot = path.dirname(file)): ParsedPluginManifest {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { file, manifest: null, warnings: [`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — plugin skipped`] };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { file, manifest: null, warnings: [`${file}: manifest is not a JSON object — plugin skipped`] };
  }
  const d = doc as Record<string, unknown>;
  if (d.schemaVersion !== undefined && d.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    warnings.push(`${file}: unsupported schemaVersion ${String(d.schemaVersion)} (current contract = ${PLUGIN_SCHEMA_VERSION}; parsed best-effort)`);
  } else if (d.schemaVersion === undefined) {
    warnings.push(`${file}: schemaVersion missing (ENG-080 migration hint: plugin manifest contract takes schemaVersion:${PLUGIN_SCHEMA_VERSION})`);
  }
  const name = str(d.name);
  if (name === undefined) return { file, manifest: null, warnings: [...warnings, `${file}: manifest 'name' is required`] };
  const version = str(d.version);
  if (version === undefined) return { file, manifest: null, warnings: [...warnings, `${file}: manifest 'version' is required`] };
  const description = str(d.description) ?? "";

  const commands = strArray(d.commands, `${file}: commands`, warnings) ?? [];
  const agentsDeclared = strArray(d.agents, `${file}: agents`, warnings);
  const skillsDeclared = strArray(d.skills, `${file}: skills`, warnings);
  const hooksRaw = strRecord(d.hooks, `${file}: hooks`, warnings);
  const mcpRaw = strRecord(d.mcpServers, `${file}: mcpServers`, warnings);

  const agentsFallback = existsSync(path.join(pluginRoot, DEFAULT_AGENTS_DIR)) ? DEFAULT_AGENTS_DIR : undefined;
  const skillsFallback = existsSync(path.join(pluginRoot, DEFAULT_SKILLS_DIR)) ? DEFAULT_SKILLS_DIR : undefined;
  return {
    file,
    manifest: {
      name,
      version,
      description,
      components: {
        commands,
        agentsDirs: normalizeDirs(agentsDeclared, agentsFallback, pluginRoot, `${file}: agents`, warnings),
        skillsDirs: normalizeDirs(skillsDeclared, skillsFallback, pluginRoot, `${file}: skills`, warnings),
        hooks: hooksRaw ?? null,
        mcpServers: mcpRaw ?? null,
      },
    },
    warnings,
  };
}

/** 读目录内 plugin.json（不存在=def null+告警；调用方继续处理其余件）。 */
export function readPluginManifest(pluginRoot: string, file = path.join(pluginRoot, PLUGIN_MANIFEST_FILE)): ParsedPluginManifest {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, manifest: null, warnings: [`${file}: ${PLUGIN_MANIFEST_FILE} not found — plugin skipped`] };
  }
  return parsePluginManifest(text, file, pluginRoot);
}
