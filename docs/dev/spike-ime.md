# IME 中文输入 spike 记录（v2.8 §13 行 7 · M1 spike，Windows 原生验证）

> 来源卡：`D:\StandardCode\plan\T0-地基\M1-最小会话\M1-1-board.md` §WP-11。实测环境：Windows 11 26200 x64 原生、Node v24.14.0、活动代码页 936（GBK）、chcp 与 reg查询由 X 会话实跑（2026-09-07）。**未完成项**：交互式 TTY 下的 IME 组合窗行为（需真人键盘操作，见 §4 待办）。

## 1. spike 目标与结论

目标：验证「Node 原生 stdin 行模式读中文 + UTF-8 全链」在本机可行；识别 raw mode 路线的阻塞点。

**结论：行模式路线可行（M1 采用）；raw mode 路线存在两项本机实证发现，均非阻塞。**

## 2. 本机实测记录（自动项，2026-09-07）

| # | 实验 | 结果 | 判读 |
| :-- | :-- | :-- | :-- |
| ① | 管道注入 `printf '你好世界'` → Node 读 stdin | 4 码点原样（`你好世界` 字符完整） | Node stdin 以 UTF-8 解码多字节序列无损；**行模式读中文无阻塞** |
| ② | 同一输出的捕获侧显示 | 捕获层显示 `浣犲ソ涓栫晫`（UTF-8 字节被按 GBK 解读的典型错位） | 乱码产生于**下游捕获层代码页**，非 CLI 输出错误；纪律：**产品 CLI 强制 UTF-8 输出 + 终端侧代码页归一（chcp 65001）由安装器/文档承载** [自定] |
| ③ | `process.stdin.isTTY`（管道） | falsy | 非 TTY 无 `setRawMode`（`is not a function` 实证）→ 矩阵行模式分支的依据 |
| ④ | `chcp` | 活动代码页 936 | 中文 Windows 默认 GBK；佐证 ②，UTF-8 归一必须主动处理 |
| ⑤ | TTY 下 raw mode + IME 组合窗 | **未测（需真人交互）** | 见 §4 |

## 3. 设计含义

- **M1 输入路线 = Node readline 行模式**（UTF-8 解码已实证无损），不引入 raw-mode 输入框——避开 IME 组合窗与 raw mode 的全部兼容坑，与终端兼容矩阵（terminal-compat.md §2）非 TTY 分支一致。
- IME 组合窗在行模式由 **conhost/WT 终端层处理**（终端自己管候选窗，应用只见最终提交串）——这是行模式路线 IME 无忧的原因。
- raw mode 全屏输入框（[CC] 形态）与 IME 的兼容是后续全屏渲染器里程碑的设计输入：届时必须处理 WM_IME_* 消息窗或采用终端提交串协议（Windows Terminal 的 conpty 已托管 IME）。
- 输出侧：UTF-8 强制 + `chcp 65001` 归一建议写入安装/文档（发现②）。

## 4. 遗留待办（不阻塞 M1）

1. **TTY 交互式 IME 实测**：需真人在 conhost 与 Windows Terminal 各做一轮「拼音输入→候选→上屏→回车」，验证应用侧收到的最终串完整。建议用户开 M1-1 任一会话时顺手验证；表格留待补记。
2. conhost 下 Ctrl+C 中文输入态中断行为（同上，交互项）。
3. Windows Terminal conpty 对 DECSTBM/滚动区域的支持边界——随全屏渲染器里程碑再测。

## 5. 参考

- v2.8 §13 行 7（IME 中文输入 → M1 spike，Windows 原生验证）、§8.1 输入通道。
- dig-08 §2（A 级）：fullscreen/经典双渲染器与降级语义（本 spike 只涉输入侧，渲染侧待后续里程碑）。
