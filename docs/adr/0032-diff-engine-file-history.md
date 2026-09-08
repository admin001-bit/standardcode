# ADR-0032: diff 引擎选型 + file-history 快照设计（M2，v2.8 §13 行 13 处置 + §10 EXE-030/040/041）

- 状态：已接受（2026-09-08，M2-WP-09；**diff 选型为代选**——提请用户裁决未获应答，按推荐档"复用 git diff"先行，临时性结论，G 门审/用户可推翻后改自实现档）
- 规格处置：v2.8 §13 行 13（diff 引擎选型：git diff 复用 vs 自实现→M2 裁决）、§10 EXE-030/040/041（/rewind N 依赖 file-history 快照：每次工具写盘前快照入 file-history/；/diff）。

## 决策

1. **diff 引擎=复用系统 git**（`git diff HEAD` 全量未提交变更；可选参数透传 `git diff <args>`）。理由与 ADR-0029 同构：系统工具单来源+安装指引，零自研成本、输出与用户习惯一致。非 git 目录→错误三件套提示。失败档位（自实现/混合）不预建。
2. **file-history 布局**：`~/.standardcode/projects/<encoded>/file-history/` 下 `index.jsonl`（逐行 SnapshotRecord，schemaVersion=1，ENG-080；坏行容忍）+ `snap-<seq6>/` 内容存档。快照=**写盘前**全文件内容；文件不存在登记 `existed:false`（rewind=删除）。
3. **快照触发点**：harness 工具执行路径，全部门禁（guard/permission/schema）通过后、执行前（拒动的工具不产生快照）；Write/Edit 取 `file_path`，Bash 以重定向启发式（`>` `>>` `tee` `mv/cp/install` 目标）解析目标 [自定]——Bash 写盘面广，启发式外漏登记偏差，护栏与权限独立生效不受影响。
4. **/rewind N 语义**：撤销 seq≥N 的全部快照（后进先出）——恢复到**第 N 次写盘前**的项目状态；快照 N 的存档内容即该时点前态，故 N 含于撤销集。（`existed:false` 且无存档 → 删除新建文件。）【勘误 2026-09-08】初版边界误取 seq>N，使 /rewind maxSeq（撤销最近一步）必然 no-op——V 核验独立复现后当日修复。索引只追加不改写（历史保留）。**会话消息历史不随 rewind 截断**（M2 无 per-snapshot 消息检查点）——transcript 只读不破坏，会话级回退登记为后续里程碑缺口。
5. 快照失败（fs 异常）→ 工具调用合成 error tool_result（不静默继续：写盘无快照=不可回滚，宁可拒绝执行）。

## 影响的相邻机制

- `packages/platform/src/file-history.ts`（store+启发式）、`packages/harness/src/tools.ts`（beforeTool 钩子）、apps/cli /rewind /diff。
- §12.5 差异登记：Bash 启发式为自研（[CC] file-history 未覆盖 Bash 写盘的本地证据）；会话级回退缺口登记。

## 参考

- v2.8 §10 EXE-030/040/041 原文、§13 行 13、ENG-080；[CC] `_788.js`（file-history 快照锚点，§5.2 转引）。
