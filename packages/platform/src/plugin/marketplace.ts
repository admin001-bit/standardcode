// WP-09：marketplace.json 索引解析（ECO-032：marketplace=marketplace.json 索引+插件源列表）。
// [CC] 官方 marketplace URL 无一手锚（卡参考资料注记）→条目形状/键位全 [自定]：
// {schemaVersion?, name?, plugins: [{name, version?, source, description?}]}，source=git URL 或路径（安装器解释）。
// 缺省官方市场位=settings.plugins.defaultMarketplace 键占位（无一手 URL；占位登记走结果页）。
import { PLUGIN_SCHEMA_VERSION } from "./manifest.ts";

export const MARKETPLACE_FILE = "marketplace.json";

export interface MarketplaceEntry {
  name: string;
  version?: string;
  /** 插件源：git URL（https/git@/.git 结尾）或目录路径——installer 解释。 */
  source: string;
  description?: string;
}

export interface MarketplaceIndex {
  name: string;
  entries: MarketplaceEntry[];
}

export interface ParsedMarketplace {
  file: string;
  marketplace: MarketplaceIndex | null;
  warnings: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** marketplace.json 文本解析（不抛：坏 JSON/非对象/无插件数组=marketplace null+告警继续）。 */
export function parseMarketplace(text: string, file: string): ParsedMarketplace {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { file, marketplace: null, warnings: [`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — marketplace skipped`] };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { file, marketplace: null, warnings: [`${file}: not a JSON object — marketplace skipped`] };
  }
  const d = doc as Record<string, unknown>;
  if (d.schemaVersion !== undefined && d.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    warnings.push(`${file}: unsupported schemaVersion ${String(d.schemaVersion)} (current contract = ${PLUGIN_SCHEMA_VERSION}; parsed best-effort)`);
  }
  const plugins = d.plugins;
  if (!Array.isArray(plugins)) {
    return { file, marketplace: null, warnings: [...warnings, `${file}: 'plugins' array is required`] };
  }
  const entries: MarketplaceEntry[] = [];
  for (const item of plugins) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`${file}: marketplace plugins entry is not an object (dropped)`);
      continue;
    }
    const e = item as Record<string, unknown>;
    const name = str(e.name);
    const source = str(e.source);
    if (name === undefined || source === undefined) {
      warnings.push(`${file}: marketplace plugins entry requires name+source (dropped)`);
      continue;
    }
    const version = str(e.version);
    const description = str(e.description);
    entries.push({ name, source, ...(version !== undefined ? { version } : {}), ...(description !== undefined ? { description } : {}) });
  }
  if (entries.length === 0) {
    return { file, marketplace: null, warnings: [...warnings, `${file}: no valid marketplace entries`] };
  }
  return { file, marketplace: { name: str(d.name) ?? file, entries }, warnings };
}

/** git URL 形态判定（安装源解释用 [自定]：https:// | git@ | .git 结尾）。 */
export function isGitSource(source: string): boolean {
  return /^https?:\/\//i.test(source) || /^git@/i.test(source) || /\.git$/i.test(source);
}
