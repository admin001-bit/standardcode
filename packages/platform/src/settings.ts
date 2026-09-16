// settings 五来源合并序（v2.8 §7.7 实证段）：managed(企业) > 命令行 flag > 项目 local > 项目共享 > 用户。
// [CC] 同构：_704.js 五来源数组为低→高序、消费函数自末尾遍历首个命中即返回（§7.7）；列表键跨层合并。
// settings 注入 env 进程存活期不可 unset（§7.7 原文）：注入后键被省略或置 null 均不解除，更新允许（粘滞语义，ADR-0030）。
// 落盘布局（§9.1 Q-2/Q-3 结论继承）：写入只落原生布局 .standardcode/；managed 路径=Q-3 原文
//（Windows C:\ProgramData\StandardCode\、macOS /Library/Application Support/StandardCode/；Linux Q-3 未列 → [自定] /etc/standardcode/，POSIX 惯例，ADR-0030）。
// 键位全集（§13 行 3 处置）：ADR-0030。settings 文件带 schemaVersion（ENG-080）；坏 JSON/版本不符 → 跳过+告警（启动不因单个坏文件拒起，ADR-0030）。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SETTINGS_SCHEMA_VERSION = 1;

export type SettingsSourceName = "user" | "projectShared" | "projectLocal" | "flag" | "managed";

/** 低→高序（_704.js 数组同构；消费自末尾遍历首个命中即返回）。 */
export const SETTINGS_SOURCE_ORDER: readonly SettingsSourceName[] = [
  "user",
  "projectShared",
  "projectLocal",
  "flag",
  "managed",
];

/** 列表键（跨层合并；键位全集见 ADR-0030，此处为 M2 已消费键的最小集）。 */
export const LIST_KEYS: readonly string[] = [
  "permissions.allow",
  "permissions.deny",
  "permissions.ask",
  "additionalDirectories",
  "providers.openai.models",
];

export type SettingsDoc = Record<string, unknown>;

export interface SourcePaths {
  user: string;
  projectShared: string;
  projectLocal: string;
  managed: string;
}

/** managed-settings.json 落盘路径（Q-3：Windows C:\ProgramData\StandardCode\、macOS /Library/Application Support/StandardCode/）。
 * programData=管理层基目录覆写（win32=Q-3 原文通道，缺省读 ProgramData env；darwin/Linux 供测试与部署显式覆写，
 * 不读 ProgramData env——该 env 仅 Windows 语义，Windows runner 上会渗入 posix 分支，CI 三平台矩阵 2026-09-09 实测）。
 * join 随 platform 语义（win32→win32.join，其余→posix.join），与实际读写文件系统一致。 */
export function managedSettingsPath(
  platform: NodeJS.Platform = process.platform,
  programData?: string,
): string {
  if (platform === "win32") {
    return path.win32.join(programData ?? process.env.ProgramData ?? "C:\\ProgramData", "StandardCode", "managed-settings.json");
  }
  if (platform === "darwin") {
    return path.posix.join(programData ?? "/Library/Application Support/StandardCode", "managed-settings.json");
  }
  return path.posix.join(programData ?? "/etc/standardcode", "managed-settings.json"); // [自定] Q-3 未列 Linux
}

export function settingsSourcePaths(
  projectRoot: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  programData = process.env.ProgramData,
): SourcePaths {
  const native = path.join(projectRoot, ".standardcode");
  return {
    user: path.join(home, ".standardcode", "settings.json"),
    projectShared: path.join(native, "settings.json"),
    projectLocal: path.join(native, "settings.local.json"),
    managed: managedSettingsPath(platform, programData),
  };
}

export interface LoadedSettings {
  /** 五来源原始文档（缺源=null；flag=装配期注入对象，无文件）。 */
  docs: Record<SettingsSourceName, SettingsDoc | null>;
  /** 合并结果：叶子键扁平点路径（如 "permissions.allow"、"providers.openai.baseUrl"）；标量/对象键最高来源胜出，列表键高→低拼接去重。 */
  merged: Record<string, unknown>;
  /** 命中合并的来源（高→低）。 */
  effectiveSources: SettingsSourceName[];
  /** 读取告警（坏 JSON/schemaVersion 不符——跳过该文件不阻断）。 */
  warnings: { source: SettingsSourceName; path: string; reason: string }[];
}

export interface LoadSettingsOptions {
  projectRoot: string;
  home?: string;
  /** 命令行 flag 源（--settings 早期处理同构：装配期注入对象，优先级仅低于 managed）。 */
  flagOverrides?: Record<string, unknown>;
  platform?: NodeJS.Platform;
  programData?: string;
}

/** 收集叶子键（点路径）。叶子=非对象值或数组；纯分组对象继续下钻。 */
function collectLeaves(doc: SettingsDoc, prefix: string, out: Map<string, unknown>): void {
  for (const [k, v] of Object.entries(doc)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      collectLeaves(v as SettingsDoc, key, out);
    } else {
      out.set(key, v);
    }
  }
}

function readSourceFile(filePath: string): { doc: SettingsDoc | null; warning?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { doc: null }; // 文件不存在=来源缺席（常态，非告警）
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { doc: null, warning: "invalid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { doc: null, warning: "not a JSON object" };
  }
  const doc = parsed as SettingsDoc;
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { doc: null, warning: `unsupported schemaVersion ${String(doc.schemaVersion)}` };
  }
  return { doc };
}

export function loadSettings(opts: LoadSettingsOptions): LoadedSettings {
  const paths = settingsSourcePaths(opts.projectRoot, opts.home, opts.platform, opts.programData);
  const warnings: LoadedSettings["warnings"] = [];
  const docs: Record<SettingsSourceName, SettingsDoc | null> = {
    user: null,
    projectShared: null,
    projectLocal: null,
    flag: opts.flagOverrides ? { ...opts.flagOverrides } : null,
    managed: null,
  };
  for (const source of ["user", "projectShared", "projectLocal", "managed"] as const) {
    const { doc, warning } = readSourceFile(paths[source]);
    docs[source] = doc;
    if (warning) warnings.push({ source, path: paths[source], reason: warning });
  }
  return mergeSettingsDocs(docs, warnings);
}

/** 合并核心（WP-07 提取复用：信任门控对 docs 过滤后重合并，见 trust.ts applyTrustGate）。 */
export function mergeSettingsDocs(docs: Record<SettingsSourceName, SettingsDoc | null>, warnings: LoadedSettings["warnings"] = []): LoadedSettings {
  // 合并：叶子键并集；标量/对象键自末尾（最高）遍历首中即返；列表键高→低拼接去重。
  const merged: Record<string, unknown> = {};
  const keyOrder: string[] = [];
  const perKey = new Map<string, { source: SettingsSourceName; value: unknown }[]>();
  for (const source of SETTINGS_SOURCE_ORDER) {
    const doc = docs[source];
    if (!doc) continue;
    const leaves = new Map<string, unknown>();
    collectLeaves(doc, "", leaves);
    for (const [key, value] of leaves) {
      if (key === "schemaVersion") continue; // 信封字段，非设置键
      if (!perKey.has(key)) {
        perKey.set(key, []);
        keyOrder.push(key);
      }
      perKey.get(key)!.push({ source, value });
    }
  }
  for (const key of keyOrder) {
    const entries = perKey.get(key)!; // 低→高
    if (LIST_KEYS.includes(key)) {
      const seen = new Set<string>();
      const list: unknown[] = [];
      for (const { value } of [...entries].reverse()) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          const sig = JSON.stringify(item);
          if (seen.has(sig)) continue;
          seen.add(sig);
          list.push(item);
        }
      }
      merged[key] = list.length > 0 ? list : undefined; // 无任何有效数组贡献 → 键缺席（合并语义无"清空"操作）
      if (merged[key] === undefined) delete merged[key];
    } else {
      merged[key] = entries[entries.length - 1].value; // 首中即返（最高来源）
    }
  }

  const effectiveSources = SETTINGS_SOURCE_ORDER.filter((s) => docs[s] !== null).reverse();
  scanSuspectedSecrets(docs, warnings);
  return { docs, merged, effectiveSources, warnings };
}

/** SEC-030 疑似密钥告警（WP-05 清偿；§11 行 457 原文：settings 出现疑似密钥〔≥20 字符赋给 KEY/TOKEN/SECRET 类命名键〕
 * MUST 警告并建议 keychain）。逐来源扫描叶子键（分词边界匹配，防 "monkey" 类误报 [自定]：
 * camelCase 先按大写字母切分再按非字母数字分词，段 ∈ {key,keys,token,tokens,secret,secrets,apikey,apikeys}）；
 * 命名命中且值为长度 ≥20 的字符串 → 告警（键值本体不入告警文本，防二次落盘）。 */
function scanSuspectedSecrets(docs: Record<SettingsSourceName, SettingsDoc | null>, warnings: LoadedSettings["warnings"]): void {
  const SECRET_NAME_SEGMENTS = new Set(["key", "keys", "token", "tokens", "secret", "secrets", "apikey", "apikeys"]);
  for (const source of SETTINGS_SOURCE_ORDER) {
    const doc = docs[source];
    if (!doc) continue;
    const leaves = new Map<string, unknown>();
    collectLeaves(doc, "", leaves);
    for (const [key, value] of leaves) {
      if (typeof value !== "string" || value.length < 20) continue;
      const segments = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter((s) => s !== "");
      if (!segments.some((s) => SECRET_NAME_SEGMENTS.has(s))) continue;
      warnings.push({ source, path: `settings(${key})`, reason: "suspected plaintext secret (>=20 chars assigned to a *KEY*/*TOKEN*/*SECRET*-named key) - prefer keychain or environment variables (SEC-030)" });
    }
  }
}

/** 取合并后设置值（merged 为扁平点路径）。 */
export function settingsValue<T>(loaded: LoadedSettings, key: string): T | undefined {
  const v = loaded.merged[key];
  return v === undefined ? undefined : (v as T);
}

export interface SettingsEnvHandle {
  /** 已注入键（粘滞登记：进程存活期不可 unset 的机械凭证）。 */
  injected: Set<string>;
}

export interface ApplyEnvResult {
  injected: string[];
  /** 因 null/undefined 或注入后被省略而未动作的键。 */
  skipped: string[];
  /** SEC-020b：黑名单键被拒注入（项目级源；值不落 target）。 */
  blocked: string[];
}

/** SEC-020b 黑名单（§11 行 456 原文点名：PATH/LD_PRELOAD/NODE_OPTIONS 类键禁止经项目级 settings 注入）。
 * 类边界=spec 点名三键 [自定]（BASH_ENV/ENV 等执行面键由 SEC-080 子进程剥离另闸）；匹配对大小写不敏感
 *（Windows env 键不区分大小写，env.Path 同面）。 */
export const SEC_020B_BLOCKED_ENV_KEYS: readonly string[] = ["PATH", "LD_PRELOAD", "NODE_OPTIONS"];

/**
 * settings 注入 env（§7.7：进程存活期不可 unset）。粘滞语义（ADR-0030）：
 * 注入后键被省略或置 null → 不解除；同键再注入新值 → 允许更新（managed 可纠偏）。
 * handle 由调用方持有（默认新建）；重复传入同一 handle 即延续粘滞登记。
 * SEC-020b（WP-05 清偿）：黑名单键（PATH/LD_PRELOAD/NODE_OPTIONS）经**项目级源**（projectShared/projectLocal）
 * 声明 = 拒注入 + 告警（复用 loaded.warnings 通道，/doctor 自然呈现）；managed/user/flag 源不设限（管理层/本机自有）[自定]。
 */
export function applySettingsEnv(
  loaded: LoadedSettings,
  target: Record<string, string | undefined>,
  handle: SettingsEnvHandle = { injected: new Set<string>() },
): ApplyEnvResult {
  const injected: string[] = [];
  const skipped: string[] = [];
  const blocked: string[] = [];
  const envKeys = Object.keys(loaded.merged).filter((k) => k.startsWith("env."));
  const present = new Set(envKeys);
  // 逐 env 键解析最高来源（高→低首中即返；collectLeaves 展平语义与合并一致）
  const sourceOfKey = new Map<string, SettingsSourceName>();
  for (const source of [...SETTINGS_SOURCE_ORDER].reverse()) {
    const doc = loaded.docs[source];
    if (!doc) continue;
    const leaves = new Map<string, unknown>();
    collectLeaves(doc, "", leaves);
    for (const key of envKeys) if (leaves.has(key) && !sourceOfKey.has(key)) sourceOfKey.set(key, source);
  }
  for (const key of envKeys) {
    const name = key.slice(4);
    const value = loaded.merged[key];
    if (value === null || value === undefined) {
      skipped.push(name);
      continue;
    }
    const source = sourceOfKey.get(key);
    const isProjectSource = source === "projectShared" || source === "projectLocal";
    if (isProjectSource && SEC_020B_BLOCKED_ENV_KEYS.some((b) => b.toUpperCase() === name.toUpperCase())) {
      blocked.push(name);
      loaded.warnings.push({ source: source!, path: `settings(env.${name})`, reason: "SEC-020b blocked: this env key cannot be injected from project-level settings" });
      continue;
    }
    target[name] = String(value);
    handle.injected.add(name);
    injected.push(name);
  }
  // 粘滞：此前注入、本轮被省略的键不解除（target 侧无动作即保持）。
  for (const name of handle.injected) {
    if (!present.has(`env.${name}`)) skipped.push(name);
  }
  return { injected, skipped, blocked };
}
