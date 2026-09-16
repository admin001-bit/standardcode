# StandardCode 仓库 Agent 指南

本文件承载本仓（`D:\projects\standardcode`）的仓库内部规则，适用对象为在本仓内工作的编码会话与贡献者。产品规格唯一来源是调研工作区的 `D:\StandardCode\StandardCode_v2.8.md`：本仓只消费其条目号与 DoD，不改写规格。本文件不复述工作区（`D:\StandardCode`）规则；工作区 `AGENTS.md` 不管理本仓内部行为。

## 仓库地图

- 本仓现状不在本文件复述（避免双份漂移）：进度与提交历史见 `git log --oneline` 与里程碑标签（`git tag`）；构建/测试命令以规则 1 指定的两处载体为准。
- 目录布局的规格基准 = 调研工作区 `D:\StandardCode\StandardCode_v2.8.md` §12.3；层归属与职责的规格基准 = 同文件 §5.2。
- `docs/` 承载自规格迁入的易变内容（迁移清单见 v2.8 §15）：`docs/adr/`（一决策一文件）、`docs/reference/`、`docs/dev/`、`docs/milestones/`（各里程碑 DoD 勾验表）。

## 仓库规则

1. **构建/测试命令承载**：构建与测试命令由本仓自身承载——以根 `package.json` scripts 与 `.github/workflows/ci.yml` 为唯一权威，任何文档（含本文件）不另存命令副本，改命令只改 scripts/CI。
2. **模块边界纪律**：层归属与职责不可变更（v2.8 §5.2，B-02）。模块清单与证据锚点的规格基准 = `D:\StandardCode\StandardCode_v2.8.md` §5.2；锚点工作副本 = `docs/dev/module-anchors.md`，与 §5.2 不一致时以 §5.2 为准并走勘误，不就地改规格。
3. **提交纪律** [自定]：每次会话收工必须 commit（执行协议 §6），不攒未提交变更；commit message 用 `exec(WP-xx):` / `verify(WP-xx):` / `fix:` / `docs:` / `chore:` 前缀 + 一句话；里程碑 G 门审通过后打 tag（如 `M0`）。
4. **工作区选择**（协议 `D:\StandardCode\plan\protocol.md` §3）：M0 各会话一律以 `D:\StandardCode` 为工作区（根 `AGENTS.md` 生效）；M1 起写代码的 X/V 会话以本仓为工作区（本文件生效），按绝对路径读 `D:\StandardCode\plan\` 下的卡与结果页。
