// WP-05：SKILL.md frontmatter 解析（dig-06 §3 两级字段集 :45390-45530）。
// 解析失败告警继续（:253239）；name 缺省取目录名；键名 dash-case（allowed-tools/disable-model-invocation/
// user-invocable/when_to_use/argument-hint 照 [CC] frontmatter 键位）。
// paths 条件激活：解析合法但 M4 不消费（告警留位，[自定] 登记卡边界）；hooks 字段解析后忽略+告警
//（[CC] MCP 技能同形 "cannot register hooks" :291916——磁盘技能同取严，hooks 注入面=WP-10 def.hooks 卡）。
import { createHash } from "node:crypto";
import { splitFrontmatter } from "@standardcode/harness";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  argumentHint?: string;
  model?: string;
  effort?: string;
}

export interface ParsedSkillMarkdown {
  frontmatter: SkillFrontmatter;
  body: string;
  contentHash: string;
  warnings: string[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
function asBool(v: unknown): boolean | undefined {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}
function asStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return out.length > 0 ? out : undefined;
}

/** argument-hint 值形 `[who]`（[CC] 字面方括号形）——splitFrontmatter 会解析成行内数组，此处还原方括号字符串 [自定]。 */
function argumentHintOf(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return `[${(v as string[]).join(", ")}]`;
  return undefined;
}

/** SKILL.md → frontmatter+正文（frontmatter 缺失/坏=告警+全文本当正文继续——解析失败告警继续 :253239）。 */
export function parseSkillMarkdown(text: string, file: string): ParsedSkillMarkdown {
  const warnings: string[] = [];
  const fm = splitFrontmatter(text);
  if (!fm) {
    warnings.push(`${file}: missing or unterminated frontmatter (--- block required) — loaded as body-only skill`);
    return { frontmatter: {}, body: text, contentHash: hashContent(text), warnings };
  }
  const f = fm.fields as Record<string, unknown>;
  const unknownKeys = Object.keys(f).filter(
    (k) => !["name", "description", "when_to_use", "allowed-tools", "disallowed-tools", "disable-model-invocation", "user-invocable", "argument-hint", "model", "effort", "paths", "hooks", "context", "version", "metadata", "arguments", "shell", "agent", "background", "fallback"].includes(k),
  );
  for (const k of unknownKeys) warnings.push(`${file}: unknown frontmatter key "${k}" ignored`);
  if (f.paths !== undefined) warnings.push(`${file}: frontmatter "paths" conditional activation is not consumed in M4 (parsed, ignored)`);
  if (f.hooks !== undefined) warnings.push(`${file}: frontmatter "hooks" cannot be registered from skill files (ignored)`);
  if (f.context !== undefined) warnings.push(`${file}: frontmatter "context: fork" form is not supported in M4 (ignored)`);
  return {
    frontmatter: {
      name: asString(f.name),
      description: asString(f.description),
      whenToUse: asString(f.when_to_use),
      allowedTools: asStringList(f["allowed-tools"]),
      disableModelInvocation: asBool(f["disable-model-invocation"]),
      ...(asBool(f["user-invocable"]) !== undefined ? { userInvocable: asBool(f["user-invocable"]) } : {}),
      argumentHint: argumentHintOf(f["argument-hint"]),
      model: asString(f.model),
      effort: asString(f.effort),
    },
    body: fm.body,
    contentHash: hashContent(text),
    warnings,
  };
}

/** contentHash（[CC] Bun.hash(content).toString(36) :253252 的 node 等价：sha256 前 12 hex [自定]）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}
