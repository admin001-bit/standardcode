# ADR-0048: /release-notes 数据源约定=仓根 CHANGELOG.md（M7-1 板 WP-08 交付物；[自定] 登记）

- 状态：已接受（2026-09-23，X 会话按卡内定并登记；§8.2 行 365 M7 分期含 `/release-notes`）

## 背景

- §8.2 行 365 只列命令名 `/release-notes`，未定数据源与展示形制（规格空白面）。M7-1 板 WP-08 卡参考资料栏授权"evidence 检索 [CC] 锚；缺→mini-ADR [自定]"，边界栏定"**只读展示**；数据源文件缺省=**明报不静默**"。
- evidence 检索（2026-09-23，只读）得 [CC] 锚：`evidence/claude-src-extracted/_440.js:278632`（命令定义 `{name:"release-notes", description:"View release notes", type:"local-jsx"}`）、`_704.js:11`（分类 `"release-notes":"info"`=只读信息面）；`evidence/harness参考项目/claude-code/CHANGELOG.md:5723`「New /release-notes command…」、`:3020`「now an interactive version picker」（版本选择面）、`:863`（只读边界：查看行为**不得**写入模型上下文）。**有锚，故本 ADR 不解语义空白，只落 [CC] 锚外的数据源 [自定]。**
- 仓内现状：无 `CHANGELOG.md`；`docs/release.md`=发布门禁文档（ADR-0044 通道集）、`docs/milestones/*.md`=里程碑文档——皆非"变更记录"语义。版本单源=`apps/cli/src/version.ts` 的 `CLI_VERSION`。

## 决策

1. **数据源=项目根 `CHANGELOG.md`**（`join(session.cwd, CHANGELOG.md)`）。**读法**：`## <version>` 形节头（`v` 前缀可选；`###` 不算节头）＋节头下每非空行即该版本条目；一级标题等节外内容忽略。解析=纯函数 `apps/cli/src/release-notes.ts`。
2. **语义**：无参=展示当前版本（`CLI_VERSION` 单源）＋其条目＋更早版本名列表（"自上次版本以来的变更记录"以当前版本节承载）；带参 `/<version>`=按版本号选节（**精确命中优先，其次唯一前缀命中**；命中 0 或多=未命中）。
3. **缺省明报**：数据源文件缺省 → 输出约定说明（读哪个文件、`## <version>`/`- ` 维护法）＋**退出正常不抛异常**；版本未命中 → 明报"未找到＋可用列表"。**任一分支都不得静默返回空**。
4. **[CC] 差异登记**：[CC] 数据源=远端拉取（可被 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 关）；本仓取**仓内文件**（网络请求不属本卡边界），版本选择由带参直接给定（非 TUI picker，TUI 归渲染面）。

## 理由

- **仓内自足**：数据源即仓内事实，评审/离线可复现；与"数据源=仓内 CHANGELOG/里程碑文档"（卡目标详述）一致。
- **只读零副作用**：仅 `existsSync`/`readFile`，不写盘、不触网、不改版本；[CC] `:863` 锚的教训（查看不得注入模型上下文）在本实现为"输出经 `ctx.write` 上屏，不进会话消息"。
- **不臆造**：输出即数据源既有文本；仓内确无 `CHANGELOG.md` 时属"数据源缺省"面（明报），**不新建含编造内容的文件**。

## 边界

- 只做只读展示；**不做版本升降级动作**（更新走 `/update` 既有面，卡边界）。
- 不写任何文件、不发网络请求、不改 settings；不新增 settings 键（故不登记 ADR-0030）。
- 不触 M5/M6 冻结面；不改 `/theme` `/keybindings` `/sandbox` `/update` 既有语义。

## 参考

- v2.8 §8.2 行 365；M7-1 板 WP-08 卡；`apps/cli/src/release-notes.ts`（读法头注＋解析实现）、`apps/cli/src/repl.ts`（handler）、`apps/cli/src/commands.ts`（注册面）、`packages/platform/src/i18n.ts`（双包文案键）。
- 外部锚（[CC]，2026-09-23 检索）：`evidence/claude-src-extracted/_440.js:278632`、`_704.js:11`；`evidence/harness参考项目/claude-code/CHANGELOG.md:863/3020/5723`。
- ADR-0044（发布通道/版本通道）、ADR-0030（settings 键合并——本卡不新增键）。
