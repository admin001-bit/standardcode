// WP-07（M2）：工作区信任位+共享设置门控（v2.8 §8.3 信任模型细则、UI-061、S-8、SEC-070 统一入口）。
// 细则出处：B 级 claude_code_internals_deepdive.md「工作区信任」L68（已复核标注）；信任位锚点 dig-05 `_668.js:46`
//（hasTrustDialogAccepted===!0）；[CC] 同构语义=仓库内共享设置须先接受信任对话框才生效（以 git 仓库根为密钥覆盖整库）。
// 门控对象=§8.3 L380 原文清单：permissions.allow / additionalDirectories / marketplaces / 多数 env（deny/ask 立即生效）。
// 信任存续：~/.standardcode/trust.json（{ [repoRoot]: acceptedAt }）——键=git 仓库根（细则"以仓库根为密钥"）。
// `.standardcode` 为符号链接 → 视为仓库提供需信任（§8.3 细则；ADR-0033 决策 3，本模块只判定、对话框 UI 在 apps/cli）。

import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mergeSettingsDocs, settingsSourcePaths, type LoadedSettings, type SettingsDoc, type SettingsSourceName } from "./settings.ts";

/** 仓库内共享层键中受信任门控的键（§8.3 L380 清单；deny/ask 不在列=立即生效）。 */
export const TRUST_GATED_KEYS: readonly string[] = [
  "permissions.allow",
  "additionalDirectories",
];

/** env.* 键受门控（"多数 env"的可操作化：全部 env.* 注入需信任；凭据由用户自担 [自定]）。 */
export function isTrustGatedKey(key: string): boolean {
  if (TRUST_GATED_KEYS.includes(key)) return true;
  if (key.startsWith("env.")) return true;
  return false;
}

export interface TrustStore {
  /** repoRoot（git 仓库根，小写化盘符归一前保留原文）→ 接受时间（ISO）。 */
  accepted: Record<string, string>;
}

const TRUST_FILE = () => path.join(homedir(), ".standardcode", "trust.json");

export function readTrustStore(file = TRUST_FILE()): TrustStore {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TrustStore;
    return parsed && typeof parsed === "object" && parsed.accepted && typeof parsed.accepted === "object" ? parsed : { accepted: {} };
  } catch {
    return { accepted: {} };
  }
}

export function writeTrustStore(store: TrustStore, file = TRUST_FILE()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** 向上找 git 仓库根（.git 目录或文件——worktree 形态；无 → null=非仓库，信任门不适用共享层但仍查 symlink）。 */
export function findGitRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 信任密钥=git 仓库根（细则原文；非仓库时退项目根 [自定]——local 层仍免信任，见下）。 */
export function trustKeyFor(projectRoot: string): string {
  return findGitRoot(projectRoot) ?? path.resolve(projectRoot);
}

export function isTrusted(projectRoot: string, store = readTrustStore()): boolean {
  return store.accepted[trustKeyFor(projectRoot)] !== undefined;
}

/** 接受信任（对话框确认动作；键=git 仓库根，覆盖整库——细则原文）。 */
export function acceptTrust(projectRoot: string, store = readTrustStore(), file = TRUST_FILE()): TrustStore {
  const key = trustKeyFor(projectRoot);
  const next: TrustStore = { accepted: { ...store.accepted, [key]: new Date().toISOString() } };
  writeTrustStore(next, file);
  return next;
}

/** `.standardcode` 是否符号链接（§8.3：视为仓库提供、需信任——判定在此，消费在 createTrustGate）。 */
export function isNativeDirSymlink(projectRoot: string): boolean {
  try {
    return lstatSync(path.join(projectRoot, ".standardcode")).isSymbolicLink();
  } catch {
    return false; // 不存在（或不可 lstat）→ 无 symlink 问题
  }
}

/**
 * settings.local.json 是否被 git 跟踪（细则：未被跟踪才免信任；被跟踪=仓库提供→需信任）。
 * git 缺席/非仓库 → false（免信任；非仓库时共享层本就稀薄）。
 */
export function isLocalTrackedByGit(projectRoot: string): boolean {
  if (!findGitRoot(projectRoot)) return false;
  const rel = ".standardcode/settings.local.json";
  const r = spawnSync("git", ["ls-files", "--", rel], { cwd: projectRoot, encoding: "utf8" });
  if (r.error || r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

export interface TrustGateResult {
  /** 门控后合并结果（信任未立：共享层受控键被剔除；信任已立：原样）。 */
  settings: LoadedSettings;
  /** 本会话生效的信任态（含 symlink 强制未信任）。 */
  trusted: boolean;
  /** 剔除登记（审计面：哪些来源哪些键被门控挡下）。 */
  withheld: { source: SettingsSourceName; key: string }[];
  /** `.standardcode` symlink 触发的强制未信任（ADR-0033 决策 3）。 */
  symlinkFlagged: boolean;
}

/** 从单层 doc 剔除受控键（permissions 组内只剔 allow，deny/ask 保留=立即生效）。 */
function stripGatedKeys(doc: SettingsDoc, source: SettingsSourceName, withheld: TrustGateResult["withheld"]): SettingsDoc {
  const filtered: SettingsDoc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "permissions" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const perm = v as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(perm)) {
        if (pk === "allow") {
          withheld.push({ source, key: "permissions.allow" });
          continue; // 受控剔除
        }
        kept[pk] = pv; // deny/ask 等保留
      }
      filtered.permissions = kept;
      continue;
    }
    if (isTrustGatedKey(k)) {
      withheld.push({ source, key: k });
      continue;
    }
    filtered[k] = v;
  }
  return filtered;
}

/**
 * 信任门控（S-8 判定闭环）。细则两分支：
 * ① 仓库共享层（projectShared）：信任未立 → 受控键不参与合并；
 * ② local 层：未被 git 跟踪免信任（默认）；被跟踪（或 `.standardcode` 为 symlink=仓库提供面）→ 同 ①。
 * 其余来源（user/flag/managed）不受门；deny/ask 不在 TRUST_GATED_KEYS，天然立即生效（细则原文）。
 */
export function createTrustGate(projectRoot: string, base: LoadedSettings, trusted = isTrusted(projectRoot)): TrustGateResult {
  const symlinkFlagged = isNativeDirSymlink(projectRoot);
  const effectiveTrusted = trusted && !symlinkFlagged;
  if (effectiveTrusted) {
    return { settings: base, trusted: true, withheld: [], symlinkFlagged: false };
  }
  const docs: Record<SettingsSourceName, SettingsDoc | null> = { ...base.docs };
  const withheld: TrustGateResult["withheld"] = [];
  if (docs.projectShared) {
    docs.projectShared = stripGatedKeys(docs.projectShared, "projectShared", withheld);
  }
  const localTracked = symlinkFlagged || isLocalTrackedByGit(projectRoot);
  if (localTracked && docs.projectLocal) {
    docs.projectLocal = stripGatedKeys(docs.projectLocal, "projectLocal", withheld);
  }
  return { settings: mergeSettingsDocs(docs, base.warnings), trusted: false, withheld, symlinkFlagged };
}

/** paths（供调用方/测试复用；不改变 settings.ts 权威）。 */
export { settingsSourcePaths };

/**
 * WP-07（§8.3 持久化）："总是允许"落 local 层（settings.local.json，ADR-0037 格式=permissions.allow 列表去重追加）。
 * 返回追加后的规则清单；坏 JSON 不覆盖（抛错——与 loadSettings 读侧 fail-open 不同，写侧保守）。
 */
export function persistAlwaysAllow(projectRoot: string, rule: string, file?: string): string[] {
  const target = file ?? settingsSourcePaths(projectRoot).projectLocal;
  let doc: SettingsDoc = { schemaVersion: 1 };
  if (existsSync(target)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      throw new Error(`settings.local.json invalid JSON; refusing to overwrite (fix the file first): ${target}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`settings.local.json is not a JSON object; refusing to overwrite: ${target}`);
    }
    doc = parsed as SettingsDoc;
  }
  const perm = (doc.permissions !== null && typeof doc.permissions === "object" && !Array.isArray(doc.permissions)
    ? doc.permissions
    : {}) as Record<string, unknown>;
  const allow = Array.isArray(perm.allow) ? perm.allow.filter((x): x is string => typeof x === "string") : [];
  if (!allow.includes(rule)) allow.push(rule);
  perm.allow = allow;
  doc.permissions = perm;
  doc.schemaVersion = 1;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return allow;
}
