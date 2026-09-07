// UI-001（§8.1）：斜杠命令 Tab 补全与参数提示。
import type { SlashCommand } from "./commands.ts";

export interface TabCompletion {
  /** 唯一命中时给出补全文本（含尾随空格）；否则 null。 */
  insert: string | null;
  /** 多义/无命中时的候选列表（readline 第二列）。 */
  candidates: string[];
  /** 参数提示（命令名后或唯一命中时展示 description/usage）。 */
  hint: string | null;
}

export function completeInput(line: string, commands: readonly SlashCommand[]): TabCompletion {
  if (!line.startsWith("/")) return { insert: null, candidates: [], hint: null };
  const m = /^(\/\S*)(?:\s+([\s\S]*))?$/.exec(line);
  if (!m) return { insert: null, candidates: commands.map((c) => `/${c.name}`), hint: null };
  const token = m[1];
  const hasArgs = m[2] !== undefined;
  const cmd = commands.find((c) => `/${c.name}` === token);
  if (hasArgs) {
    return { insert: null, candidates: [], hint: cmd ? (cmd.usage ? `${cmd.usage} — ${cmd.description}` : cmd.description) : null };
  }
  const prefix = token.slice(1);
  const matches = commands.filter((c) => c.name.startsWith(prefix));
  if (matches.length === 1) {
    return { insert: `/${matches[0]!.name} `, candidates: [], hint: matches[0]!.description };
  }
  return { insert: null, candidates: matches.map((c) => `/${c.name}`), hint: null };
}
