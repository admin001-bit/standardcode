// WP-09：插件安装器（ECO-032/033；DoD③⑤）。
// 目录布局 [自定]：安装件=<baseDir>/plugins/<name>/，留痕=<baseDir>/plugins.json
// {schemaVersion:1, plugins:[{name,version,source,installedAt,dir}], marketplaces:[{name,source}]}
//（ADR-0037 形制=坏 JSON 写侧拒覆盖+schemaVersion:1；读侧 fail-open 同 mcp-trust/agentTrust 先例）。
// git 源=git clone --depth 1 子进程 [自定]（本仓首个 clone 先例；trust.ts:89 ls-files 形制延伸）；
// 子进程 env 基线剥离就地最小实现（platform 不依赖 executor 的 sanitizeToolEnv——ARCH-001 分层，剥离规则对位 SEC-080）。
// remove=目录级清理+记录删（DoD⑤）。marketplace 解析见 marketplace.ts；缺省官方市场位=调用方传
// settings.plugins.defaultMarketplace（本模块不读 settings——纯 fs）。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_SCHEMA_VERSION, readPluginManifest, type PluginManifest } from "./manifest.ts";
import { MARKETPLACE_FILE, isGitSource, parseMarketplace } from "./marketplace.ts";
import { stripEnvBaseline } from "../env-baseline.ts";

export interface PluginRecord {
  name: string;
  version: string;
  /** 安装源快照（本地路径/git URL/marketplace 条目名——S-5 留痕"来源"）。 */
  source: string;
  installedAt: string;
  dir: string;
}

export interface MarketplaceRecord {
  name: string;
  source: string;
}

export interface PluginsDoc {
  schemaVersion: number;
  plugins: PluginRecord[];
  marketplaces: MarketplaceRecord[];
  /** 读侧告警（坏 JSON/坏条目；不落盘字段）。 */
  warnings: string[];
}

export function pluginsRootDir(baseDir: string): string {
  return path.join(baseDir, "plugins");
}
export function pluginsRecordFile(baseDir: string): string {
  return path.join(baseDir, "plugins.json");
}

function emptyDoc(): PluginsDoc {
  return { schemaVersion: PLUGIN_SCHEMA_VERSION, plugins: [], marketplaces: [], warnings: [] };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 读留痕（无文件/坏 JSON=空文档+告警，fail-open——list/聚合只读面）。 */
export function loadPluginsDoc(baseDir: string): PluginsDoc {
  const file = pluginsRecordFile(baseDir);
  let doc: Record<string, unknown> | null;
  try {
    doc = asRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDoc();
    return { ...emptyDoc(), warnings: [`${file}: invalid JSON (treated as empty; fix or delete the file): ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (doc === null) return { ...emptyDoc(), warnings: [`${file}: not a JSON object (treated as empty)`] };
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    return { ...emptyDoc(), warnings: [`${file}: unsupported schemaVersion ${String(doc.schemaVersion)} (treated as empty)`] };
  }
  const out = emptyDoc();
  for (const item of Array.isArray(doc.plugins) ? doc.plugins : []) {
    const r = asRecord(item);
    const name = r && typeof r.name === "string" ? r.name : undefined;
    const dir = r && typeof r.dir === "string" ? r.dir : undefined;
    if (!r || name === undefined || dir === undefined) {
      out.warnings.push(`${file}: plugin record missing name/dir (dropped)`);
      continue;
    }
    out.plugins.push({
      name,
      version: typeof r.version === "string" ? r.version : "",
      source: typeof r.source === "string" ? r.source : "",
      installedAt: typeof r.installedAt === "string" ? r.installedAt : "",
      dir,
    });
  }
  for (const item of Array.isArray(doc.marketplaces) ? doc.marketplaces : []) {
    const r = asRecord(item);
    if (!r || typeof r.source !== "string") {
      out.warnings.push(`${file}: marketplace record missing source (dropped)`);
      continue;
    }
    out.marketplaces.push({ name: typeof r.name === "string" ? r.name : r.source, source: r.source });
  }
  return out;
}

/** 写留痕（坏 JSON 现文件拒覆盖=不抹用户手工内容，ADR-0037 写侧保守）。 */
function savePluginsDoc(baseDir: string, doc: PluginsDoc): void {
  const file = pluginsRecordFile(baseDir);
  if (existsSync(file)) {
    try {
      if (asRecord(JSON.parse(readFileSync(file, "utf8"))) === null) throw new Error("not a JSON object");
    } catch (err) {
      throw new Error(`plugins.json invalid or non-object; refusing to overwrite (fix the file first): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: PLUGIN_SCHEMA_VERSION, plugins: doc.plugins, marketplaces: doc.marketplaces }, null, 2) + "\n",
    "utf8",
  );
}

/** 目录名净化（fs 安全子集；插件名→安装目录段 [自定]）。 */
export function sanitizePluginName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "plugin";
}

function normName(n: string): string {
  return n.toLowerCase();
}

/** git clone 注入面（测试可换桩；缺省真子进程 shell:false+env 基线剥离）。 */
export type GitRunner = (args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stderr?: string };

// WP-08：SEC-080 剥离规则提取至 env-baseline.ts 共享（行为零变——正则与遍历语义逐字节对位；
// updater npm 子进程与 git clone "清洗同面" DoD①）。

export const defaultGitRunner: GitRunner = (args, env) => {
  const r = spawnSync("git", args, { encoding: "utf8", env, windowsHide: true });
  return { status: r.status, stderr: r.stderr };
};

function gitClone(source: string, destDir: string, runGit: GitRunner, env: NodeJS.ProcessEnv): string | null {
  mkdirSync(path.dirname(destDir), { recursive: true });
  const r = runGit(["clone", "--depth", "1", "--", source, destDir], stripEnvBaseline(env));
  if (r.status !== 0) return `git clone failed (status ${String(r.status)}): ${(r.stderr ?? "").trim().slice(0, 300) || source}`;
  return null;
}

/** 复制目录（跳过 .git——克隆中转目录不留版本库）。 */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => path.basename(s) !== ".git",
  });
}

export interface InstallOutcome {
  ok: boolean;
  /** "no-manifest"|"exists"|"declined"|"clone-failed"|"marketplace-entry-not-found"（declined=S-5 确认未通过，零落地）。 */
  error?: "no-manifest" | "exists" | "declined" | "clone-failed" | "marketplace-entry-not-found";
  manifest?: PluginManifest;
  dir?: string;
  /** 目标=marketplace 仓库（根含 marketplace.json 无 plugin.json）时登记市场+返回索引条目（不装插件）。 */
  marketplace?: { name: string; source: string; entries: number };
  warnings: string[];
}

export interface InstallOptions {
  /** 临时目录根（克隆中转；缺省系统 tmp）。 */
  tmpRoot?: string;
  runGit?: GitRunner;
  env?: NodeJS.ProcessEnv;
  /** 现读 env 基线（缺省 process.env——纯 fs 纪律下由调用方注入）。 */
  now?: () => string;
  /**
   * S-5 安装确认钩子（DoD③）：manifest 解析成功、任何写盘（复制/留痕）之前调用；
   * false=拒绝零落地。确认 UI（i18n/对话框）在调用方（cli）——本模块纯 fs 不引渲染面。
   */
  onConfirm?: (manifest: PluginManifest) => Promise<boolean>;
}

/** 目录形态落装（确认钩子后复制+留痕；确认门的拒绝语义由调用方保证 fail-closed）。 */
export async function installPluginFromDir(sourceDir: string, baseDir: string, sourceLabel: string, opts: InstallOptions = {}): Promise<InstallOutcome> {
  const parsed = readPluginManifest(sourceDir);
  if (parsed.manifest === null) return { ok: false, error: "no-manifest", warnings: parsed.warnings };
  const m = parsed.manifest;
  const doc = loadPluginsDoc(baseDir);
  const warnings = [...doc.warnings, ...parsed.warnings];
  if (doc.plugins.some((p) => normName(p.name) === normName(m.name))) {
    return { ok: false, error: "exists", manifest: m, warnings: [...warnings, `plugin "${m.name}" is already installed (remove first)`] };
  }
  if (opts.onConfirm && !(await opts.onConfirm(m))) {
    return { ok: false, error: "declined", manifest: m, warnings: [...warnings, `install of "${m.name}" declined (S-5) — nothing landed`] };
  }
  let real = sourceDir;
  try {
    real = realpathSync(sourceDir);
  } catch {
    /* 解析失败按原路径 */
  }
  const destDir = path.join(pluginsRootDir(baseDir), sanitizePluginName(m.name));
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  try {
    copyTree(real, destDir);
  } catch (err) {
    return { ok: false, error: "no-manifest", warnings: [...warnings, `copy failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  doc.plugins.push({ name: m.name, version: m.version, source: sourceLabel, installedAt: (opts.now ?? (() => new Date().toISOString()))(), dir: destDir });
  savePluginsDoc(baseDir, doc);
  return { ok: true, manifest: m, dir: destDir, warnings };
}

export interface ResolveContext {
  baseDir: string;
  /** settings.plugins.defaultMarketplace 值（缺省官方市场位 [自定] 占位；git URL 或路径）。 */
  defaultMarketplace?: string;
  opts?: InstallOptions;
}

/** marketplace 源物化（目录=直用；git=临时克隆；调用方负责 returned.tempDir 清理）。 */
function materializeMarketplace(source: string, ctx: ResolveContext): { dir: string; tempDir?: string } | { error: string } {
  if (!isGitSource(source) && existsSync(source) && statSync(source).isDirectory()) return { dir: source };
  const tmpRoot = ctx.opts?.tmpRoot ?? tmpdir();
  const tempDir = path.join(mkdtempSafe(tmpRoot), "mkt");
  const err = gitClone(source, tempDir, ctx.opts?.runGit ?? defaultGitRunner, ctx.opts?.env ?? process.env);
  if (err) return { error: err };
  return { dir: tempDir, tempDir };
}

function mkdtempSafe(root: string): string {
  const base = path.join(root, `sc-plugin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

/** 目标解析并安装：本地目录 | git URL | marketplace 条目名（自定义市场记录+缺省市场位）。 */
export async function installPlugin(target: string, ctx: ResolveContext): Promise<InstallOutcome> {
  const doc = loadPluginsDoc(ctx.baseDir);
  // 1) 本地目录
  if (existsSync(target) && statSync(target).isDirectory()) return landPluginDir(target, target, ctx, doc);
  // 2) git URL（插件仓库或市场仓库）
  if (isGitSource(target)) {
    const mat = materializeMarketplace(target, ctx);
    if ("error" in mat) return { ok: false, error: "clone-failed", warnings: [mat.error] };
    try {
      return await landPluginDir(mat.dir, target, ctx, doc);
    } finally {
      if (mat.tempDir) rmSync(path.dirname(mat.tempDir), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
  // 3) 名字→已配置市场检索（marketplace 条目 source 再走 1/2）
  const marketplaces = [
    ...doc.marketplaces,
    ...(ctx.defaultMarketplace ? [{ name: "default", source: ctx.defaultMarketplace }] : []),
  ];
  for (const mkt of marketplaces) {
    const mat = materializeMarketplace(mkt.source, ctx);
    if ("error" in mat) continue;
    try {
      const file = path.join(mat.dir, MARKETPLACE_FILE);
      if (!existsSync(file)) continue;
      const parsed = parseMarketplace(readFileSync(file, "utf8"), file);
      const entry = parsed.marketplace?.entries.find((e) => normName(e.name) === normName(target));
      if (!entry) continue;
      return await installPlugin(entry.source, { ...ctx, defaultMarketplace: undefined }); // 条目源递归解析（不再走名字路）
    } finally {
      if (mat.tempDir) rmSync(path.dirname(mat.tempDir), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
  return { ok: false, error: "marketplace-entry-not-found", warnings: [`plugin "${target}" not found in configured marketplaces`] };
}

/** 落地判定：根含 plugin.json=装插件；否则根含 marketplace.json=登记为自定义市场（DoD②）。 */
async function landPluginDir(dir: string, sourceLabel: string, ctx: ResolveContext, doc: PluginsDoc): Promise<InstallOutcome> {
  if (existsSync(path.join(dir, "plugin.json"))) return installPluginFromDir(dir, ctx.baseDir, sourceLabel, ctx.opts);
  const mktFile = path.join(dir, MARKETPLACE_FILE);
  if (existsSync(mktFile)) {
    const parsed = parseMarketplace(readFileSync(mktFile, "utf8"), mktFile);
    if (parsed.marketplace === null) return { ok: false, error: "no-manifest", warnings: [...doc.warnings, ...parsed.warnings] };
    const fresh = loadPluginsDoc(ctx.baseDir);
    const warnings = [...fresh.warnings, ...parsed.warnings];
    const name = parsed.marketplace.name;
    if (!fresh.marketplaces.some((m) => m.source === sourceLabel)) {
      fresh.marketplaces.push({ name, source: sourceLabel });
      savePluginsDoc(ctx.baseDir, fresh);
    }
    return { ok: true, marketplace: { name, source: sourceLabel, entries: parsed.marketplace.entries.length }, warnings };
  }
  return { ok: false, error: "no-manifest", warnings: [...doc.warnings, `no plugin.json or marketplace.json at: ${dir}`] };
}

/** 卸载=目录级清理+留痕删（DoD⑤；大小写不敏感匹配）。 */
export function removePlugin(name: string, baseDir: string): { removed: boolean; dir?: string; warnings: string[] } {
  const doc = loadPluginsDoc(baseDir);
  const idx = doc.plugins.findIndex((p) => normName(p.name) === normName(name));
  if (idx < 0) return { removed: false, warnings: doc.warnings };
  const [rec] = doc.plugins.splice(idx, 1);
  savePluginsDoc(baseDir, doc);
  try {
    rmSync(rec!.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (err) {
    doc.warnings.push(`plugin dir cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { removed: true, dir: rec!.dir, warnings: doc.warnings };
}

// —— 会话聚合视图（四注入面消费；安装确认≠信任确认，各组件生效仍过 WP-03/04/05/SEC-070 既有门）——

export interface InstalledPluginView {
  record: PluginRecord;
  /** null=装后坏件（告警继续，该件不进注入面）。 */
  manifest: PluginManifest | null;
  warnings: string[];
}

export function loadInstalledPlugins(baseDir: string): InstalledPluginView[] {
  const doc = loadPluginsDoc(baseDir);
  const views: InstalledPluginView[] = [];
  for (const record of [...doc.plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!existsSync(record.dir)) {
      views.push({ record, manifest: null, warnings: [...doc.warnings, `plugin "${record.name}": install dir missing (${record.dir}) — skipped`] });
      continue;
    }
    const parsed = readPluginManifest(record.dir);
    views.push({ record, manifest: parsed.manifest, warnings: [...doc.warnings, ...parsed.warnings] });
  }
  return views;
}

export interface PluginDocs {
  /** hooks 配置源聚合（loadHookConfigs 的 plugin doc；null=无插件 hooks 声明）。 */
  hooksDoc: Record<string, unknown> | null;
  /** MCP 声明聚合（loadMcpServerConfigs 的 plugin doc mcpServers；null=无声明）。 */
  mcpDoc: Record<string, unknown> | null;
  warnings: string[];
}

/**
 * hooks/MCP 注入面聚合（DoD④；插件序=name localeCompare 确定性）。
 * hooks=逐事件组拼接（插件位=五 settings 源之下最低，先执行序由 loadHookConfigs 合并序决定）；
 * MCP=同名抑制不改名+告警（:154600 形状，层内先到先得——跨来源覆盖由 MCP_SOURCE_ORDER plugin 位决定）。
 */
export function buildPluginDocs(views: InstalledPluginView[]): PluginDocs {
  const warnings: string[] = [];
  const hooks: Record<string, unknown> = {};
  let hasHooks = false;
  const mcpServers: Record<string, unknown> = {};
  let hasMcp = false;
  for (const v of views) {
    if (v.manifest === null) {
      for (const w of v.warnings) if (!warnings.includes(w)) warnings.push(w);
      continue;
    }
    const tag = `plugin "${v.record.name}"`;
    for (const w of v.warnings) if (!warnings.includes(w)) warnings.push(w);
    const h = v.manifest.components.hooks;
    if (h !== null) {
      for (const [event, groups] of Object.entries(h)) {
        if (!Array.isArray(groups)) {
          warnings.push(`${tag}: hooks.${event} is not an array (skipped)`);
          continue;
        }
        hasHooks = true;
        hooks[event] = [...((hooks[event] as unknown[]) ?? []), ...groups];
      }
    }
    const m = v.manifest.components.mcpServers;
    if (m !== null) {
      hasMcp = true;
      for (const [name, cfg] of Object.entries(m)) {
        if (Object.hasOwn(mcpServers, name)) {
          warnings.push(`${tag}: MCP server "${name}" already defined by earlier plugin (suppressed, not renamed)`);
          continue;
        }
        mcpServers[name] = cfg;
      }
    }
  }
  return {
    hooksDoc: hasHooks ? { hooks } : null,
    mcpDoc: hasMcp ? { mcpServers } : null,
    warnings,
  };
}

/** 确认对话框组件清单计数（DoD③ S-5：N commands/N agents/N skills/hooks/MCP 逐名；坏件面=安装前 manifest+目录扫描）。 */
export interface PluginComponentCounts {
  commands: string[];
  agents: number;
  skills: string[];
  hookEvents: string[];
  mcpServers: string[];
}

export function componentCounts(manifest: PluginManifest): PluginComponentCounts {
  const agents = new Set<string>();
  for (const dir of manifest.components.agentsDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const e of entries) if (typeof e === "string" && e.toLowerCase().endsWith(".md")) agents.add(path.join(dir, e));
  }
  const skills: string[] = [];
  for (const dir of manifest.components.skillsDirs) {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) if (d.isDirectory() && existsSync(path.join(dir, d.name, "SKILL.md"))) skills.push(d.name);
  }
  const hookEvents = manifest.components.hooks ? Object.keys(manifest.components.hooks) : [];
  return {
    commands: manifest.components.commands,
    agents: agents.size,
    skills: skills.sort(),
    hookEvents: hookEvents.sort(),
    mcpServers: manifest.components.mcpServers ? Object.keys(manifest.components.mcpServers).sort() : [],
  };
}
