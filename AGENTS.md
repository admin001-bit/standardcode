# StandardCode 仓库 Agent 指南

本文件承载本仓（`D:\projects\standardcode`）的仓库内部规则，适用对象为在本仓内工作的编码会话与贡献者。产品规格唯一来源是调研工作区的 `D:\StandardCode\StandardCode_v2.8.md`：本仓只消费其条目号与 DoD，不改写规格。本文件不复述工作区（`D:\StandardCode`）规则；工作区 `AGENTS.md` 不管理本仓内部行为。

## 仓库地图

- 当前状态：M0 骨架期，无可构建工程。已有文件：`LICENSE`（Apache-2.0）、`README.md`（定位与版本策略）、`.gitattributes`（强制 LF）、`.editorconfig`、本文件。
- 规划布局（v2.8 §12.3，WP-04 落地）：`apps/cli`、`packages/{harness,context,capabilities,providers,platform}`、`crates/sandbox`、`evals`、`docs`。
- `docs/` 将承载自规格迁入的易变内容（WP-07，v2.8 §15 迁移表）：`docs/adr/`（一决策一文件）、`docs/reference/claude-code-baseline.md`、`docs/dev/module-anchors.md`、`docs/milestones/`、`docs/dev/seams.md`。

## 仓库规则

1. **构建/测试命令承载**：构建与测试命令由本仓自身承载——骨架落地后以根 `package.json` scripts 与 `.github/workflows/ci.yml` 为唯一权威，任何文档（含本文件）不另存命令副本，改命令只改 scripts/CI。WP-04 之前本仓不存在构建/测试命令，勿在本仓寻找或执行。
2. **模块边界纪律**：层归属与职责不可变更（v2.8 §5.2，B-02）。模块清单与证据锚点的规格基准 = `D:\StandardCode\StandardCode_v2.8.md` §5.2；锚点迁入本仓后（WP-07）以 `docs/dev/module-anchors.md` 为工作副本，与 §5.2 不一致时以 §5.2 为准并走勘误，不就地改规格。
3. **提交纪律** [自定]：每次会话收工必须 commit（执行协议 §6），不攒未提交变更；commit message 用 `exec(WP-xx):` / `verify(WP-xx):` / `fix:` / `docs:` / `chore:` 前缀 + 一句话；里程碑 G 门审通过后打 tag（如 `M0`）。
4. **工作区选择**（协议 `D:\StandardCode\plan\protocol.md` §3）：M0 各会话一律以 `D:\StandardCode` 为工作区（根 `AGENTS.md` 生效）；M1 起写代码的 X/V 会话以本仓为工作区（本文件生效），按绝对路径读 `D:\StandardCode\plan\` 下的卡与结果页。
