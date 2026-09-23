# ADR-0050: 更新双源（npm registry / GitHub Releases）通道语义（M7-1 板 WP-11 交付物；[自定] 登记）

- 状态：已接受（2026-09-24，X 会话按卡内定并登记）
- 前序锚：附录 E 行 630（"更新走 npm registry 或 GitHub Releases"）、ADR-0044（通道阶梯＋决策 10 包名改判 `@standardcode-oss/cli`；决策 8 真实 registry 复验口径）、ADR-0045（更新原子性三层）、ADR-0048/0049（mini-ADR 最短形制先例）。

## 背景

- 附录 E 行 630 只给"npm registry **或** GitHub Releases"的**或**关系，**未定义择优规则、默认源、失败回退与版本归一口径**；M5 期
  `packages/platform/src/updater.ts` 文件头将"GitHub Releases/二进制通道"登记为 M5 边界，故双源仅 npm 一路落地（ADR-0044 决策 8）。
- 本卡（M7 WP-11）清偿该边界：补 GitHub Releases 源，并登记此前未定义的通道语义。规格面无一手锚（[CC]/Codex 更新源锚零）→ 全 [自定]。

## 决策

1. **双源并列、择优规则不做（本次不引入）**：`checkRegistryLatest()`（npm，既有）与 `checkGitHubLatest()`（本卡新增）**并列为两个独立取版本能力**，
   均返回同形 `UpdateCheckResult`（`{ok:true,latest}` / `{ok:false,reason}`）。**不引入自动择优/回退/并发取最大**：
   规格无依据，且"取最大版本"在两源版本策略不一致时（npm 正式版 vs GitHub 预发布）会引入半装态风险（对位 ADR-0045 决策 1 无半装态判据）。
   默认源维持 **npm registry**（ADR-0044 决策 1 全平台首选）；`/update`（`apps/cli/src/repl.ts`）**接线不变**，
   GitHub 源为**已导出但未接线**的备用探测面（待后续卡按用户裁决决定是否接线与以何形接线）。
2. **GitHub 源坐标与 URL**：owner/repo 常量化 `GITHUB_REPO_OWNER="admin001-bit"` / `GITHUB_REPO_NAME="standardcode"`
   （取本产品仓 `git remote get-url origin` 实测值，非模型记忆）；缺省 URL=`https://api.github.com/repos/<owner>/<repo>/releases/latest`，
   **URL 可注入**（`releasesUrl`，与 npm 源 `registryUrl` 同形，测试全离线）。
3. **超时同量级**：沿用 `UPDATE_CHECK_TIMEOUT_MS`（10s，ADR/M5 已登记值）与 `AbortSignal.timeout`（内部 unref 不吊事件循环）——双源同一超时口径。
4. **fail-closed 四态**（与 npm 源同严度，绝不静默成功）：非 2xx → `github releases responded HTTP <status>`；
   JSON 异常 → `github releases response is not JSON: …`；`tag_name` 缺失/非 string → `github releases response has no string tag_name field`；
   tag 非版本形 → `github releases tag is not version-like: <tag>`。fetch 抛错 → 原 message 透传。
5. **版本归一（`normalizeReleaseTag`）**：剥首尾空白 + 单个 `v`/`V` 前缀；**需前导数字**方可通过（无前导数字如 `latest`/`nightly`/`M6` → null → fail-closed，
   避免把 tag 名当版本号静默取号）。归一后与 `compareVersions()` 同口径（`compareVersions` 本身容忍 v 前缀，见 M4 WP-08 断言）。
6. **GitHub 源不含安装动作**：只取版本号。安装/原子性仍唯一走 npm 面（`runNpmUpdateAtomic`，ADR-0045）；二进制资产下载/替换的原子性不在本卡边界（属 WP-09 二进制通道面）。

## 理由

- **不择优**：规格只给"或"，任何择优/回退都是新增语义；且并发取最大会把"两源不一致"变成不可判定的半装态，违反 ADR-0045 决策 1。留白比编造规格安全。
- **不接线 /update**：接线会改变 M5 已核销的 `/update` 行为面（i18n 键、三件套降级路），属越界；本卡按"只补源"边界收口，未接线项在结果页显式登记。
- **tag 需前导数字**：GitHub 的 tag 可为任意字符串（`latest`/`nightly` 常见），静默取号会导致版本比对失真；fail-closed 点名原因与 ADR-0034 三件套降级路同形。
- **URL 可注入 + 全离线测试**：与 M4 WP-08 既有注入面形制一致（仿 `mcp/transport.ts`），故新源可零网络全离线测，判据双向可写。

## 边界

- 本 ADR 只覆盖"取最新 release 版本"；不含 release 资产选择/下载/校验/替换（WP-09 二进制通道面），不含 `gh release create`（外发，BLK-02=① 逐项授权制）。
- 不改既有 ADR 结论（ADR-0044 决策 1/8/10、ADR-0045 全部维持）。
- **不新增 settings/env 键**（默认源无开关），故不登记 ADR-0030 键位归属表。
- 真实 GitHub 探测仅**只读 GET**（`releases`/`releases/latest`/`tags`），零写动作；发布动作（建 release）为外发，未执行、待授权。

## 参考

- v2.8 附录 E 行 630；M7-1 板 WP-11 卡；`packages/platform/src/updater.ts`（`GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME`/`DEFAULT_GITHUB_LATEST_URL`/
  `GITHUB_API_ACCEPT`/`normalizeReleaseTag`/`checkGitHubLatest`）；`packages/platform/test/wp11-updater-github.test.ts`（DoD① 判据）；
  `packaging/update-uninstall-matrix.md`（通道矩阵记录）。
- ADR-0044（决策 1 通道阶梯／决策 8 真实查询复验口径／决策 10 包名改判）、ADR-0045（更新原子性）、ADR-0034（三件套降级形制）、ADR-0048/0049（mini 形制先例）。
