// M7-WP-03：终端渲染主题单源（明/暗/色板）。
// 缺省主题 = plain（零 ANSI），保证既有输出与既有测试零改动；light/dark 才对状态标记着色。
// 所有 ANSI 颜色字面量仅许出现在本文件（接缝㉔：色/键位表收敛 cli-terminal 单源；
// 本仓无 cli-terminal 包，L0 内聚于 apps/cli，登记于结果页/ADR）。
//
// 单源导出（纯函数供测试判别）：
//   THEMES                  —— 主题全集（集合相等可断言；新增主题须同步 THEMES 与 PALETTE）
//   themeTokens(theme)      —— 状态标记 → ANSI 码（plain = 空串映射，即无着色）
//   resolveTheme(raw)       —— 字符串 → Theme；非法/未知值 = fail-closed 抛错（不静默回落缺省）
//   colorize(token, text)  —— 按「当前主题」着色；plain 原样返回
//   themeFromSettings(loaded) —— 由会话 settings 装配解析当前主题（重启恢复入口，可断言）
//
// 设计注：colorize 不收 theme 形参，而读模块级「当前主题」，因为渲染面每进程恰一个活动主题、
// 且 CLI 单线程 turn 循环内 setTheme 即时生效；测试可显式 setTheme 后判别纯形态（plain 恒原样返回）。
import { settingsValue, type LoadedSettings } from "@standardcode/platform";

/** 主题全集（相等可断言；dark/light 为非缺省着色主题，plain 为缺省零 ANSI）。 */
export type Theme = "plain" | "light" | "dark";

/** 主题全集（枚举相等断言——新增主题须同步本数组与 PALETTE）。 */
export const THEMES: readonly Theme[] = ["plain", "light", "dark"] as const;

/** 渲染面允许着色的状态标记 token（接缝㉔：仅这些点可着色，其它一律裸文本）。 */
export type ThemeToken = "tool" | "ok" | "err" | "recovery" | "interrupted" | "done";

// ANSI 调色板（仅 light/dark 使用；plain 恒空）。集中单源——禁止在别处重复裸 ANSI 颜色字面量。
const PALETTE: Record<"light" | "dark", Record<ThemeToken, string>> = {
  dark: {
    tool: "\x1b[36m", // cyan  —— [tool]
    ok: "\x1b[32m", // green —— ✓
    err: "\x1b[31m", // red   —— ✗
    recovery: "\x1b[33m", // yellow —— [recovery]
    interrupted: "\x1b[35m", // magenta —— [interrupted]
    done: "\x1b[90m", // bright black —— [done]
  },
  light: {
    tool: "\x1b[36m",
    ok: "\x1b[32m",
    err: "\x1b[31m",
    recovery: "\x1b[33m",
    interrupted: "\x1b[35m",
    done: "\x1b[90m",
  },
};

const RESET = "\x1b[0m";

let currentTheme: Theme = "plain";

/** 读当前活动主题（渲染面单源）。 */
export function getTheme(): Theme {
  return currentTheme;
}

/** 设当前活动主题（/theme 切换或每 turn 由 settings 重装配时调用）。 */
export function setTheme(theme: Theme): void {
  currentTheme = theme;
}

/** plain → 全空串映射（状态标记无着色）；light/dark → ANSI 码。 */
export function themeTokens(theme: Theme): Record<ThemeToken, string> {
  if (theme === "plain") {
    return { tool: "", ok: "", err: "", recovery: "", interrupted: "", done: "" };
  }
  return { ...PALETTE[theme] };
}

/** 字符串 → Theme；非法/未知值 = fail-closed（不静默回落缺省）。 */
export function resolveTheme(raw: string): Theme {
  if (raw === "plain" || raw === "light" || raw === "dark") return raw;
  throw new Error(`invalid theme: "${raw}" (expected one of: ${THEMES.join(", ")})`);
}

/** 按当前主题着色；plain 原样返回（零 ANSI）。 */
export function colorize(token: ThemeToken, text: string): string {
  if (currentTheme === "plain") return text;
  const code = PALETTE[currentTheme][token];
  return `${code}${text}${RESET}`;
}

/**
 * 由会话 settings 装配解析当前主题（重启恢复入口，可断言）：
 * 缺省 = plain；ui.theme 存在但非法 = fail-closed 抛错（坏设置不静默回落缺省）。
 */
export function themeFromSettings(loaded: LoadedSettings): Theme {
  const raw = settingsValue<string>(loaded, "ui.theme");
  if (raw === undefined) return "plain";
  return resolveTheme(raw);
}
