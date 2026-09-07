# Transcript JSONL Schema v1（字段级定义 · ADR-0028）

> 来源卡：`D:\StandardCode\plan\T0-地基\M1-最小会话\M1-1-board.md` §WP-06（v2.8 §13 行 2，实现阻塞级）。本文为字段级规范；决策与理由见 `docs/adr/0028-transcript-jsonl-schema.md`。

## 文件

- 位置：`~/.standardcode/projects/<encoded>/transcripts/<sessionId>.jsonl`
- 格式：NDJSON——每行一个 JSON 对象，UTF-8，行尾 `\n`；空行忽略。
- `<encoded>`：项目绝对路径折叠（`/` `\` `:` → `-`，其余非安全字符 → `x<hex>`；例 `D:\projects\standardcode` → `D--projects-standardcode`… 实际由 `encodeProjectPath` 计算）。

## 记录（TranscriptRecord）

| 字段 | 类型 | 必在 | 说明 |
| :-- | :-- | :-- | :-- |
| `schemaVersion` | `1` | ✓ | schema 版本，读回校验用 |
| `seq` | number | ✓ | 会话内从 1 单调递增 |
| `ts` | string | ✓ | ISO 8601 UTC |
| `kind` | enum | ✓ | `user_message` \| `assistant_message` \| `interrupt` \| `done` |
| `message` | LLMMessage | kind=*_message | L5 事件 IR 形状（ContentBlock 原样：text/tool_use/tool_result/thinking） |
| `phase` | `"stream"` \| `"tool"` | kind=interrupt | 中断发生阶段 |
| `reason` | DoneReason | kind=done | `end/max_turns/interrupted/context_exhausted/truncated_gave_up/malformed_fail_closed/filtered/error` |
| `usage` | TokenUsage | kind=done | 会话累计四列（ADR-0027）：input/output/cache_creation/cache_read |

## 语义

1. 消息记录 = 主循环 `state.messages` 的逐条投影（user_message 与 assistant_message 各一行，push 时序即 seq 时序）。
2. isMeta 动态注入**不落盘**（非会话内容；恢复时无需剥离）。
3. 崩溃容忍：半截尾行（进程死在 write 中途）读回时跳过计数，不阻断 resume。
4. 追加纪律：正常运行只 appendFile；多开加锁 M2（§13 行 9）。

## 恢复（M1 程序化 resume）

`resumeFrom(file)` → `{ messages, lastReason, skippedMalformed }`；`/resume` UI 命令 M2（卡边界）。
