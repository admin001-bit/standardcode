# ADR-0053: `/update` 接 GitHub Releases 源（源选择机制与双源关系；M8-1 板 WP-06 交付物；[自定] 登记）

- 状态：已接受（2026-09-26，X 会话按卡内定并登记；§2 行 116 M8 范围"GitHub 源接线 `/update`"）
- 前序锚：M7 遗留 #16（GitHub 源接线）／#13（Releases 成功路无真实样本；`docs/milestones/M7.md` 行 106/103）；**ADR-0050**（双源并列不择优——本 ADR 只定向修订其决策 1 的"未接线"留白，决策 2-6 全部沿用）；ADR-0045（更新原子性三层）；ADR-0044 决策 1（默认通道 npm）；v2.8 附录 E 行 630（"更新走 npm registry 或 GitHub Releases"）；§12.6（未覆盖级先 mini-ADR，B-06）

## 背景

- ADR-0050 决策 1：`checkGitHubLatest()` 已导出但**未接线**，`/update` 唯一走 npm 源；决策 6：GitHub 源**不含安装动作**（安装/原子性唯一走 npm 面）。M8-WP-06 卡（用户批准整板）要求"把 `/update` 接上 GitHub 源"并定"双源关系与版本比较规则"。
- 既有契约面：`/update` **无参**（`cmd.update.err.args`＝"/update takes no arguments"，命令注册处与既有测试断言同源）⇒ 以"命令参数"形选择源会破坏既有契约与 DoD④"npm 源既有路径零改动"。启动期自动检查（`startAutoUpdateCheck`）是既有独立面。
- 真实样本现状：GitHub Release `v0.1.0` 已于 2026-09-26 在线（四资产），M7 期"Releases 成功路无真实样本（HTTP 404）"（#13）具备闭合条件。

## 决策

1. **源选择＝显式 env 逃逸舱**：`STANDARD_CODE_UPDATE_SOURCE`（缺省 `npm`；`github`＝GitHub Releases 源）。**大小写不敏感**（trim+小写）；**非法值 fail-closed 抛错、不静默回落**（与 `STANDARD_CODE_SANDBOX`／`STANDARD_CODE_THINKING`／`STANDARD_CODE_EXPERIMENTAL` 同族口径）。选择机制不改 `/update` 无参契约（DoD④）。
2. **双源关系＝并列不择优**（承 ADR-0050 决策 1）：两源各自独立查询，**不自动择优、不回退、不并发取最大**；版本比较一律用既有 `compareVersions()` 单源，**不跨源比较**（两源版本策略不一致时取最大会引入半装态，ADR-0045 决策 1 无该判据）。
3. **GitHub 源＝只读报告面（不含安装）**（承 ADR-0050 决策 6）：`/update`（github 模式）查 release → `normalizeReleaseTag()` 归一（需前导数字）→ 与当前版本比较：
   - `≤ 0`＝"已最新（GitHub Releases 源）"；
   - `> 0`＝**报告新版并明示"本源只报告、不安装"**＋给出两条安装通道（npm 安装命令／Release 资产下载页）；**不执行任何安装动作**。
4. **npm 源路径逐字零改**（DoD④）：无 env／`npm` 时行为、文案、i18n 键与既有实现完全一致；既有测试断言零改动仍绿。
5. **失败面 fail-closed**：GitHub 四态（非 2xx／非 JSON／`tag_name` 缺失／tag 非版本形，ADR-0050 决策 4 既有实现）＋超时 → `/update` 抛错（新键 `cmd.update.github.queryFailed`，含点名 reason）；非法 env 值 → 新键 `cmd.update.source.invalid`（含原值）。
6. **范围限定＝手动 `/update`**：启动期自动检查维持 npm 单源（其"静默降级"口径不变）；二进制资产下载/替换不在本 ADR（承 ADR-0050 边界，属二进制通道面）。

## 理由

- **显式优于隐式**：源择优/回退是规格未定义的新增语义（ADR-0050 已裁不引入）；env 选择把"用哪个源"变成用户的显式动作，零隐式行为。
- **不破无参契约**：命令参数形会改既有 `/update` 行为面与断言（DoD④ 冲突）；env 形与仓内逃逸舱家族同形。
- **只报告不安装**：GitHub 源与 npm 源版本策略可能不一致（正式版 vs 预发布），"查 GitHub、装 npm"是混源半装态；守 ADR-0050 决策 6 的安全边界。

## 向后兼容判定

- 未设新 env＝行为逐字等同现状（默认 npm，含全部文案与安装动作）；新键只增不改，旧键零删改；非法值仅在新 env 被显式设置且值非法时拒绝（fail-closed，不静默）。
- `UpdateDeps` 只新增可选注入面（`checkGitHub?`），既有注入面语义零改。

## 影响面逐条

① `/update` 命令实现（`apps/cli/src/repl.ts` `updateNow`：源解析＋github 分支；npm 分支逐字不动）② `packages/platform/src/updater.ts`：新增 `UPDATE_SOURCE_ENV_KEY`／`UpdateSource`／`parseUpdateSource()`（纯函数；既有 `checkGitHubLatest`／`checkRegistryLatest`／`normalizeReleaseTag` 零改）③ i18n 新增 4 键（EN／ZH 双包等集：`cmd.update.source.invalid`／`cmd.update.github.queryFailed`／`cmd.update.github.latest`／`cmd.update.github.available`）④ 新 `scripts/probe-update-sources.mjs`（只读探测两源，非外发）⑤ 新判据文件（三态＋npm 零改动对照＋非法值 fail-closed）。

## 边界

- 不做 winget/brew 更新通道；不做二进制资产下载/校验/替换（承 ADR-0050 边界）；不改 npm 安装路径与原子性（ADR-0045 全部维持）；零外发（探测＝只读 GET）；不改自动检查单源口径。

## 参考

- M7 遗留 #16/#13（`docs/milestones/M7.md` 行 106/103）；ADR-0050（决策 2-6 沿用、决策 1 定向修订）；ADR-0045；ADR-0044 决策 1/8/10；v2.8 附录 E 行 630／§2 行 116／§12.6。
- 实现：`packages/platform/src/updater.ts`（源解析＋既有双源）；`apps/cli/src/repl.ts`（`updateNow` 分支）；`scripts/probe-update-sources.mjs`（真实只读探测）；判据：`packages/platform/test/wp06-update-source.test.ts`＋`apps/cli/test/wp06-update-github.test.ts`。
