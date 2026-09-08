# ADR-0034: 统一降级矩阵（M2，v2.8 §13 行 10 处置）

- 状态：已接受（2026-09-08，M2-WP-12）
- 规格处置：v2.8 §13 行 10（统一降级矩阵：磁盘满/网络闪断/权限拒绝的统一处理→M2 设计）；§12.2 ENG-070~072（错误三件套）；B-12（故障边界有兜底清单）。落盘路径切片已由 ADR-0031 决策 3 先行（ENOSPC/EDQUOT→内存缓冲+会话继续），本 ADR 给三面统一表。

## 决策（统一三轴：①会话存续优先 ②协议不留悬空 ③错误三件套）

| 面 | 判定 | 处理 | 会话存续 | 悬空面防护 | 状态 |
|---|---|---|---|---|---|
| 磁盘满 | 写盘 ENOSPC/EDQUOT | 落盘类写降级内存缓冲+degraded 登记（ADR-0031）；/doctor 提示清理（WP-11） | 继续 | transcript 缺口可观测；file-history 快照失败→工具拒执行（ADR-0032 决策 5） | transcript/file-history 已实现 |
| 网络闪断 | fetch 失败/流中断 | L5 重试层分类（retryable 判定+退避）；恢复链④无 finish→续写预算；工具执行中 abort→合成 error tool_result（§8.4 硬不变量） | 继续（重试后仍败→交还用户） | 悬空 tool_use 由 harness 不变量兜底（M1 WP-02） | providers/harness 已实现（M1） |
| 权限拒绝 | evaluate=deny / ask 未批 | deny 恒赢 fail-closed（B-13）；ask 无 UI→拒绝（M1 语义，M2 WP-07 确认 UI 解除）；护栏 stop 恒先于权限 | 继续 | 工具不执行即无悬空 | 已实现（M1 WP-08；WP-07 补确认流） |

**统一原则**：
1. **降级不降安全**——安全相关通道（快照、护栏、权限）缺依赖即拒绝执行（fail-closed），数据通道（transcript）可降级继续（fail-open 限单文件，ADR-0030 决策 4 同构）。
2. **一切降级可观测**——degraded 标志/告警/遥测事件（ENG-090），禁止静默吞错。
3. **用户可恢复**——每面给出建议动作（错误三件套：发生了什么/为什么/建议）。

## 影响的相邻机制

- ADR-0031（落盘切片）、WP-07（确认 UI 解除 ask=拒绝）、WP-11（/doctor 清理提示）、ENG-090 遥测事件（auto_compact_circuit_breaker 等随 M3+）。

## 参考

- v2.8 §13 行 10、§8.4 中断不变量、B-12/B-13；M1 既有实现（providers retry/harness 中断合成/permission-broker）为表内"已实现"行的实证。
