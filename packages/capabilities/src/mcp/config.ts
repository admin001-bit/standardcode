// MCP 配置载体（WP-01；ADR-0040 决策 1/2）。
// 载体=settings 内嵌 `mcpServers` 键（§13 缺口"MCP 配置文件格式——M4 设计"清偿=ADR-0040 二选一）。
// 合并语义=**服务器粒度整对象替换**（低→高：user→projectShared→projectLocal→flag→managed），
// 绕开 settings merged 的叶子粒度（ADR-0030 合并=点路径叶子——mcpServers MUST NOT 经 settingsValue 消费，
// 混层对象风险；本 loader 直取 per-source docs，WP-06 注册表整体替换先例同口径）。
// 同名冲突=抑制+告警不改名（dig-05 §2.1 tQo :153938-153960 / 同名同配置仅 warning x0l :154004-154018 形状）。
import { interpolateEnv } from "./interp.ts";

export type McpSourceName = "user" | "projectShared" | "projectLocal" | "plugin" | "flag" | "managed";
/** 低→高序（与 SETTINGS_SOURCE_ORDER 同构，platform/settings.ts:18 镜像——此处自持避免 L3→L6 反向依赖 ARCH-001）。
 * plugin 位 [自定 2026-09-14 WP-09]：projectLocal 之上、flag 之下——对位 dig-05 :154586-154588 plugins 展开在
 * user→project→local 之后的末位高优；本仓 flag/managed 为策略面保持更高。plugin doc 非 settings 文件源，
 * 由 cli 装配层经 platform/plugin/installer.ts buildPluginDocs 聚合注入。 */
export const MCP_SOURCE_ORDER: readonly McpSourceName[] = ["user", "projectShared", "projectLocal", "plugin", "flag", "managed"];

export type McpTransportKind = "stdio" | "sse" | "http";

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  /** 声明式下沉 env（唯一显式通道；值经 ${VAR} 插值引用原始 process.env，ADR-0040 决策 5）。 */
  env?: Record<string, string>;
  /** 每服务器调用超时 ms（语义 WP-02 消费，本卡仅透传）。 */
  timeout?: number;
}
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface McpServerEntry {
  name: string;
  origin: McpSourceName;
  config: McpServerConfig;
}
export interface McpConfigIssue {
  name: string;
  origin: McpSourceName;
  /** 前置校验错误码（dig-05 §2.2 形状：缺 URL/command→UNCONFIGURED :298716 / 非法配置→INVALID_CONFIG :298746）。 */
  code: "UNCONFIGURED" | "INVALID_CONFIG";
  message: string;
}
export interface McpConfigWarning {
  server?: string;
  reason: string;
}

export interface McpLoadResult {
  servers: McpServerEntry[];
  issues: McpConfigIssue[];
  warnings: McpConfigWarning[];
}

/** 合法用户可配传输型（ORC-050 首批 stdio+SSE/Streamable HTTP；内部扩展 ws/sse-ide/sdk/proxy 拒收）。 */
export const MCP_TRANSPORT_TYPES = ["stdio", "sse", "http", "streamable-http"] as const;

/** 传输解析：缺省 stdio；streamable-http=别名→http；其余值拒绝（错误文案形状 dig-05 §6 :153511-153519）。 */
export function parseTransportType(raw: unknown): { kind: McpTransportKind } | { error: string } {
  if (raw === undefined) return { kind: "stdio" };
  if (typeof raw !== "string" || !MCP_TRANSPORT_TYPES.includes(raw as (typeof MCP_TRANSPORT_TYPES)[number])) {
    return { error: `Invalid transport type: ${String(raw)}. Must be one of: stdio, sse, http (or streamable-http)` };
  }
  return { kind: raw === "streamable-http" ? "http" : (raw as McpTransportKind) };
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
    else return undefined;
  }
  return out;
}

/** 单服务器终态解析（校验+${VAR} 插值；warnings/unresolved 记账由调用方注入 sink）。 */
export function resolveMcpServerConfig(
  name: string,
  origin: McpSourceName,
  raw: Record<string, unknown>,
  envBase: NodeJS.ProcessEnv,
  onWarn: (reason: string) => void,
): { ok: McpServerConfig } | { issue: { code: McpConfigIssue["code"]; message: string } } {
  const t = parseTransportType(raw.type);
  if ("error" in t) return { issue: { code: "INVALID_CONFIG", message: t.error } };
  const interp = (field: string, v: string): string => {
    const r = interpolateEnv(v, envBase);
    if (r.unresolved.length > 0) onWarn(`unresolved ${r.unresolved.map((u) => `\${${u}}`).join(", ")} in ${field} (left literal)`);
    return r.value;
  };
  const timeout = typeof raw.timeout === "number" ? { timeout: raw.timeout } : {};
  if (t.kind === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      return { issue: { code: "UNCONFIGURED", message: `stdio MCP server "${name}" requires command` } };
    }
    let args: string[] | undefined;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
        return { issue: { code: "INVALID_CONFIG", message: `MCP server "${name}" args must be a string array` } };
      }
      args = (raw.args as string[]).map((a) => interp("args", a));
    }
    const rawEnv = strRecord(raw.env);
    if (raw.env !== undefined && rawEnv === undefined) {
      return { issue: { code: "INVALID_CONFIG", message: `MCP server "${name}" env must be a string map` } };
    }
    const env = rawEnv ? Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, interp(`env.${k}`, v)])) : undefined;
    return {
      ok: { type: "stdio", command: interp("command", raw.command), ...(args ? { args } : {}), ...(env ? { env } : {}), ...timeout },
    };
  }
  if (typeof raw.url !== "string" || raw.url.trim() === "") {
    return { issue: { code: "UNCONFIGURED", message: `${t.kind} MCP server "${name}" requires url` } };
  }
  const url = interp("url", raw.url);
  try {
    new URL(url);
  } catch {
    return { issue: { code: "INVALID_CONFIG", message: `INVALID_CONFIG: url "${url}" is not a valid URL` } };
  }
  const headers = strRecord(raw.headers);
  if (raw.headers !== undefined && headers === undefined) {
    return { issue: { code: "INVALID_CONFIG", message: `MCP server "${name}" headers must be a string map` } };
  }
  const base = {
    url,
    ...(headers ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, interp(`headers.${k}`, v)])) } : {}),
    ...timeout,
  };
  return { ok: t.kind === "http" ? { type: "http", ...base } : { type: "sse", ...base } };
}

/**
 * 装载 mcpServers（ADR-0040 决策 2）：per-source docs 服务器粒度低→高整对象覆盖；
 * 同名=高来源胜（抑制不改名，dig-05 x0l/tQo 形状），同配置重定义与异配置重定义分别告警。
 * 入参 docs 允许 null/缺席（坏文件=M2 既有跳过语义 ADR-0030，本 loader 不重复处理）。
 */
export function loadMcpServerConfigs(
  docs: Partial<Record<McpSourceName, Record<string, unknown> | null>>,
  envBase: NodeJS.ProcessEnv = process.env,
): McpLoadResult {
  const warnings: McpConfigWarning[] = [];
  // 第一遍：选终态胜者（最高来源的定义），同名按层告警。
  const winners = new Map<string, { origin: McpSourceName; raw: Record<string, unknown> }>();
  for (const source of MCP_SOURCE_ORDER) {
    const doc = docs[source];
    if (!doc) continue;
    const mcpServers = doc.mcpServers;
    if (mcpServers === undefined) continue;
    if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
      warnings.push({ reason: `mcpServers in ${source} is not an object (skipped)` });
      continue;
    }
    for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        warnings.push({ server: name, reason: `MCP server "${name}" entry is not an object (skipped)` });
        continue;
      }
      const prior = winners.get(name);
      if (prior) {
        const identical = JSON.stringify(prior.raw) === JSON.stringify(raw);
        warnings.push({
          server: name,
          reason: identical
            ? `MCP server "${name}" duplicated identically across sources (suppressed, not renamed)`
            : `MCP server "${name}" redefined by higher source ${source}; lower definition suppressed (not renamed)`,
        });
      }
      winners.set(name, { origin: source, raw: raw as Record<string, unknown> });
    }
  }
  // 第二遍：终态解析（issue 不再遮蔽——最高来源坏定义即坏定义，与 [CC] "首中即返" 同口径）。
  const servers: McpServerEntry[] = [];
  const issues: McpConfigIssue[] = [];
  for (const [name, w] of [...winners].sort(([a], [b]) => a.localeCompare(b))) {
    const r = resolveMcpServerConfig(name, w.origin, w.raw, envBase, (reason) => warnings.push({ server: name, reason }));
    if ("issue" in r) issues.push({ name, origin: w.origin, code: r.issue.code, message: r.issue.message });
    else servers.push({ name, origin: w.origin, config: r.ok });
  }
  return { servers, issues, warnings };
}
