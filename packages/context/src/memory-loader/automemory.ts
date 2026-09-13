// WP-06：自动记忆轨（v2.8 §9.1 ②）——一事一文件+MEMORY.md 索引硬截断+[[name]] 互链+维护纪律提示词。
// 常量对位 _533.js:18 实测逐字：E="MEMORY.md"、ae=200（行）、ot=25000（字节）、kn=4*ot。
// 文件契约（DoD①）：~/.standardcode/projects/<enc>/memory/<slug>.md，frontmatter name/description/type
//（user|feedback|project,reference——v2.8 §9.1 ② 原文直键形；[CC]=metadata.type _533 Re 模板——循规格，偏差登记）
// + schemaVersion:1（ENG-080）；slug 规范 [CC] Lt :533（lowercase、[^a-z0-9]+→-、^[a-z0-9_-]+$）。
// 维护纪律=模板层 memory-* 结构 [自定] 措辞（代码层不得逐字复用；结构借鉴 _533 Re/$r/Yt 形状）。
// 注入载体=turn 首 meta user 追加（CTX-005 接缝⑪；skills 清单同载体 [自定]）。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_INDEX_FILE = "MEMORY.md"; // [CC] E :533:18 逐字
export const MEMORY_INDEX_MAX_LINES = 200; // [CC] ae 逐字
export const MEMORY_INDEX_MAX_BYTES = 25_000; // [CC] ot 逐字
export const MEMORY_INDEX_ENTRY_MAX_CHARS = 150; // [CC] 索引行 "~150 characters"（$r 段）
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryEntryType = (typeof MEMORY_TYPES)[number];

export interface ParsedMemoryEntry {
  name?: string;
  description?: string;
  type?: MemoryEntryType;
  schemaVersion?: number;
  body: string;
  warnings: string[];
}

/** 记忆文件解析（DoD① 契约）：直键 frontmatter；解析失败=告警+全文本当正文（fail-open 与 M2 rules 同向）。 */
export function parseMemoryEntry(text: string, file: string): ParsedMemoryEntry {
  const warnings: string[] = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) {
    warnings.push(`${file}: missing frontmatter (--- block) — treated as body-only`);
    return { body: text, warnings };
  }
  const out: ParsedMemoryEntry = { body: text.slice(m[0].length), warnings };
  for (const line of m[1]!.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "name") out.name = value === "" ? undefined : value;
    else if (key === "description") out.description = value === "" ? undefined : value;
    else if (key === "schemaVersion") out.schemaVersion = Number(value);
    else if (key === "type") {
      if ((MEMORY_TYPES as readonly string[]).includes(value)) out.type = value as MemoryEntryType;
      else warnings.push(`${file}: type '${value}' not in {${MEMORY_TYPES.join(",")}} — ignored`);
    }
  }
  return out;
}

/** slug 规范（[CC] Lt :533 形状）：lowercase、[^a-z0-9]+→-、去首尾 -；合法形 ^[a-z0-9_-]+$。 */
export function memorySlug(name: string): string {
  const s = /^[a-z0-9_-]+$/.test(name) ? name : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "memory" : s;
}

export interface MemoryIndexView {
  /** 截断后注入文本。 */
  text: string;
  lines: number;
  bytes: number;
  /** true=发生硬截断（超 200 行或 25000 字节——超限丢弃+告警）。 */
  truncated: boolean;
  exists: boolean;
  warnings: string[];
}

/**
 * MEMORY.md 索引读取（DoD②）：一行一指针；渲染/注入端 200 行/25000 字节硬截断
 * （常量对位 _533.js ae/ot；超限丢弃+告警）。文件缺席=空视图非错误。
 */
export function readMemoryIndex(dir: string, readFile: typeof readFileSync = readFileSync): MemoryIndexView {
  const file = path.join(dir, MEMORY_INDEX_FILE);
  let raw: string;
  try {
    raw = readFile(file, "utf8");
  } catch {
    return { text: "", lines: 0, bytes: 0, truncated: false, exists: false, warnings: [] };
  }
  const warnings: string[] = [];
  const allLines = raw.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop(); // 尾随换行不计行 [自定]
  let lines = allLines.slice(0, MEMORY_INDEX_MAX_LINES);
  let truncated = allLines.length > MEMORY_INDEX_MAX_LINES;
  if (truncated) warnings.push(`${MEMORY_INDEX_FILE} exceeds ${MEMORY_INDEX_MAX_LINES} lines — truncated (${allLines.length - MEMORY_INDEX_MAX_LINES} lines dropped)`);
  let text = lines.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MEMORY_INDEX_MAX_BYTES) {
    // 字节维截断（R3 修复：String.slice 按 UTF-16 码元，CJK 多字节下会击穿字节上限——按码点二分收缩至 ≤ 上限）
    const cps = [...text];
    let lo = 0;
    let hi = cps.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      if (Buffer.byteLength(cps.slice(0, mid).join(""), "utf8") <= MEMORY_INDEX_MAX_BYTES) lo = mid;
      else hi = mid - 1;
    }
    text = cps.slice(0, lo).join("");
    truncated = true;
    warnings.push(`${MEMORY_INDEX_FILE} exceeds ${MEMORY_INDEX_MAX_BYTES} bytes — truncated to ${MEMORY_INDEX_MAX_BYTES} bytes`);
  }
  return { text, lines: lines.length, bytes: Buffer.byteLength(text, "utf8"), truncated, exists: true, warnings };
}

/** [[name]] 互链扫描（去重保序）。 */
export function scanMemoryLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface ResolvedLink {
  name: string;
  /** 目标记忆全文（正文）。 */
  body: string;
}

/**
 * 互链解析（DoD③）：目标存在→随引用注入（全文）；缺失→告警不炸（[CC] jt 段语义：缺失链接=待写标记非错误）。
 */
export function resolveMemoryLinks(dir: string, names: string[], readFile: typeof readFileSync = readFileSync): { resolved: ResolvedLink[]; missing: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const resolved: ResolvedLink[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const file = path.join(dir, `${name}.md`);
    try {
      const raw = readFile(file, "utf8");
      const parsed = parseMemoryEntry(raw, file);
      warnings.push(...parsed.warnings);
      resolved.push({ name, body: parsed.body.trim() });
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) warnings.push(`memory links not written yet: ${missing.join(", ")} (fine — marks worth writing later)`);
  return { resolved, missing, warnings };
}

export interface AutoMemoryView {
  index: MemoryIndexView;
  /** 索引文本的互链解析结果（目标存在=全文随注入；正文链接一跳展开=留位 [自定]，核验 O1 登记）。 */
  resolved: ResolvedLink[];
  missing: string[];
  /** 目录下记忆文件计数（/memory 可视化）。 */
  entryCount: number;
  warnings: string[];
}

/** 自动轨装配视图：索引（硬截断）+互链解析+目录计数。 */
export function loadAutoMemory(dir: string, readFile: typeof readFileSync = readFileSync): AutoMemoryView {
  const warnings: string[] = [];
  const index = readMemoryIndex(dir, readFile);
  warnings.push(...index.warnings);
  let entryCount = 0;
  try {
    entryCount = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== MEMORY_INDEX_FILE).length;
  } catch {
    /* 目录不存在=无记忆（常态） */
  }
  const links = scanMemoryLinks(index.text);
  const linked = resolveMemoryLinks(dir, links, readFile);
  warnings.push(...linked.warnings);
  return { index, resolved: linked.resolved, missing: linked.missing, entryCount, warnings };
}

/** 自动轨注入文本（索引+互链全文；接缝⑪ meta user 追加载体 [自定]）。 */
export function renderAutoMemoryContext(view: AutoMemoryView): string | null {
  if (!view.index.exists && view.resolved.length === 0) return null;
  const parts: string[] = [];
  if (view.index.exists) parts.push(`## Project memory index (${MEMORY_INDEX_FILE})\n\n${view.index.text}`);
  for (const r of view.resolved) parts.push(`## Memory: ${r.name}\n\n${r.body}`);
  return parts.join("\n\n");
}

/**
 * 维护纪律提示词（DoD④；进系统提示词）。模板层 memory-* 结构 [自定] 措辞——
 * 结构借鉴 [CC]（$r 两步法/Re frontmatter 形/Yt staleness/jt 互链），措辞自写不逐字复用。
 */
export function buildMemoryDisciplinePrompt(opts?: { autoTrackEnabled?: boolean }): string {
  if (opts?.autoTrackEnabled === false) return "";
  return [
    "## Project memory",
    "",
    "This project has an automatic memory directory. Long-lived knowledge (user preferences, feedback on how you work, project facts, useful references) should be saved there as memory files so future sessions can reuse it.",
    "",
    "### How to save a memory (two steps)",
    "",
    "1. Write the memory to its own file (`<slug>.md`, e.g. `feedback_testing.md`) using this frontmatter format:",
    "",
    "```markdown",
    "---",
    "name: short-kebab-case-slug",
    "description: one-line summary, specific enough to judge relevance later",
    "type: user | feedback | project | reference",
    "schemaVersion: 1",
    "---",
    "",
    "memory content",
    "```",
    "",
    '2. Add one pointer line to the `MEMORY.md` index: `- [Title](slug.md) - one-line hook (under ~150 characters)`.',
    "",
    "Rules: each memory lives in exactly one file (one thing per file); `MEMORY.md` is an index, never write memory content into it; keep the index concise - it is truncated after 200 lines / 25,000 bytes, so entries beyond that are dropped; update an existing file instead of creating a duplicate, and delete memories that turn out to be wrong.",
    "",
    "### Memory types",
    "",
    "- **user** - who the user is: role, preferences, working style",
    "- **feedback** - corrections the user gave about how you work; record the correction and how to apply it next time",
    "- **project** - facts about this project: architecture decisions, build/test commands, conventions",
    "- **reference** - pointers to useful external material or resources",
    "",
    "### Linking and staleness",
    "",
    "In memory bodies, link related memories with `[[name]]` (the other memory's slug). A `[[name]]` with no matching memory yet is fine - it is a placeholder for something you plan to write later, not a failure.",
    "",
    "Memory records can become stale. Treat each record as a snapshot of what was true at some earlier point: before relying on one, re-check it against the code or data as they are now; when a memory disagrees with what you currently observe, prefer what you observe and correct or delete the outdated record.",
  ].join("\n");
}
