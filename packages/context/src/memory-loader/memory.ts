// 记忆用户编写轨（v2.8 §9.1①）：AGENTS.md/CLAUDE.md 双读（MEM-044/ADR-025）+ .standardcode/rules/*.md
// 主题拆分（MEM-010）+ @import 递归展开（MEM-021）+ 加载序拼接不覆盖（MEM-011）。
// 加载序（MEM-011 原文）：Managed → User → Project（祖先目录根→cwd 拼接）→ Local，拼接不覆盖。
// 双读（MEM-044）：CLAUDE.md 先、AGENTS.md 后（ADR-025：AGENTS.md 为跨工具开放标准获最后发言权）；
// 完全相同段落去重；memory.precedence 可反转（ADR-0030：memory.precedence="agents-first"）。
// @import 四规则（MEM-021）：fenced 代码块内不解析；循环跳过；缺失忽略；深度上限 5 hops（存疑标注随规格：
// 官方口径 5 与部分材料 4 两说，实现取 5 留配置）；工作目录之外 import 首次引用需用户批准——
// 本卡先落检测+无批准即拒绝 fail-closed（批准 UI=WP-07 联调点）。
// 兼容读取（MEM-041）：.claude/CLAUDE.md、.codex/AGENTS.md 只读不写；写入只落原生布局（Q-2，本模块只读）。
// rules frontmatter `paths:` glob 按路径过滤加载（MEM-010）；未匹配路径的规则不注入。
// 同步实现（createSession 同步装配启动路径；记忆文件量小，冷启动预算内）。

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MEMORY_IMPORT_MAX_DEPTH = 5; // MEM-021 存疑标注口径：取 5（留配置）

export type MemoryPrecedence = "claude-first" | "agents-first";
export type MemoryScope = "managed" | "user" | "project" | "local";

export interface MemoryLoadOptions {
  cwd: string;
  home?: string;
  /** MEM-044/ADR-025 双读序，默认 claude-first（memory.precedence 键，ADR-0030）。 */
  precedence?: MemoryPrecedence;
  /** @import 深度上限（默认 5，MEM-021 留配置）。 */
  importMaxDepth?: number;
  /** 工作目录（cwd）之外 import 的已批准绝对路径集；缺省=无批准（外部 import 一律拒绝 fail-closed）。 */
  approvedExternalImports?: ReadonlySet<string>;
  /** managed 层目录（Q-3 managed-settings.json 同目录；调用方经 platform 计算，缺省=跳过该层）。 */
  managedDir?: string;
  /** MEM-043：只在进入项目工作区时读项目级记忆（含 local 与项目 rules）。缺省 true。 */
  inProject?: boolean;
  /** MEM-042：规则文件自动读取默认开启、可配置关闭（ADR-0030：memory.autoRead）。缺省 true。 */
  rulesEnabled?: boolean;
  /** rules paths glob 匹配的上下文路径（cwd 相对，如已触碰文件；未提供=带 paths 的规则不注入）。 */
  relevantPaths?: string[];
}

export interface MemoryFileRecord {
  scope: MemoryScope;
  kind: "memory" | "rule";
  path: string;
  /** 展开与去重前的原始文本（观测用）。 */
  raw: string;
  warning?: string;
}

export interface DeniedImport {
  path: string;
  referencedBy: string;
}

export interface LoadedMemory {
  /** 拼接结果（文件间 "\n\n"；段落=trim 后非空块，完全相同段落全局去重——MEM-044）。 */
  text: string;
  files: MemoryFileRecord[];
  /** 被拒绝的外部 import（未批准 fail-closed；WP-07 确认 UI 消费）。 */
  deniedImports: DeniedImport[];
  warnings: string[];
}

interface WalkerState {
  cwd: string;
  home: string;
  visited: Set<string>;
  denied: DeniedImport[];
  warnings: string[];
  maxDepth: number;
  approved?: ReadonlySet<string>;
  readFile: typeof readFileSync;
}

function readIfPresent(filePath: string, readFile: typeof readFileSync): string | null {
  try {
    return readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 祖先目录链：最外层祖先 → cwd（MEM-011"祖先目录根→cwd 拼接"）。 */
export function ancestorChain(cwd: string): string[] {
  const chain: string[] = [];
  let cur = path.resolve(cwd);
  while (true) {
    chain.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur || chain.length > 64) break; // 64=防御异常深链
    cur = parent;
  }
  return chain;
}

const IMPORT_LINE = /^@(\S+)\s*$/;

function resolveImportTarget(raw: string, baseDir: string, home: string): string {
  if (raw === "~" || raw.startsWith("~/")) return path.resolve(home, raw.slice(1));
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(baseDir, raw);
}

/** 逐行展开 @import（MEM-021 四规则；fenced 内不解析）。 */
function expandImports(text: string, baseDir: string, depth: number, state: WalkerState): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line); // fenced 内不解析（MEM-021）
      continue;
    }
    const m = IMPORT_LINE.exec(line.trim());
    if (!m) {
      out.push(line);
      continue;
    }
    const target = resolveImportTarget(m[1], baseDir, state.home);
    if (!isInside(state.cwd, target) && !(state.approved?.has(target) ?? false)) {
      state.denied.push({ path: target, referencedBy: baseDir }); // 无批准 fail-closed：行原样保留、内容不注入
      out.push(line);
      continue;
    }
    if (state.visited.has(target)) {
      state.warnings.push(`@import cycle or duplicate skipped: ${target}`); // 循环跳过
      continue;
    }
    state.visited.add(target);
    const imported = readIfPresent(target, state.readFile);
    if (imported === null) continue; // 缺失忽略
    if (depth + 1 > state.maxDepth) {
      state.warnings.push(`@import depth limit (${state.maxDepth}) exceeded at ${target}`);
      continue;
    }
    out.push(expandImports(imported, path.dirname(target), depth + 1, state));
  }
  return out.join("\n");
}

// —— rules 主题拆分（MEM-010）——

export interface RuleFile {
  path: string;
  body: string;
  /** frontmatter paths: glob；缺省/空=始终加载。 */
  paths?: string[];
}

/** 解析 rules frontmatter（最小集：`paths:` 项列表 `- glob` 或行内 `[a, b]`）。 */
export function parseRuleFrontmatter(text: string): { paths?: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text };
  const paths: string[] = [];
  let inPaths = false;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^paths:\s*(.*)$/.exec(line);
    if (kv) {
      inPaths = true;
      const inline = kv[1].trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        for (const g of inline.slice(1, -1).split(",")) {
          const t = g.trim().replace(/^["']|["']$/g, "");
          if (t) paths.push(t);
        }
      } else if (inline) {
        paths.push(inline.replace(/^["']|["']$/g, ""));
      }
      continue;
    }
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && inPaths) paths.push(item[1].trim().replace(/^["']|["']$/g, ""));
  }
  return { paths: paths.length > 0 ? paths : undefined, body: text.slice(m[0].length) };
}

/** 受限 glob（MEM-010）：双星加斜杠=零或多段、双星=跨段、星号=单段、问号=单字符；分隔符 / 与 \ 等价。
 *  实现注意：占位符替换必须先于问号/星号展开，否则问号会污染非捕获组插入物（2026-09-08 修复的链序缺陷）。 */
export function matchGlob(glob: string, filePath: string): boolean {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = esc
    .replace(/\*\*\//g, "\u0002")
    .replace(/\*\*/g, "\u0001")
    .replace(/\?/g, "[^/\\\\]")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\u0002/g, "(?:.*/)?")
    .replace(/\u0001/g, "(?:.*)");
  const norm = filePath.split(path.sep).join("/").replace(/^\.\//, "");
  return new RegExp(`^(?:${rx})$`).test(norm);
}

export function ruleMatchesPath(rule: RuleFile, filePath: string): boolean {
  if (!rule.paths || rule.paths.length === 0) return true;
  return rule.paths.some((g) => matchGlob(g, filePath));
}

// —— 主文件候选（双读：CLAUDE.md 先、AGENTS.md 后；compat 只读）——

interface DirMains {
  claude: string | null;
  agents: string | null;
  compat: string | null;
  compatPath: string | null;
}

function scanDirMains(dir: string, state: WalkerState): DirMains {
  const claude = readIfPresent(path.join(dir, "CLAUDE.md"), state.readFile);
  const agents = readIfPresent(path.join(dir, "AGENTS.md"), state.readFile);
  let compat: string | null = null;
  let compatPath: string | null = null;
  for (const [sub, name] of [
    [".claude", "CLAUDE.md"],
    [".codex", "AGENTS.md"],
  ] as const) {
    const p = path.join(dir, sub, name);
    const t = readIfPresent(p, state.readFile);
    if (t !== null) {
      compat = t;
      compatPath = p;
      break;
    }
  }
  return { claude, agents, compat, compatPath };
}

/** 双读合并：按 precedence 排序 + 完全相同段落去重（MEM-044）。 */
function mergeDualRead(dir: DirMains, precedence: MemoryPrecedence): string {
  const first = precedence === "claude-first" ? dir.claude : dir.agents;
  const second = precedence === "claude-first" ? dir.agents : dir.claude;
  const paras: string[] = [];
  const seen = new Set<string>();
  for (const t of [first, second, dir.compat]) {
    if (t === null || t.trim() === "") continue;
    for (const para of t.split(/\n{2,}/)) {
      const key = para.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      paras.push(key);
    }
  }
  return paras.join("\n\n");
}

function listRulesDir(dir: string, state: WalkerState): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface LoadMemoryOptions extends MemoryLoadOptions {}

/**
 * 加载记忆用户编写轨。同步（启动装配路径）。
 * 消费方：createSession（apps/cli）与 /reload（WP-11）。
 */
export function loadMemory(opts: LoadMemoryOptions): LoadedMemory {
  const cwd = path.resolve(opts.cwd);
  const home = opts.home ?? homedir();
  const state: WalkerState = {
    cwd,
    home,
    visited: new Set<string>(),
    denied: [],
    warnings: [],
    maxDepth: opts.importMaxDepth ?? MEMORY_IMPORT_MAX_DEPTH,
    approved: opts.approvedExternalImports,
    readFile: readFileSync,
  };
  const inProject = opts.inProject ?? true;
  const rulesEnabled = opts.rulesEnabled ?? true;
  const precedence = opts.precedence ?? "claude-first";
  const files: MemoryFileRecord[] = [];

  const pushMain = (scope: MemoryScope, dir: string, text: string | null, compatPath?: string | null) => {
    if (text === null || text.trim() === "") return;
    files.push({ scope, kind: "memory", path: dir, raw: expandImports(text, dir, 0, state), ...(compatPath ? {} : {}) });
    void compatPath;
  };

  // ① Managed（Q-3 目录；缺省跳过）
  if (opts.managedDir) {
    const mains = scanDirMains(opts.managedDir, state);
    pushMain("managed", opts.managedDir, mergeDualRead(mains, precedence));
  }
  // ② User（~/.standardcode；compat ~/.claude/CLAUDE.md、~/.codex/AGENTS.md 经 mergeDualRead 尾位）
  {
    const mains = scanDirMains(path.join(home, ".standardcode"), state);
    const text = mergeDualRead(mains, precedence);
    if (text.trim() !== "") files.push({ scope: "user", kind: "memory", path: path.join(home, ".standardcode"), raw: expandImports(text, path.join(home, ".standardcode"), 0, state) });
  }
  // ③ Project（祖先目录根→cwd 拼接；MEM-043：仅项目工作区内）
  if (inProject) {
    for (const dir of ancestorChain(cwd)) {
      const mains = scanDirMains(dir, state);
      const text = mergeDualRead(mains, precedence);
      if (text.trim() !== "") files.push({ scope: "project", kind: "memory", path: dir, raw: expandImports(text, dir, 0, state) });
    }
  }
  // ④ Local（cwd；[自定] 原生 AGENTS.local.md + 兼容 CLAUDE.local.md）
  if (inProject) {
    const locals: Array<[string, string]> = [
      [path.join(cwd, ".standardcode", "AGENTS.local.md"), "AGENTS.local.md"],
      [path.join(cwd, "CLAUDE.local.md"), "CLAUDE.local.md"],
    ];
    for (const [p, name] of locals) {
      const t = readIfPresent(p, state.readFile);
      if (t !== null && t.trim() !== "") files.push({ scope: "local", kind: "memory", path: p, raw: expandImports(t, path.dirname(p), 0, state) });
    }
  }
  // rules（MEM-010/042；user 层 + project cwd 层；paths 过滤见 ruleMatchesPath）
  if (rulesEnabled) {
    const rulesDirs: Array<{ scope: MemoryScope; dir: string }> = [
      { scope: "user", dir: path.join(home, ".standardcode", "rules") },
      ...(inProject ? [{ scope: "project" as const, dir: path.join(cwd, ".standardcode", "rules") }] : []),
    ];
    for (const { scope, dir } of rulesDirs) {
      for (const name of listRulesDir(dir, state)) {
        const p = path.join(dir, name);
        const raw = readIfPresent(p, state.readFile);
        if (raw === null || raw.trim() === "") continue;
        const { paths, body } = parseRuleFrontmatter(raw);
        files.push({ scope, kind: "rule", path: p, raw: expandImports(body, dir, 0, state), ...(paths ? {} : {}) });
        if (paths) (files[files.length - 1] as MemoryFileRecord & { paths?: string[] }).paths = paths;
      }
    }
  }

  // paths 过滤（MEM-010）：带 paths 的规则仅在 relevantPaths 命中时注入
  const kept: MemoryFileRecord[] = [];
  for (const f of files) {
    if (f.kind !== "rule") {
      kept.push(f);
      continue;
    }
    const paths = (f as MemoryFileRecord & { paths?: string[] }).paths;
    const rule: RuleFile = { path: f.path, body: f.raw, paths };
    const active = (opts.relevantPaths ?? []).some((p) => ruleMatchesPath(rule, p));
    if (active) kept.push(f);
    else state.warnings.push(`rule not active (paths unmatched): ${f.path}`);
  }

  // 拼接（MEM-011：拼接不覆盖）+ 全局段落去重（MEM-044）
  const paras: string[] = [];
  const seen = new Set<string>();
  for (const f of kept) {
    for (const para of f.raw.split(/\n{2,}/)) {
      const key = para.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      paras.push(key);
    }
  }
  return { text: paras.join("\n\n"), files: kept, deniedImports: state.denied, warnings: state.warnings };
}

/** MEM-043 检测：cwd 及祖先存在 .git 或 .standardcode → 项目工作区。 */
export function detectProjectWorkspace(cwd: string, readFile: typeof readFileSync = readFileSync): boolean {
  for (const dir of ancestorChain(cwd)) {
    for (const marker of [".git", ".standardcode"]) {
      try {
        readdirSync(path.join(dir, marker));
        return true;
      } catch {
        /* 不存在 */
      }
    }
    void readFile;
  }
  return false;
}
