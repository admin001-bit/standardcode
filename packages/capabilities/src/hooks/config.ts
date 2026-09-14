// WP-04：hooks 配置载体（settings 五来源合并）+事件注册表+query 映射。
// 形状出处：[CC] settings.hooks 形态=每事件 matcher 组数组（dig-04 §3.1 来源注册：policy(managed)+user+project+flag
// 顺序合并，managed 最高优先）；事件集=v2.8 §9.3 附注 M4 首批 13 事件（[CC] 31 事件全集取 spec 子集，B-03）；
// query 取值=vBr（dig-04 §3.2：工具事件 tool_name、SessionStart source、SessionEnd reason、SubagentStart/SubagentStop
// agent_type；其余无 query——matcher 被整体跳过 :261743）。disableAllHooks 总闸+managed 最高优先=dig-04 §7.5。
import type { McpSourceName } from "../mcp/config.ts";

/** M4 首批 13 事件（v2.8 §9.3 附注；[CC] wsu 注册表 31 事件的本卡子集，B-03）。 */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SubagentStart",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
  "Notification",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface HookCommandConfig {
  type: "command";
  command: string;
  /** 每 hook 超时（秒，dig-04 §3.4 "s.timeout * 1000"；缺省=事件默认 600000ms）。 */
  timeout?: number;
}
export interface HookHttpConfig {
  type: "http";
  url: string;
  timeout?: number;
}
export type HookConfig = HookCommandConfig | HookHttpConfig;

/** matcher 组（[CC] settings.hooks 形态：{ matcher?, hooks: [...] }；source=来源登记，decisionReason hookSource 消费）。 */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookConfig[];
  source: string;
}

/** 事件 query 映射（dig-04 §3.2 vBr；返回 undefined=无 query——matcher 整体跳过 :261743，全执行）。 */
export function hookQueryFor(event: HookEventName, q: { toolName?: string; agentType?: string; source?: string; reason?: string }): string | undefined {
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" || event === "PermissionRequest") return q.toolName;
  if (event === "SubagentStart" || event === "SubagentStop") return q.agentType;
  if (event === "SessionStart") return q.source;
  if (event === "SessionEnd") return q.reason;
  return undefined;
}

export interface LoadedHooksConfig {
  /** 逐事件 matcher 组（高→低来源拼接序：managed→flag→projectLocal→projectShared→user——managed 组先执行=最高优先）。 */
  events: Partial<Record<HookEventName, HookMatcherGroup[]>>;
  /** disableAllHooks 总闸（最高来源 true 即全关，dig-04 §7.5）。 */
  disableAllHooks: boolean;
  /** http hook URL 白名单（跨来源收集去重；白名单外运行时拒绝，dig-04 §7.2）。 */
  allowedHttpHookUrls: string[];
  warnings: string[];
}

/** settings 来源高→低序（managed 最高优先；与 SETTINGS_SOURCE_ORDER 反序，此处自持避免反向依赖）。
 * plugin 位 [自定 2026-09-14 WP-09]：五 settings 源之下最低（组先执行序=最后）——插件 hooks 是安装确认过的
 * 第三方配置，不得压过用户本机设置；doc 由 cli 装配层聚合注入（platform/plugin/installer.ts buildPluginDocs）。 */
const SOURCE_HIGH_TO_LOW: readonly McpSourceName[] = ["managed", "flag", "projectLocal", "projectShared", "user", "plugin"];

function parseHookConfig(raw: unknown, source: string, warnings: string[]): HookConfig | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`hooks entry in ${source} is not an object (skipped)`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const timeout = typeof r.timeout === "number" && Number.isFinite(r.timeout) && r.timeout > 0 ? { timeout: r.timeout } : {};
  if (r.type === "http") {
    if (typeof r.url !== "string" || r.url.trim() === "") {
      warnings.push(`http hook in ${source} requires url (skipped)`);
      return null;
    }
    return { type: "http", url: r.url, ...timeout };
  }
  if (typeof r.command !== "string" || r.command.trim() === "") {
    warnings.push(`hook in ${source} requires command (type 缺省 command; skipped)`);
    return null;
  }
  return { type: "command", command: r.command, ...timeout };
}

/**
 * 五来源合并（DoD①）：每事件 matcher 组按高→低来源拼接（managed 组先执行=最高优先）；
 * disableAllHooks=最高来源定义 true 即总闸（dig-04 §3.1/§7.5 形状）。坏件告警继续（WP-01 loader 同口径）。
 */
export function loadHookConfigs(docs: Partial<Record<McpSourceName, Record<string, unknown> | null>>): LoadedHooksConfig {
  const warnings: string[] = [];
  const events: Partial<Record<HookEventName, HookMatcherGroup[]>> = {};
  const allowedHttpHookUrls = new Set<string>();
  let disableAllHooks = false;
  for (const source of SOURCE_HIGH_TO_LOW) {
    const doc = docs[source];
    if (!doc) continue;
    if (doc.disableAllHooks === true) disableAllHooks = true;
    if (Array.isArray(doc.allowedHttpHookUrls)) {
      for (const u of doc.allowedHttpHookUrls) if (typeof u === "string") allowedHttpHookUrls.add(u);
    }
    const hooks = doc.hooks;
    if (hooks === undefined) continue;
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
      warnings.push(`hooks in ${source} is not an object (skipped)`);
      continue;
    }
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        warnings.push(`unknown hook event "${event}" in ${source} (skipped)`);
        continue;
      }
      if (!Array.isArray(groups)) {
        warnings.push(`hooks.${event} in ${source} is not an array (skipped)`);
        continue;
      }
      const parsed: HookMatcherGroup[] = [];
      for (const g of groups) {
        if (g === null || typeof g !== "object" || Array.isArray(g)) {
          warnings.push(`hooks.${event} group in ${source} is not an object (skipped)`);
          continue;
        }
        const gr = g as Record<string, unknown>;
        if (!Array.isArray(gr.hooks)) {
          warnings.push(`hooks.${event} group in ${source} missing hooks array (skipped)`);
          continue;
        }
        const configs: HookConfig[] = [];
        for (const h of gr.hooks) {
          const c = parseHookConfig(h, source, warnings);
          if (c) configs.push(c);
        }
        if (configs.length === 0) continue;
        parsed.push({ ...(typeof gr.matcher === "string" && gr.matcher !== "" ? { matcher: gr.matcher } : {}), hooks: configs, source });
      }
      if (parsed.length === 0) continue;
      const key = event as HookEventName;
      events[key] = [...(events[key] ?? []), ...parsed]; // 高来源组在前（先执行）
    }
  }
  return { events, disableAllHooks, allowedHttpHookUrls: [...allowedHttpHookUrls], warnings };
}
