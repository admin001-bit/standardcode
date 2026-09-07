# 终端兼容矩阵与降级策略（v2.8 §13 行 6 · M1 设计）

> 来源卡：`D:\StandardCode\plan\T0-地基\M1-最小会话\M1-1-board.md` §WP-11。规格处置：v2.8 §13 行 6（终端兼容矩阵 → M1 设计，dig-08 fullscreen 熔断为参照）。
> 本文件定义**检测信号与降级策略**；熔断机制的实现随渲染层里程碑，实现时语义以本文件+dig-08 §2 为准。

## 1. 检测信号（启动时一次性检测，会话内缓存）

| 信号 | 判定 |
| :-- | :-- |
| `process.env.WT_SESSION` 有值 | Windows Terminal（全量 VT + IME 由终端层组窗） |
| `process.env.SESSIONNAME` 有值且非 WT_SESSION | Windows 传统 conhost 家族 |
| `process.env.TERM_PROGRAM === "iTerm.app"` | macOS iTerm2 |
| `process.env.TMUX` 有值 | tmux 会话内 |
| `process.env.SSH_CONNECTION` 有值 | 远程 ssh 登录 |
| `process.stdin.isTTY` 为 falsy | 非 TTY（管道/重定向/CI）→ 行模式 |
| `process.env.CI` 有值 | CI 环境（同非 TTY，另禁交互确认） |
| `process.env.NO_COLOR` 有值 | 禁 ANSI 颜色（https://no-color.org 约定） |
| 屏读环境 | [CC] `sr_auto_off` 同构信号（M1 未接屏读 API，预留） |

## 2. 降级矩阵

| 环境 | raw mode | ANSI/VT | IME 组合窗处理方 | 降级策略 |
| :-- | :-- | :-- | :-- | :-- |
| Windows Terminal | ✓ | 全量 | 终端层（提交后送 UTF-8 序列） | 全量体验 |
| conhost（Win10+） | ✓ | 基础（需 ENABLE_VIRTUAL_TERMINAL_PROCESSING；Node 默认已启用 stdout VT） | 终端层，但候选窗渲染与 raw mode 有历史兼容坑 | 经典渲染；避免 DECSTBM 等高级序列；**spike-ime 专项验证** |
| iTerm2 | ✓ | 全量 | 终端层 | 全量体验 |
| tmux | ✓ | 受限（passthrough 需 DCS 包装） | 终端层 | [CC] `tmux_cc_auto_off` 同构：默认经典渲染器 [自定：M1 无全屏，策略预留] |
| ssh（含 Windows→Linux） | ✓（远端 TTY） | 取决于对端 | 对端终端层 | [CC] `win_ssh_auto_off` 同构：Windows 主机经 ssh → 经典渲染器 [自定：M1 策略预留] |
| 非 TTY / 管道 / CI | ✗（实测：`setRawMode is not a function`） | 视 NO_COLOR/isTTY | 不适用（无交互） | 行模式读入；无交互确认；输出仍 UTF-8 |
| 屏读 | ✓ | 减少重绘 | 终端层 | [CC] `sr_auto_off` 同构：经典渲染、避免闪烁重绘 [自定：M1 策略预留] |

## 3. 全屏渲染器熔断语义（实现随渲染层里程碑；语义照 dig-08 §2，勿抄反）

- 金丝雀健康确认窗 **10s**；渲染器死亡计入 strike。
- **单 strike ≠ 熔断**：1 次死亡 → 下一启动 `crash_auto_off` 走经典渲染器；**连续第 2 次**才写 sticky `fullscreenAutoDisabled` 熔断。
- 逃生门：设置项开关 + 环境变量强制（[CC] `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` / `NO_FLICKER` 同构位，命名见 §13 settings 键位全集 M2 设计）。
- 残留清理：熔断标记带时效（[CC] 30 天残留清理同构）。

## 4. M1 落地边界

M1 CLI 为行式输入输出，无全屏渲染器——本里程碑只落地：①第 1 节检测信号模块（`apps/cli` 内，L0）②非 TTY 行模式降级（已实测必要）③UTF-8 输出纪律（见 spike-ime 发现②）。第 2 节其余降级与第 3 节熔断随全屏渲染器里程碑实现。

## 5. 参考

- dig-08 §2（A 级）：`reports\A-一手核验\claude-src-考古系列\dig-08` ——fullscreen 金丝雀熔断、渲染器选择开关全集（`bg_forced_on`/`sr_auto_off`/`crash_auto_off`/`tmux_cc_auto_off`/`win_ssh_auto_off` 等，[CC] `_625.js` 亲测）。
- v2.8 §13 行 6、§8.1（输入通道）、DP-3（可复现>智能：降级默认安全）。
- 本机实测数据：同目录 `spike-ime.md` §2。
