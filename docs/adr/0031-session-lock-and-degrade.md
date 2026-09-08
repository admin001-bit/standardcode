# ADR-0031: 多开并发写加锁与转录降级（M2，v2.8 §13 行 9/行 10 处置）

- 状态：已接受（2026-09-08，M2-WP-08）
- 规格处置：v2.8 §13 行 9（多开并发写：同项目多会话的 transcript/checkpoint 加锁→M2 设计）、行 10（统一降级矩阵的落盘路径切片）、§11 S-10（转录敏感面对策）。

## 决策

1. **加锁=O_EXCL 锁文件 + 陈旧抢占**：`~/.standardcode/projects/<encoded>/transcripts/<sessionId>.lock`（内容 `pid=...\nts=...`）。`wx` 独占创建失败→读内容判陈旧（ts 超 30s 且 pid 非本进程）→抢占重写；否则报"另一会话持有"。checkpoint/file-history 加锁同构（WP-09 接入）。
2. **陈旧阈值 30s**：持锁进程崩溃残留的自愈窗口 [自定]；不引入原生文件锁依赖（flock/LockFile 跨平台成本高、收益低——Node 无内置排他锁原语）。
3. **磁盘满降级（§13 行 10 落盘切片）**：append 遇 ENOSPC/EDQUOT → 不抛、置 degraded、后续记录入内存缓冲（seq 近似，恢复以内容为准），会话继续；缺口由 /doctor 提示（WP-11）。网络闪断/权限拒绝两面的统一处理表随 WP-12 矩阵登记。
4. **S-10 Windows 权限收紧偏差**：0600 语义在 Windows 无对应 chmod（仅只读位）；转录目录已位于用户 Profile（默认 ACL 已隔离其他用户），chmod 失败按 no-op 处理并登记偏差；POSIX 侧 chmod 0600 生效。

## 影响的相邻机制

- `packages/platform/src/session-store.ts`：SessionLock / ResilientTranscriptWriter / listSessions（/resume 数据源，WP-10 消费）。
- WP-12 统一降级矩阵（行 10 全表）：本 ADR 为落盘路径切片，矩阵给出三面统一表后如有出入以矩阵修订为准。

## 参考

- v2.8 §13 行 9/10、§11 S-10、§12.4 ENG-080；[CC] `_788.js`（形态参照）。
