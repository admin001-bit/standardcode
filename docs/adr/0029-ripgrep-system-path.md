# ADR-0029: ripgrep 集成策略（M1，v2.8 §13 行 11 处置）

- 状态：已接受（2026-09-08，M1-WP-07；用户现场裁决）
- 规格处置：v2.8 §13 行 11（ripgrep 集成策略 → M1 裁决；[CC] USE_BUILTIN_RIPGREP 先例）。

## 决策（系统 PATH 单来源 + 安装指引）

1. **取"依赖用户安装"档**：运行时仅探测系统 PATH 的 `rg`（可用 `STANDARD_CODE_RIPGREP_PATH` 指向自定义可执行）；找不到时报错并附安装指引（winget/brew/apt，[CC] 同构文案）。
2. **不设嵌入档**：[CC] 嵌入模式的前提是 Bun 单文件二进制形态（`process.execPath` 自身即 rg 解释器，dig-03 §4 三来源之②）；StandardCode 为 Node 分发，无该形态。包体 +~10MB、平台分发与上游版本跟进、供应链面扩大，对 M1 冷启动预算与发布工程均为负收益。M5+ 发布工程（附录 E）落单文件分发形态时再评估内置档。
3. **env 开关（USE_BUILTIN_RIPGREP 同构位）不设**：决策 2 下内置档不存在，开关无意义；`STANDARD_CODE_RIPGREP_PATH` 已覆盖"自带 rg"场景。

## 子进程契约（[CC] dig-03 §4 实测锚点）

超时 20s（WSL 60s——M1 未实现 WSL 探测，登记偏差，统一 20s）；退出码 0=有结果 / 1=无结果（均成功）/ 2+ 带部分结果流式处理（M1 简化为报错）；正则/参数错误转专用异常并截 stderr 2000 字符；EAGAIN 自动单线程（-j 1）重试。

## 影响的相邻机制

- `packages/executor/src/grep.ts`：本 ADR 的实现落点。
- Grep 工具描述内嵌安装指引（`packages/capabilities`），模型在 rg 缺失场景可自引导。
- M5 发布工程：若启用内置档，本 ADR 状态改"已取代"并补分发矩阵。

## 参考

- v2.8 §13 行 11 原文、§5.2 executor 行。
- dig-03 §4（`_525.js` rg 三来源/超时/退出码/EAGAIN/指引文案，一手核验）。
