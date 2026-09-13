// WP-05：清单构建与预算控制（DoD③；dig-06 §4.1/§4.2）。
// 常量（:163753-163756 逐字）：Nes=0.01（预算份额）/jrr=4（字节每 token）/Ues=1536（单条描述截断）。
// 行形状="- name: description"（description∪when_to_use 拼接 hye :163686——拼接分隔符 [自定] 单空格）；
// meta 消息头（:318109 逐字）"The following skills are available for use with the Skill tool:\n\n"。
// 超预算：按使用频次半衰期分 mGe=usageCount×max(0.5^(days/7),0.1)（:163136-163143）降序保描述，余降级 name-only。
export const SKILL_DESC_TRUNCATE_CHARS = 1536;
export const SKILL_LISTING_BUDGET_FRACTION = 0.01;
export const SKILL_LISTING_BYTES_PER_TOKEN = 4;
export const SKILL_LISTING_HEADER = "The following skills are available for use with the Skill tool:\n\n";
export const SKILL_HALF_LIFE_DAYS = 7;
export const SKILL_SCORE_FLOOR = 0.1;

export interface SkillListingInput {
  name: string;
  description: string;
  whenToUse?: string;
}

/** 描述∪when_to_use 拼接（hye :163686 形状；分隔符单空格 [自定]）+1536 截断（Ues）。 */
export function skillListingDescription(input: SkillListingInput): string {
  const raw = [input.description, input.whenToUse].filter((x) => x !== undefined && x !== "").join(" ");
  return raw.length > SKILL_DESC_TRUNCATE_CHARS ? raw.slice(0, SKILL_DESC_TRUNCATE_CHARS) : raw;
}

/** 使用频次半衰期分（mGe :163136-163143 逐字公式：usageCount × max(0.5^(daysSinceUse/7), 0.1)）。 */
export function skillPriorityScore(usageCount: number, daysSinceUse: number): number {
  return usageCount * Math.max(Math.pow(0.5, daysSinceUse / SKILL_HALF_LIFE_DAYS), SKILL_SCORE_FLOOR);
}

export interface SkillUsageRecord {
  count: number;
  /** 最近使用 epoch ms（半衰期时钟）。 */
  lastUsedAt: number;
}

export interface BuildListingOptions {
  /** 上下文窗口 tokens（预算=窗口×1%×4 字节）。 */
  contextTokens: number;
  /** 使用记账（内存态；缺省=全 0 分）。 */
  usage?: Record<string, SkillUsageRecord>;
  now?: () => number;
}

export interface SkillListingResult {
  /** 清单行（已按预算降档）。 */
  lines: string[];
  budgetMode: "fits" | "priority";
  /** 被降档为 name-only 的技能名。 */
  demoted: string[];
}

/** 清单构建（bGe :163868 形状）：全部可模型调用技能 → 描述行 → 预算裁剪。 */
export function buildSkillListing(skills: SkillListingInput[], opts: BuildListingOptions): SkillListingResult {
  const now = opts.now ?? Date.now;
  const budgetBytes = Math.floor(opts.contextTokens * SKILL_LISTING_BUDGET_FRACTION * SKILL_LISTING_BYTES_PER_TOKEN);
  const rows = skills.map((s) => {
    const usage = opts.usage?.[s.name];
    const line = `- ${s.name}: ${skillListingDescription(s)}`;
    const score = skillPriorityScore(usage?.count ?? 0, usage ? Math.max(0, (now() - usage.lastUsedAt) / 86_400_000) : Number.POSITIVE_INFINITY);
    return { name: s.name, line, score, bytes: Buffer.byteLength(line, "utf8") + 1 };
  });
  const total = rows.reduce((acc, r) => acc + r.bytes, 0);
  if (total <= budgetBytes) {
    return { lines: rows.map((r) => r.line), budgetMode: "fits", demoted: [] };
  }
  // 超预算：分数降序保描述（分数同则名字典序稳定），余降级 name-only（"- name"）
  const ordered = [...rows].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let used = 0;
  const demoted = new Set<string>();
  for (const r of ordered) {
    const nameOnlyBytes = Buffer.byteLength(`- ${r.name}`, "utf8") + 1;
    if (used + r.bytes <= budgetBytes) {
      used += r.bytes;
    } else {
      demoted.add(r.name);
      used += nameOnlyBytes; // name-only 行仍占位（超支保底=清单可见性优先）
    }
  }
  return {
    lines: rows.map((r) => (demoted.has(r.name) ? `- ${r.name}` : r.line)),
    budgetMode: "priority",
    demoted: [...demoted],
  };
}
