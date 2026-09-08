# ADR-0033: symlink 策略（M2，v2.8 §13 行 14 处置）

- 状态：已接受（2026-09-08，M2-WP-12）
- 规格处置：v2.8 §13 行 14（symlink 策略：权限/记忆/规则路径的 symlink 处理→M2 设计）；§11 S-7（提权逃逸：symlink 拒绝，Codex 测试范本）；§8.3 信任模型细则（`.standardcode` 为符号链接时视为仓库提供、需信任）。

## 决策（按路径消费面分级；锚点=Codex `normalize_writable_root_for_sandbox` 双档策略，A 级报告 :441-474）

1. **权限/护栏路径（写授权面）=严格档**：路径解析中对 symlink 组件的处理取 Codex 同构——顶层系统别名（如 `/tmp → /private/tmp`、Windows 的 `%TEMP%` 别名）可解析；**深层 symlink 组件一律拒绝**（Codex :444-450 理由：运行中的沙箱进程可篡改深层组件，跟随=把路径检查变成新的授权授予）。Bash 工具输入与 guard-path 元数据/高危判定先 lstat 逐组件探测。落地挂点：WP-07 规则清洗补齐时实现（权限面）；M1 guard-path 跑偏清单"symlink 拒绝未实现"由此闭环。
2. **记忆/规则路径（读注入面）=lstat+ realpath 归一档**：CLAUDE.md/AGENTS.md/rules/@import 目标先 realpath 归一再判定归属（isInside cwd / home）；归一后逃出 cwd 的 @import 走既有"外部 import 需批准"流（WP-02）。**只读不跟随高危区**：归一结果落 `C:\Windows` 等高危清单或元数据目录（.standardcode/.git）→ 拒绝读入（与 guard-path 清单对齐）。
3. **`.standardcode` 本身为 symlink**：按 §8.3 细则视为"仓库提供"，触发信任对话框（WP-07），不经 realpath 静默放行。
4. **测试范本**：契约层"symlink 拒绝"用例（§12.2 契约行 Codex 范本）随 WP-07 权限面实现落库。

## 影响的相邻机制

- WP-07（权限/规则清洗=严格档实现位）、WP-02（memory-loader realpath 归一=读档实现位，@import 已有外部批准流）、M1 guard-path 跑偏清单闭环、§12.5 差异登记（Codex 双档策略的自研分级映射）。

## 参考

- v2.8 §13 行 14、§11 S-7、§8.3 信任细则；A 级《调研报告_Codex沙箱与OpenCode-Provider.md》"符号链接处理"节（锚点为该报告所引 Codex 源码行号 :441-474、:407-454；报告物理位置 :217-226）。
