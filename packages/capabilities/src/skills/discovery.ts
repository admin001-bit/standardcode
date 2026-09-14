// WP-05：技能发现三源（DoD②）——user ~/.standardcode/skills + 项目 .standardcode/skills（SEC-070 信任门前置）
// + plugin 层（注入面，WP-09 前调用方恒传 []）。>1MB 跳过（ek=1e6 :253252）；同名去重可调用版优先（qes :163860），
// 同优先级高来源胜（user>project>plugin [自定]，与 settings 优先级同向）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseSkillMarkdown, type SkillFrontmatter } from "./frontmatter.ts";

export const SKILL_FILE_LIMIT_BYTES = 1_000_000; // ek = 1e6（dig-06 §3 >1MB 跳过）

export type SkillSource = "user" | "project" | "plugin";

export interface LoadedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  source: SkillSource;
  /** SKILL.md 所在目录（${STANDARD_CODE_SKILL_DIR} 替换基底）。 */
  dir: string;
  body: string;
  contentHash: string;
}

export interface LoadSkillsResult {
  skills: LoadedSkill[];
  warnings: string[];
}

/** 单目录枚举装载（WP-09 起对外导出：plugin 技能目录注入面消费——dir=技能父目录，各子目录含 SKILL.md）。 */
export function loadSkillsFromDir(dir: string, source: SkillSource, warnings: string[]): LoadedSkill[] {
  return discoverDir(dir, source, warnings);
}

function discoverDir(dir: string, source: SkillSource, warnings: string[]): LoadedSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // 目录不存在=该源无技能（常态）
  }
  const out: LoadedSkill[] = [];
  entries.sort();
  for (const entry of entries) {
    const file = path.join(dir, entry, "SKILL.md");
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // 无 SKILL.md=非技能目录
    }
    if (stat.size > SKILL_FILE_LIMIT_BYTES) {
      warnings.push(`skill "${entry}" (${file}) exceeds 1MB — skipped`); // :253252 ek 形状
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      warnings.push(`skill "${entry}" (${file}) unreadable (${err instanceof Error ? err.message : String(err)}) — skipped`);
      continue;
    }
    const parsed = parseSkillMarkdown(text, file);
    warnings.push(...parsed.warnings);
    const fm: SkillFrontmatter = parsed.frontmatter;
    out.push({
      name: fm.name ?? entry, // 缺名取目录名（dig-06 §3）
      description: fm.description ?? "",
      ...(fm.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
      disableModelInvocation: fm.disableModelInvocation === true,
      userInvocable: fm.userInvocable !== false,
      ...(fm.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
      source,
      dir: path.join(dir, entry),
      body: parsed.body,
      contentHash: parsed.contentHash,
    });
  }
  return out;
}

/** 同名去重：可调用版优先（qes :163860 disableModelInvocation 版让位）；同优先级 user>project>plugin（[自定]）。 */
function dedupe(skills: LoadedSkill[]): LoadedSkill[] {
  const rank = (s: LoadedSkill): number => (s.disableModelInvocation ? 0 : 1);
  const sourceRank: Record<SkillSource, number> = { user: 2, project: 1, plugin: 0 };
  const byName = new Map<string, LoadedSkill>();
  for (const s of skills) {
    const prior = byName.get(s.name);
    if (!prior) {
      byName.set(s.name, s);
      continue;
    }
    const better = rank(s) > rank(prior) || (rank(s) === rank(prior) && sourceRank[s.source] > sourceRank[prior.source]);
    if (better) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface LoadSkillsOptions {
  home?: string;
  projectRoot?: string;
  /** 工作区信任态（SEC-070：项目级 skill 定义信任确认前一律不加载）。 */
  trusted: boolean;
  /** plugin 层注入面（WP-09 前恒 []）。 */
  pluginSkills?: LoadedSkill[];
}

export function loadSkills(opts: LoadSkillsOptions): LoadSkillsResult {
  const warnings: string[] = [];
  const userDir = path.join(opts.home ?? "", ".standardcode", "skills");
  const skills = [
    ...discoverDir(userDir, "user", warnings),
    ...(opts.trusted && opts.projectRoot ? discoverDir(path.join(opts.projectRoot, ".standardcode", "skills"), "project", warnings) : []),
    ...(opts.pluginSkills ?? []),
  ];
  if (!opts.trusted && opts.projectRoot) {
    // SEC-070 信任门前置（DoD②）：未信任项目层不加载——仅登记（审计面）
    let has = false;
    try {
      readdirSync(path.join(opts.projectRoot, ".standardcode", "skills"));
      has = true;
    } catch {
      /* 无目录 */
    }
    if (has) warnings.push("project skills not loaded: workspace trust not accepted (SEC-070)");
  }
  return { skills: dedupe(skills), warnings };
}
