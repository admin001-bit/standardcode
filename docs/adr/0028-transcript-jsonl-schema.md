# ADR-0028: transcript JSONL schema（M1，v2.8 §13 行 2 处置）

- 状态：已接受（2026-09-08，M1-WP-06）
- 规格处置：v2.8 §13 行 2（transcript JSONL schema → M1 设计，**实现阻塞级**）；§2 行 M2（落盘路径 `~/.standardcode/projects/<encoded>/transcripts/`）；§12.2 E2E ③（JSONL 可 resume）。

## 决策（schema v1，NDJSON：一事件一行 JSON）

1. **记录形状** `{schemaVersion:1, seq, ts, kind, message?, phase?, reason?, usage?}`：
   - `kind ∈ {user_message, assistant_message, interrupt, done}`；消息以 L5 事件 IR 形状**原样**落盘（ContentBlock 不转协议方言——resume 重建即消息历史，isMeta 注入不落盘）。
   - `seq` 会话内从 1 单调递增；`ts` ISO 8601；`done` 记录携带终态 `reason`（DoneReason）与会话累计 `usage`（ADR-0027 四列）。
2. **路径编码 [自定]**：`<encoded>`=项目绝对路径折叠——`/`、`\`、`:` 与其余非 `[A-Za-z0-9._-]` 字符统一 → `-`（Windows 文件名合法、无歧义；合法字符集不含 `-` 折叠歧义源——`-` 本身是合法字符，但不同路径折叠后同名的概率仅存在于含空格/中文等非安全字符的场景，M1 接受此权衡；将来若需可逆再启用 hex 转义）。
3. **崩溃容忍**：逐行解析，坏行/半截行（进程死在写一半）跳过并计数（`skippedMalformed`），不阻断恢复——E2E ③ 依赖。
4. **恢复语义（M1）**：`resumeFrom()` 读回+重建消息历史+返回终态 reason——程序化恢复；/resume UI 命令 M2（卡边界）。
5. **追加纪律**：正常运行只 appendFile；覆盖式重建仅测试/迁移用（`overwriteTranscript`）。

## 影响的相邻机制

- WP-02 主循环：done/interrupt 事件 → 转录 done/interrupt 记录（接线随 WP-13 E2E③）；V 复验偏差⑥（abort×畸形孤儿 tool_result 终态）在本卡一并修复——终态消费者即本模块。
- M2 多开加锁（§13 行 9）：本 ADR 不含锁，M2 设计。

## 参考

- v2.8 §13 行 2/行 9、§2 行 M2 路径原文、§12.2 E2E 行。
- [CC] `_788.js` file-history 快照（§5.2 锚点，形态参照）。
