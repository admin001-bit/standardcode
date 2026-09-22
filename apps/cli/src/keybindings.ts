// M7-WP-04：终端键位表单源（接缝㉔：色/键位表收敛 cli-terminal 单源；本仓无 cli-terminal 包，
// L0 内聚于 apps/cli，与 WP-03 的 theme.ts 同族同层，登记于结果页/ADR-0030）。
//
// 边界（卡面）：**只绑已有动作、不新增动作语义**；**不做多键序（chord）**——单个非修饰键 + 若干修饰键；
// 终端兼容矩阵维持 M1 既有裁决（v2.8 §13 行 532）：键位解析只认 Node readline keypress 的 name/修饰位。
//
// 单源导出（纯函数供测试判别）：
//   BINDABLE_ACTIONS                 —— 可绑动作全集（只含既有动作；集合相等可断言）
//   DEFAULT_KEYBINDINGS              —— 缺省键位表（shift+tab = 权限循环，承 EXE-001 既有硬键位）
//   parseKeySpec(raw)                —— 键位串 → KeySpec；非法/chord/未知键名 = fail-closed 抛错
//   resolveKeybindings(raw)          —— settings 映射 → 完整键位表（缺项补缺省；冲突/非法 = fail-closed）
//   keybindingsFromSettings(loaded)  —— 由会话 settings 装配解析（重启恢复入口，可断言）
//   matchKeyEvent(spec, key)         —— keypress 事件是否命中该键位
//   getKeybindings / setKeybindings  —— 进程内当前键位（main.ts 键事件面单源消费点）
import { settingsValue, type LoadedSettings } from "@standardcode/platform";

/** 可绑动作（只含既有动作——卡边界"不新增动作语义"；新增动作须先有能力面）。 */
export type BindableAction = "permission.cycle";

/** 可绑动作全集（集合相等可断言）。 */
export const BINDABLE_ACTIONS: readonly BindableAction[] = ["permission.cycle"] as const;

/** 缺省键位表：承既有硬键位 EXE-001（main.ts 原内联 shift+tab → 权限循环），此处升为单源。 */
export const DEFAULT_KEYBINDINGS: Readonly<Record<BindableAction, string>> = Object.freeze({
  "permission.cycle": "shift+tab",
});

/**
 * 保留键（不可绑定）：`ctrl+c` 属 readline 的 SIGINT 面（中断流／空闲提示，main.ts `rl.on("SIGINT")`），
 * 不在 keypress 键位表内——抢绑会破坏终端兼容矩阵（v2.8 §13 行 532 既有裁决），故显式列为保留并 fail-closed 拒绝。
 */
export const RESERVED_KEY_SPECS: readonly string[] = Object.freeze(["ctrl+c"]);

/** 修饰键集合（顺序无关；重复出现=非法）。 */
const MODIFIERS = new Set(["shift", "ctrl", "alt", "meta"]);

/** 合法键名（Node readline keypress 的 key.name 域 + 单可打印字符）。 */
const KEY_NAMES = new Set([
  "tab", "enter", "return", "escape", "space", "backspace", "delete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
]);

/** 解析后的键位（匹配用；与 readline keypress 的 key 对象同形）。 */
export interface KeySpec {
  name: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

function isPrintableSingle(name: string): boolean {
  return /^[a-z0-9]$/.test(name);
}

/**
 * 键位串 → KeySpec。
 * fail-closed（不静默回落缺省）：空串／含空白（chord 形）／多个非修饰段（=chord，卡边界不做）／
 * 重复修饰键／未知键名 —— 一律抛错。
 */
export function parseKeySpec(raw: string): KeySpec {
  const s = raw.trim().toLowerCase();
  if (s === "") throw new Error(`invalid key spec: "" (empty)`);
  if (/\s/.test(s)) throw new Error(`invalid key spec: "${raw}" (chord sequences are not supported)`);
  const parts = s.split("+").filter((p) => p !== "");
  if (parts.length === 0) throw new Error(`invalid key spec: "${raw}"`);
  const mods = new Set<string>();
  let name: string | undefined;
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      if (mods.has(p)) throw new Error(`invalid key spec: "${raw}" (duplicate modifier "${p}")`);
      mods.add(p);
      continue;
    }
    if (name !== undefined) throw new Error(`invalid key spec: "${raw}" (chord sequences are not supported)`);
    name = p;
  }
  if (name === undefined) throw new Error(`invalid key spec: "${raw}" (missing key name)`);
  if (!KEY_NAMES.has(name) && !isPrintableSingle(name)) {
    throw new Error(`invalid key spec: "${raw}" (unknown key name "${name}")`);
  }
  return {
    name,
    shift: mods.has("shift"),
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    meta: mods.has("meta"),
  };
}

/** readline keypress 的 key 入参形（只取本模块需要的四个修饰位）。 */
export interface KeyEventLike {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** keypress 事件是否命中该键位（缺省位按 false 处理；未命名事件恒不命中）。 */
export function matchKeyEvent(spec: KeySpec, key: KeyEventLike): boolean {
  if (key.name === undefined) return false;
  return (
    key.name.toLowerCase() === spec.name &&
    (key.shift ?? false) === spec.shift &&
    (key.ctrl ?? false) === spec.ctrl &&
    (key.alt ?? false) === spec.alt &&
    (key.meta ?? false) === spec.meta
  );
}

/**
 * settings 映射 → 完整键位表（缺项补缺省）。
 * fail-closed：未知动作名／非法键位串／**同一键绑到两个动作（冲突）** —— 一律抛错，不静默回落。
 */
export function resolveKeybindings(raw: Readonly<Record<string, unknown>>): Record<BindableAction, KeySpec> {
  const out = {} as Record<BindableAction, KeySpec>;
  const taken = new Map<string, BindableAction>(); // 归一化键位串 → 动作（冲突检测）
  for (const action of BINDABLE_ACTIONS) {
    const specRaw = raw[action];
    if (specRaw === undefined) {
      out[action] = parseKeySpec(DEFAULT_KEYBINDINGS[action]);
      continue;
    }
    if (typeof specRaw !== "string") throw new Error(`invalid keybinding for "${action}": expected a string`);
    const spec = parseKeySpec(specRaw);
    const norm = normalizeSpec(spec);
    if (RESERVED_KEY_SPECS.includes(norm)) {
      throw new Error(`keybinding conflict: "${norm}" is reserved (ctrl+c = interrupt; not rebindable)`);
    }
    const owner = taken.get(norm);
    if (owner !== undefined && owner !== action) {
      throw new Error(`keybinding conflict: "${norm}" is already bound to "${owner}"`);
    }
    taken.set(norm, action);
    out[action] = spec;
  }
  return out;
}

/** 键位归一化串（展示与冲突判等共用；修饰键按固定序）。 */
export function normalizeSpec(spec: KeySpec): string {
  const mods: string[] = [];
  if (spec.ctrl) mods.push("ctrl");
  if (spec.alt) mods.push("alt");
  if (spec.shift) mods.push("shift");
  if (spec.meta) mods.push("meta");
  return [...mods, spec.name].join("+");
}

/**
 * 某动作在 settings 中的键（点路径）：`ui.keybindings.<action>`。
 * 形制说明：本仓 settings 装配会把嵌套对象**展开为点路径叶子**（实测 `{ui:{keybindings:{...}}}` →
 * `ui.keybindings.permission.cycle`），取不到"对象值"，故键位表按**每动作一个点路径键**落盘/读取
 * （与 `ui.theme` 标量同形），冲突检测在读全表后统一判定。
 */
export function settingsKeyFor(action: BindableAction | string): string {
  return `ui.keybindings.${action}`;
}

/**
 * 由会话 settings 装配解析键位（重启恢复入口，可断言）：逐动作读 `ui.keybindings.<action>`。
 * 未知动作键（settings 里出现未登记动作）**宽容忽略**——settings 是外部可改面，多余键不应瘫痪启动；
 * 但**已知动作的非法键位/保留键/跨动作冲突**=fail-closed 抛错（安全语义不静默回落）。
 */
export function keybindingsFromSettings(loaded: LoadedSettings): Record<BindableAction, KeySpec> {
  const raw: Record<string, unknown> = {};
  for (const action of BINDABLE_ACTIONS) {
    const v = settingsValue<string>(loaded, settingsKeyFor(action));
    if (v !== undefined) raw[action] = v;
  }
  return resolveKeybindings(raw);
}

let current: Record<BindableAction, KeySpec> = resolveKeybindings({});

/** 读当前键位（main.ts 键事件面单源消费点）。 */
export function getKeybindings(): Record<BindableAction, KeySpec> {
  return current;
}

/** 设当前键位（/keybindings 切换或每 turn 由 settings 重装配时调用）。 */
export function setKeybindings(next: Record<BindableAction, KeySpec>): void {
  current = next;
}

/**
 * 重绑定（命令面用）：在「当前键位」基础上改一个动作。
 * fail-closed：非法动作／非法键位串／目标键已被其它动作占用（冲突）→ 抛错且不改动当前表。
 */
export function rebind(action: string, specRaw: string): Record<BindableAction, KeySpec> {
  if (!BINDABLE_ACTIONS.includes(action as BindableAction)) {
    throw new Error(`invalid keybinding action: "${action}" (expected one of: ${BINDABLE_ACTIONS.join(", ")})`);
  }
  const spec = parseKeySpec(specRaw);
  const norm = normalizeSpec(spec);
  if (RESERVED_KEY_SPECS.includes(norm)) {
    throw new Error(`keybinding conflict: "${norm}" is reserved (ctrl+c = interrupt; not rebindable)`);
  }
  for (const other of BINDABLE_ACTIONS) {
    if (other === action) continue;
    if (normalizeSpec(current[other]) === norm) {
      throw new Error(`keybinding conflict: "${norm}" is already bound to "${other}"`);
    }
  }
  const next = { ...current, [action as BindableAction]: spec };
  setKeybindings(next);
  return next;
}
