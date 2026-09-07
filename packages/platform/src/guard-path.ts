// L4 guard-path 高危路径护栏（v2.8 §10 EXE-020/021、§11 S-7/S-9、§0.5 B-13）。
// 独立于沙箱常驻（M1 起，先于沙箱 M5）——本模块零沙箱导入（DoD④）。
// 模式（§10 原文）=[CC] `_616.js` 运行时子目录正则守卫 + Codex 元数据名"隐式保护+双保险 deny+祖先禁重命名"
//（codex-rs/protocol/src/permissions.rs PROTECTED_METADATA_PATH_NAMES 同构，映射：.git/.agents/.codex→.git/.agents/.standardcode，卡依据）。
// 判定在工具层做权威判定（EXE-020 原文）：调用方=executor 工具执行前。
import { isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** 元数据目录名（隐式保护；Codex .codex → 本仓 .standardcode；.agents 沿用——产品自身约定通道）。 */
export const PROTECTED_METADATA_NAMES: readonly string[] = [".git", ".agents", ".standardcode"];

/** 高危系统路径（EXE-020：C:\Windows 等；M1 最小集=Windows 系统目录 4 项，POSIX 系统目录清单随护栏运营/M2 扩充）。 */
export const HIGH_RISK_PATHS: readonly string[] = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
];

/** S-9 持久化提权路径清单（§11 L451 原文：.bashrc/PowerShell profile/cron/PATH 内脚本/git hooks）→ 命中强制确认，Auto 不豁免。 */
export const PERSISTENCE_PATH_FRAGMENTS: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  "Microsoft/PowerShell", // profile.psx 等所在目录（Documents/WindowsPowerShell/…）
  "WindowsPowerShell",
  "PowerShell", // pwsh 7 profile（Documents/PowerShell/）
  "cron.d",
  "cron.daily",
  "crontab",
  "systemd/user",
  "LaunchAgents",
  ".git/hooks", // git hooks（S-9 原文）——先于元数据保护判定（hooks 下任何写入都算）
];

export type GuardVerdict =
  | { action: "stop"; rule: "high-risk-path" | "protected-metadata" | "metadata-ancestor-rename"; detail: string }
  | { action: "confirm"; rule: "persistence-path"; detail: string }
  | { action: "pass"; rule?: undefined; detail?: undefined };

export interface GuardCheck {
  /** 工具意图路径（写入/编辑/删除/重命名目标等）。 */
  target: string;
  /** 会话工作目录（元数据保护的"可写根"基准）。 */
  cwd: string;
  /** 操作类型：rename 时 source/target 均查（祖先禁重命名）。 */
  operation: "write" | "rename";
  /** rename 的源路径。 */
  source?: string;
}

/** basename 是否受保护元数据名（Codex is_protected_metadata_name 同构：整名相等，非子串）。 */
export function isProtectedMetadataName(name: string): boolean {
  return PROTECTED_METADATA_NAMES.includes(name);
}

function normalize(p: string): string {
  return p.replaceAll("/", sep).replaceAll("\\", sep);
}

/** 高危路径检测（EXE-020）：目标在系统高危路径内（前缀匹配，含等于）。 */
export function isHighRiskPath(target: string): boolean {
  const t = normalize(target);
  return HIGH_RISK_PATHS.some((root) => {
    const r = normalize(root);
    return t === r || t.toLowerCase().startsWith(r.toLowerCase() + sep);
  });
}

/** S-9 持久化路径命中（§11：强制确认且 Auto 不豁免）。 */
export function isPersistencePath(target: string): boolean {
  const t = normalize(target).toLowerCase();
  return PERSISTENCE_PATH_FRAGMENTS.some((frag) => t.includes(normalize(frag).toLowerCase()));
}

/**
 * 权威判定（工具层调用，EXE-020）。顺序（B-13 deny 恒赢的路径版）：
 * 1) 高危路径 → stop；2) S-9 持久化 → confirm（强制确认，Auto 不豁免——确认权在调用方 UI，护栏只负责"必须确认"语义）；
 * 3) 元数据隐式保护：target 落在受保护元数据目录内 → stop（双保险之一；另一保险=下方 rename 祖先链）；
 * 4) rename 源/目标祖先链含受保护元数据名 → stop（祖先禁重命名，Codex 同构）。
 * 未信任工作区等更大面（S-8）属 M2 信任门，本模块不越权判定。
 */
export function guardPath(check: GuardCheck): GuardVerdict {
  const target = isAbsolute(check.target) ? normalize(check.target) : resolve(normalize(check.cwd), normalize(check.target));
  if (isHighRiskPath(target)) {
    return { action: "stop", rule: "high-risk-path", detail: `target inside high-risk system path: ${target}` };
  }
  if (isPersistencePath(target)) {
    return { action: "confirm", rule: "persistence-path", detail: `S-9 persistence path hit: ${target} — explicit user confirmation required (Auto mode not exempt)` };
  }
  if (isProtectedMetadataName(basenameOf(target))) {
    return { action: "stop", rule: "protected-metadata", detail: `write into protected metadata directory: ${target}` };
  }
  const sources = check.operation === "rename" && check.source ? [check.source] : [];
  for (const src of sources) {
    const abs = isAbsolute(src) ? normalize(src) : resolve(normalize(check.cwd), normalize(src));
    if (isProtectedMetadataName(basenameOf(abs)) || ancestryContainsProtected(abs)) {
      return { action: "stop", rule: "metadata-ancestor-rename", detail: `renaming protected metadata (ancestor chain): ${abs}` };
    }
  }
  // 目标祖先链中任何一段是受保护元数据目录 → 其下写入已被 3) 拦；此处再拦"把受保护目录整体改名/移动"的祖先位（Codex 祖先禁重命名）
  if (ancestryContainsProtected(target)) {
    return { action: "stop", rule: "protected-metadata", detail: `target under protected metadata directory: ${target}` };
  }
  return { action: "pass" };
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** 祖先链（含自身）中是否出现受保护元数据名段。 */
export function ancestryContainsProtected(p: string): boolean {
  return p.split(/[\\/]/).filter(Boolean).some((seg) => isProtectedMetadataName(seg));
}

/** 便利函数：当前用户家目录（~ 展开基准，供调用方拼 profile 路径用）。 */
export function userHome(): string {
  return homedir();
}

/**
 * 工具层权威判定适配（EXE-020：护栏判定在工具层做权威判定）。
 * 读面（Read/Glob/Grep）不拦——护栏针对写/执行面（EXE-020"写入被拦"语义）；Bash 走命令 token 扫描（双保险第二层：
 * 元数据名/高危前缀/S-9 片段在命令参数中出现即判，覆盖 `rm -rf .git`、`> C:\Windows\x` 等不落 path 参数的形态）。
 * M1 工具集外（MCP 等 M4+）一律 pass（能力注册时再接护栏）。
 */
export function checkToolInput(toolName: string, input: unknown, cwd: string): GuardVerdict {
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") return { action: "pass" };
  if (typeof input !== "object" || input === null) return { action: "pass" };
  const rec = input as Record<string, unknown>;
  if (toolName === "Write" || toolName === "Edit") {
    const p = rec.file_path;
    return typeof p === "string" ? guardPath({ target: p, cwd, operation: "write" }) : { action: "pass" };
  }
  if (toolName === "Bash" && typeof rec.command === "string") {
    const tokens = rec.command.split(/\s+/).filter((t) => /[\\/]/.test(t) || t.startsWith("."));
    for (const token of tokens) {
      if (ancestryContainsProtected(token)) {
        return { action: "stop", rule: "protected-metadata", detail: `command references protected metadata: ${token}` };
      }
      if (isHighRiskPath(token)) {
        return { action: "stop", rule: "high-risk-path", detail: `command references high-risk path: ${token}` };
      }
      if (isPersistencePath(token)) {
        return { action: "confirm", rule: "persistence-path", detail: `command references S-9 persistence path: ${token}` };
      }
    }
    return { action: "pass" };
  }
  return { action: "pass" };
}
