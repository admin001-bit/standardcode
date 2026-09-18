// M6-WP-07：文件型 mailbox（inbox 持久化，DoD③ schema 校验与告警禁静默；BLK-07=① 跨 teammate 与恢复面载体）。
//
// 依据：v2.8 ORC-023（行 295）+ Q-4（行 578）；接缝⑳。
// 逐字锚点（A 级 `claude-code-agent-teams.md` §5，`_440.js` L55647-55680）：
//   inbox 是**持久化文件，顶层数组**，每条记录过 schema 校验，非法条目被**丢弃并告警**：
//     `[TeammateMailbox] dropped schema-invalid inbox entry (${n})`
//     `TeammateMailbox: dropped inbox entry that is not an object`
//     `TeammateMailbox: dropped inbox entry with missing text`
//     `[TeammateMailbox] inbox file top level is ... expected an array`
//     `TeammateMailbox: inbox file is not an array`
//
// [自定] 口径（供 V 核验）：
//   ① **inbox 文件命名规则 A 级未逐字定位**（§12 未解②：存储路径构造未定位）——本实现不臆造 [CC] 路径：
//      落形=`<teamsDir>/<净化 teamName>/<净化成员名>.inbox.json`（每成员一文件、顶层数组）；teamsDir 单源在
//      platform（transcripts.ts 同 enc 基座，WP-02 workflowsDir 先例）；净化=非 [A-Za-z0-9._-] → x<hex>
//      （encodeProjectPath 同族，防穿越）。命名规则整体 [自定] 登记供 V。
//   ② 顶层非数组=按**空 inbox**处理 + 告警（不抛——持久化面降级可恢复；A 级未给该分支处置）。
//   ③ JSON 解析失败（半截写/损坏）=按空 inbox 处理 + 告警（[自定]；与 journal 坏行跳过同族思路）。
//   ④ `text` 校验口径=`typeof e.text !== "string"` 即 missing text（空串放行——"missing" 字面=缺字段/类型不符）。
//   ⑤ 合法条目的其余字段**透传保留**（A 级未给完整 schema，只锚对象性与 text）。
//   ⑥ fs 注入面（WP-04 同形）：读写全部经注入 fs（缺省 node:fs）——Windows 无稳定错误触发路径，容错须可证伪。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** mailbox 条目（schema 最小面=对象 + text 字符串；其余字段透传 [自定]⑤）。 */
export interface MailboxEntry {
  from: string;
  text: string;
  summary?: string;
  color?: string;
  sentAt?: string;
  /** 结构化协议原物（纯文本消息无此字段）。 */
  message?: unknown;
  [key: string]: unknown;
}

/** 告警标题前缀（A 级 §5 逐字模板；`${n}`=条目索引）。 */
export function mailboxDropTitle(index: number): string {
  return `[TeammateMailbox] dropped schema-invalid inbox entry (${index})`;
}
/** 逐条拒绝详情（A 级 §5 逐字两员）。 */
export const MAILBOX_DROP_NOT_OBJECT = "TeammateMailbox: dropped inbox entry that is not an object";
export const MAILBOX_DROP_MISSING_TEXT = "TeammateMailbox: dropped inbox entry with missing text";
/** 顶层告警（A 级 §5 逐字两段）。 */
export const MAILBOX_TOP_LEVEL_TITLE = "[TeammateMailbox] inbox file top level is ... expected an array";
export const MAILBOX_TOP_LEVEL_DETAIL = "TeammateMailbox: inbox file is not an array";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 单条 schema 校验（DoD③）：返回 null=合法；否则为拒绝详情文案。 */
export function checkMailboxEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return MAILBOX_DROP_NOT_OBJECT;
  if (typeof entry.text !== "string") return MAILBOX_DROP_MISSING_TEXT;
  return null;
}

/** 解析 inbox 文件文本（DoD③ 全谱：顶层非数组/非对象条目/缺 text 条目=丢弃并告警）。 */
export function parseInboxFile(text: string): { entries: MailboxEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // [自定]③：损坏/半截文件=空 inbox + 告警（禁静默）。
    return {
      entries: [],
      warnings: [`[TeammateMailbox] inbox file unreadable — ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (!Array.isArray(parsed)) {
    // 顶层非数组：两段告警（A 级 §5 逐字）+ 按空处理（[自定]②）。
    return { entries: [], warnings: [`${MAILBOX_TOP_LEVEL_TITLE} — ${MAILBOX_TOP_LEVEL_DETAIL}`] };
  }
  const entries: MailboxEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const detail = checkMailboxEntry(parsed[i]);
    if (detail) {
      warnings.push(`${mailboxDropTitle(i)} ${detail}`);
      continue; // 丢弃（禁静默：告警随返回值上浮）
    }
    entries.push(parsed[i] as MailboxEntry);
  }
  return { entries, warnings };
}

/** fs 注入面（[自定]⑥；缺省 node:fs）。 */
export interface MailboxFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): void;
}

const defaultFs: MailboxFs = {
  existsSync,
  readFileSync: (p, enc) => readFileSync(p, enc),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (dir, opts) => mkdirSync(dir, opts),
};

/** 读 inbox（零副作用：文件缺席=空数组零告警零落盘——DoD⑤ 惰性语义的读取半边）。 */
export function readMailbox(inboxPath: string, fs: MailboxFs = defaultFs): { entries: MailboxEntry[]; warnings: string[] } {
  if (!fs.existsSync(inboxPath)) return { entries: [], warnings: [] };
  return parseInboxFile(fs.readFileSync(inboxPath, "utf8"));
}

/** 写 inbox（懒创建：mkdir 递归只在写入时发生；读改写整文件——顶层数组形态，A 级 §5）。 */
export function appendMailbox(inboxPath: string, entry: MailboxEntry, fs: MailboxFs = defaultFs): string[] {
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  const current = readMailbox(inboxPath, fs);
  fs.writeFileSync(inboxPath, `${JSON.stringify([...current.entries, entry], null, 2)}\n`);
  return current.warnings; // 既有文件里的坏条目告警上浮（写时也禁静默）
}

/** [自定]①：文件名净化（encodeProjectPath 同族：非 [A-Za-z0-9._-] → x<hex>；防穿越——整段为 "."/".." 时回落 "x"）。 */
export function sanitizeMailboxSegment(raw: string): string {
  if (raw === "." || raw === "..") return "x"; // 纯点段=相对路径语义，必须编码（防穿越）
  let out = "";
  for (const ch of raw) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else out += `x${ch.codePointAt(0)!.toString(16)}`;
  }
  return out === "" ? "x" : out;
}

/** 成员 inbox 文件路径（[自定]① 落形；teamsDir 由 platform 提供，此处只组合）。 */
export function teammateInboxPath(teamsDir: string, teamName: string, memberName: string): string {
  return path.join(teamsDir, sanitizeMailboxSegment(teamName), `${sanitizeMailboxSegment(memberName)}.inbox.json`);
}
