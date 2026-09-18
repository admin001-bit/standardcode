// ORC-050 实验特性位（v2.8 行 299 原文："Teams/workflow 发布默认关闭（feature flag + 文档标 experimental）"）：
// 门基座 = 双源解析（env 逃逸舱 / settings）+ 具名 flag 注册表 + 告警面（不静默丢弃）。
// 本模块只承载判定（纯函数可单测，不触盘不触网）；斜杠命令注册门由宿主 apps/cli 承担——命令表属 L0
// （cli-terminal），platform 不感知命令名，层向 L0→L6（ARCH-001）。
// 键位 [自定]（登记义务随 M6-1 结果页；形制承 M5-WP-03 sandbox-config / M5-WP-06 telemetry 同族）：
//   总闸 = env STANDARD_CODE_EXPERIMENTAL（"1"/"true"/"yes"/"on" 开、"0"/"false"/"no"/"off" 关——逃逸舱，凌驾 settings）
//          > settings experimental.enabled（布尔字面 true 才开）；
//   具名 = settings experimental.flags（字符串数组；缺席=注册表全量随总闸；列出即白名单，未列=不开）。
// 生效序明文（DoD② [自定] 登记供 V）：env 逃逸舱 > settings。settings 源**内部**的层级序=§7.7 五来源
// （managed > 命令行 flag > 项目 local > 项目共享 > 用户），由 loadSettings 合并承载，本模块只消费合并值。
// fail-closed（不猜）：env 非法非空值 / settings 非布尔 / flags 非数组 → 一律不启用（不回退下层、不猜意图）；
// 未知 flag 名与非法条目 = 告警 + 忽略该条（M4 WP-05 O1 同族教训：静默丢弃即旁路）。
// 生效口径 [自定]：启动期解析一次（命令表是启动期构造，翻键=重启生效）；env 源=process.env 直读
// （不经 settings env.* 注入副本——逃逸舱=宿主环境总闸，telemetry 同口径）。

/** 逃逸舱总闸（[自定] 名；ADR-0007 前缀族：STANDARD_CODE_*）。 */
export const EXPERIMENTAL_ENV_KEY = "STANDARD_CODE_EXPERIMENTAL";
/** settings 子树前缀与两键（点路径口径，settings.ts collectLeaves 同族）。 */
export const EXPERIMENTAL_SETTINGS_PREFIX = "experimental";
export const EXPERIMENTAL_SETTINGS_KEY = "experimental.enabled";
export const EXPERIMENTAL_FLAGS_SETTINGS_KEY = "experimental.flags";

/**
 * 具名实验 flag 注册表 [自定]（M6 范围=§2 行 114"Agent Teams、workflow"+§6 行 291"含 fork 型 subagent"）。
 * BLK-06=①（2026-09-18 用户裁决）：M6 只落 `/workflows` `/fork` `/export` 三命令，`/branch` `/batch`
 * `/loop` `/btw` 推后 M7——**M7 命令名不进本注册表**（B-03：进不了本 M 的 MUST 不提前实现）。
 */
export const EXPERIMENTAL_FLAGS = ["workflow", "teams", "fork"] as const;
export type ExperimentalFlag = (typeof EXPERIMENTAL_FLAGS)[number];

export interface ExperimentalGate {
  /** 总闸（默认 false=零行为变化）。 */
  enabled: boolean;
  /** 生效具名 flag（总闸关/fail-closed 恒空数组）。 */
  flags: readonly ExperimentalFlag[];
  /** 告警行（非法值 / 未知 flag 名 / 非法条目 / 未知配置键——宿主打印，禁静默丢弃）。 */
  notices: string[];
}

export interface ExperimentalGateInput {
  /** env 源（缺省=无；宿主传 process.env）。 */
  env?: Record<string, string | undefined>;
  /** settings 的 `experimental` 子树（未设置=undefined；由 experimentalSettingsFrom 自合并值切出）。 */
  settings?: Record<string, unknown>;
}

/** 开关值解析（sandbox-config truthy 同形）：命中 1/true/yes/on|0/false/no/off 返回布尔；空白=缺席；余=非法 undefined。 */
function parseSwitch(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  return undefined;
}

/**
 * 自合并（扁平点路径）settings 值切出 `experimental` 子树；无该前缀键=undefined。
 * 供 resolveExperimental 消费，同时保留未知键可见性（未知键告警靠子树键集完整）。
 */
export function experimentalSettingsFrom(merged: Record<string, unknown>): Record<string, unknown> | undefined {
  const prefix = `${EXPERIMENTAL_SETTINGS_PREFIX}.`;
  const sub: Record<string, unknown> = {};
  let hit = false;
  for (const [key, value] of Object.entries(merged)) {
    if (!key.startsWith(prefix)) continue;
    const leaf = key.slice(prefix.length);
    if (leaf === "") continue;
    sub[leaf] = value;
    hit = true;
  }
  return hit ? sub : undefined;
}

/** 门判定（默认关；详见本文件头注的键位与 fail-closed 语义）。 */
export function resolveExperimental(input: ExperimentalGateInput = {}): ExperimentalGate {
  const notices: string[] = [];
  const settings = input.settings ?? {};

  // ① 未知配置键告警（不静默丢弃；已知键=enabled/flags）
  for (const key of Object.keys(settings)) {
    if (key === "enabled" || key === "flags") continue;
    notices.push(
      `[experimental] 未知配置键 ${EXPERIMENTAL_SETTINGS_PREFIX}.${key} 已忽略（已知键：${EXPERIMENTAL_SETTINGS_KEY} / ${EXPERIMENTAL_FLAGS_SETTINGS_KEY}）`,
    );
  }

  // ② 总闸：env 逃逸舱 > settings > 缺省关
  const rawEnv = input.env?.[EXPERIMENTAL_ENV_KEY];
  const envSwitch = parseSwitch(rawEnv);
  if (rawEnv !== undefined && rawEnv.trim() !== "" && envSwitch === undefined) {
    return {
      enabled: false,
      flags: [],
      notices: [...notices, `[experimental] ${EXPERIMENTAL_ENV_KEY} 值非法（${rawEnv}）——实验特性不启用（fail-closed，不回退 settings）`],
    };
  }
  const rawEnabled = settings.enabled;
  const settingsEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
  if (settingsEnabled === undefined && rawEnabled !== undefined) {
    return {
      enabled: false,
      flags: [],
      notices: [...notices, `[experimental] settings ${EXPERIMENTAL_SETTINGS_KEY} 非布尔（${String(rawEnabled)}）——实验特性不启用（fail-closed）`],
    };
  }
  const enabled = envSwitch ?? settingsEnabled === true;

  // ③ 具名 flag 白名单：无论总闸开否都校验（非法配置静默失配即旁路）
  const rawFlags = settings.flags;
  let flags: ExperimentalFlag[] = enabled ? [...EXPERIMENTAL_FLAGS] : []; // 缺席=注册表全量随总闸
  if (rawFlags !== undefined) {
    if (!Array.isArray(rawFlags)) {
      notices.push(
        `[experimental] settings ${EXPERIMENTAL_FLAGS_SETTINGS_KEY} 非数组（${typeof rawFlags}）——不启用任何实验 flag（fail-closed）`,
      );
      flags = [];
    } else {
      const known = new Set<string>(EXPERIMENTAL_FLAGS);
      const picked: ExperimentalFlag[] = [];
      for (const item of rawFlags) {
        if (typeof item !== "string" || item.trim() === "") {
          notices.push(`[experimental] ${EXPERIMENTAL_FLAGS_SETTINGS_KEY} 条目非法（${safeJson(item)}）——已忽略该条`);
          continue;
        }
        const name = item.trim();
        if (!known.has(name)) {
          notices.push(
            `[experimental] 未知实验 flag 名 "${name}"——已忽略该条（已知：${EXPERIMENTAL_FLAGS.join(", ")}）`,
          );
          continue;
        }
        const flag = name as ExperimentalFlag;
        if (!picked.includes(flag)) picked.push(flag);
      }
      flags = enabled ? picked : []; // 总闸关=白名单不生效（零解锁面）
    }
  }

  return { enabled, flags: enabled ? flags : [], notices };
}

/** 告警文本里的条目回显（非 JSON 可序列化值回退 String——settings 值源自 JSON.parse，无循环引用）。 */
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}
