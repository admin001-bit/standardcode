// L1 权限仲裁（v2.8 §8.3、§5.2 permission-broker 行、§0.5 B-13）。
// 模式=EXE-001 四模式（首版不含 [CC] 分类器 auto，M5+ MAY 第五档）；评估序 deny→ask→allow 首匹配定结果（§8.3）；
// deny 恒赢（B-13）——deny 规则先于一切，任何 allow 规则/模式都不能解锁（[CC] STo 复核同构："hook allow 永远不能解锁一条
// deny 规则"，dig-02 §1 逐字）。Plan 模式改文件类拦截=模式级硬门（[CC] 2.1.212 漏洞回归要求，§8.3 L381）。
// 规则清洗 M1 切片 [自定]：allow 规则禁裸通配（[CC] chunk-4svxqcrq：Wildcard tool name not supported in allow rules）；
// rooted/设备通道等完整清洗随 M2 settings 五来源落地。

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

/** allow 侧禁裸通配（[CC] 同构）：Bash 的 allow 规则必须给 specifier（Bash(*)/Bash 无效——任意命令放行面过大）。 */
export function parseRuleset(raw: Ruleset, side: keyof Ruleset): PermissionRule[] {
  return raw[side].map((r) => {
    const parsed = parseRule(r);
    if (side === "allow" && parsed.tool === "Bash" && (parsed.specifier === null || parsed.specifier === "*")) {
      throw new Error(`invalid allow rule (wildcard not supported): ${r}`);
    }
    return parsed;
  });
}

/** specifier 匹配：Bash 对命令串整串 glob（`*` 跨空格，[CC] "git *" 前缀语义）；路径类对 file_path/path glob（`**` 跨目录）。 */
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

function specifierSubject(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  if (toolName === "Bash") return typeof rec.command === "string" ? rec.command : null;
  const p = rec.file_path ?? rec.path;
  return typeof p === "string" ? p.replaceAll("\\", "/") : null;
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

// —— Plan 模式改文件类 Bash 拦截（§8.3 L381：[CC] 2.1.212 漏洞回归；fail-closed 启发式 [自定]）——

/** 只读命令白名单：白名单外一律视为可变更（fail-closed）。git 仅 status/log/diff/show/blame 视为只读。 */
const READONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "find", "which", "where", "whereis", "file", "stat", "du", "df",
  "ps", "env", "printenv", "whoami", "hostname", "uname", "date", "id", "tree", "sort", "uniq", "cut", "tr",
  "diff", "comm", "jq", "man", "echo", "printf", "test", "true", "false", "type", "tasklist", "dir",
]);

/** 包装器/提权前缀一律视为可变更（[CC] 包装器穿透集合的 fail-closed 反向：不可静态证明只读即拦）。 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set(["sudo", "doas", "xargs", "exec", "nohup", "timeout", "nice", "watch", "eval", "source", "."]);

const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "blame"]);

/** Plan 模式 Bash 可变更性判定（启发式，fail-closed）：重定向/命令替换/管道段首词白名单外/包装器 → 可变更。 */
export function isMutatingBash(command: string): boolean {
  const stripped = stripQuoted(command);
  for (const segment of stripped.split(/(?:\|\||&&|;|\||\n)/)) {
    const seg = segment.trim();
    if (seg === "") continue;
    if (/./.test(seg) && /[<>]/.test(seg)) return true; // 重定向（含 > >> 2> &> <）
    if (seg.includes("$(") || seg.includes("`")) return true; // 命令替换不透明，fail-closed
    const tokens = seg.split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++; // 剥离 env 赋值
    const head = (tokens[idx] ?? "").toLowerCase();
    if (head === "") continue;
    if (head === "git") {
      const sub = (tokens[idx + 1] ?? "").toLowerCase();
      if (!GIT_READONLY_SUBCOMMANDS.has(sub)) return true;
      continue;
    }
    if (WRAPPER_COMMANDS.has(head)) return true;
    if (head === "sed" && tokens.some((t) => /^-[^-]*[iw]/.test(t) || t === "--in-place")) return true;
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
  evaluate(toolName: string, input: unknown): BrokerEvaluateResult;
}

export interface BrokerOptions {
  mode?: PermissionMode;
  rules?: Partial<Ruleset>;
}

/** 评估序（§8.3）：deny 规则 → Plan 硬门 → ask 规则 → allow 规则 → 模式缺省；deny 恒赢（B-13）。 */
export function createPermissionBroker(opts: BrokerOptions = {}): PermissionBroker {
  let mode: PermissionMode = opts.mode ?? "default";
  const deny = parseRuleset({ deny: opts.rules?.deny ?? [], ask: [], allow: [] }, "deny");
  const ask = parseRuleset({ deny: [], ask: opts.rules?.ask ?? [], allow: [] }, "ask");
  const allow = parseRuleset({ deny: [], ask: [], allow: opts.rules?.allow ?? [] }, "allow");

  return {
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    cycle: () => {
      mode = PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]!;
      return mode;
    },
    evaluate: (toolName, input) => {
      for (const r of deny) {
        if (ruleMatches(r, toolName, input)) return { decision: "deny", reason: `deny rule: ${r.tool}${r.specifier ? `(${r.specifier})` : ""}` };
      }
      if (mode === "plan" && isMutatingTool(toolName, input)) {
        return { decision: "deny", reason: `plan mode blocks file-mutating ${toolName}` };
      }
      for (const r of ask) {
        if (ruleMatches(r, toolName, input)) return { decision: "ask", reason: `ask rule: ${r.tool}${r.specifier ? `(${r.specifier})` : ""}` };
      }
      for (const r of allow) {
        if (ruleMatches(r, toolName, input)) return { decision: "allow", reason: `allow rule: ${r.tool}${r.specifier ? `(${r.specifier})` : ""}` };
      }
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
