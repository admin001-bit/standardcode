# 更新与卸载全通道矩阵（M7-1 板 WP-11）

> 规格依据：v2.8 附录 E 行 630（"更新走 npm registry 或 GitHub Releases；卸载 `standardcode uninstall --purge` + 手动清理脚本"）。
> 通道语义（双源并列/默认源/fail-closed/版本归一）= **ADR-0050**；卸载语义 = ADR-0044 决策 5/6；更新原子性 = ADR-0045。
> 存放约定承 WP-09/10（`packaging/` + `docs/adr/`）。**不外发**：本卡仅只读探测（`GET`），无 `npm publish`／`gh release create`／PR。
> 记录日期 2026-09-24（X 节）；**自评不等于核销**，V 会话复核。**2026-09-26（M8-WP-08）复验刷新**：§0 两条本机硬约束失效（spawnSync 转绿／wsl.exe 可用）、§1 真进程行转"已验证"、§2 新增 WSL2 二进制实跑行与 `--purge` 失败分支构造行（含缺陷登记 D-1）；历史行文保留原样、订正以行内日期标注。

## 0. 本机硬约束（决定"已验证/不可验证"分界）

| 约束 | 实测表现 | 后果 |
|---|---|---|
| `spawnSync` 恒 EBUSY 〔**2026-09-26 实测：已失效**〕 | 记录日：连 `echo baseline-ok` 亦 `status=null / EBUSY`；2026-09-26 复测：子进程族**转绿**（`spawnSync("cmd"/"git")` status=0、npm/npx 11.9.0 正常） | **真进程面已可跑** → 见 §1/§2「2026-09-26 复验」行（M8-WP-08）；原"一律走注入面"口径仅对记录日成立 |
| `wsl.exe` 被安全策略黑名单拦截 〔**2026-09-26 实测：已失效**〕 | 记录日：`Permission denied`；2026-09-26 复测：`wsl.exe -d Ubuntu` 可用（`uname -a` 正常） | Linux 臂**已可本机实跑** → 见 §2「WSL2 二进制实跑」行（M8-WP-08） |
| 无 macOS | — | darwin 臂**本机不可实跑** → 待 CI |
| GitHub/registry 出站 HTTPS 可用 | 实测 200/404 均可达 | 双源**真实只读探测**可执行（与上述 git 443 通道断为两回事） |

## 1. 更新源 × 三平台

> 源本身平台无关（HTTP 取版本）；平台差异点只在安装命令分型（`npmCliCommand`：`win32→npm.cmd`、其余→`npm`），该分型由既有 wp08 断言覆盖。

| 源 | win32 | linux | darwin | 证据 |
|---|---|---|---|---|
| **npm registry**（默认源，ADR-0044 决策 1） | 已验证 | 已验证 | 已验证 | 单测 `packages/platform/test/wp08-updater.test.ts`（11 例：成功/非 2xx/脏 JSON/超时/常量）+ `wp11-updater-github.test.ts`「npm 源复验」三态（同文件，平台无关）——本机 win32 全绿 |
| **npm registry 真实探测** | 已验证（本机） | 待 CI | 待 CI | `node --experimental-strip-types .work/wp11-probe-sources.mjs` → `npm result : {"ok":true,"latest":"0.1.0"}`（raw `HTTP 200`；与 `apps/cli/package.json` version `0.1.0` 同源 → `compareVersions` = 0 = 已是最新） |
| **GitHub Releases**（本卡新增，ADR-0050） | 已验证（本机） | 待 CI | 待 CI | 单测 `packages/platform/test/wp11-updater-github.test.ts`（12 例：成功/`v` 前缀归一/超时/非 2xx/脏 JSON/`tag_name` 缺失/tag 非版本形/fetch 抛错/URL 注入/双源同形/单源收敛） |
| **GitHub Releases 真实探测** | 已验证（本机） | 待 CI | 待 CI | 同上脚本 → `github result: {"ok":false,"reason":"github releases responded HTTP 404"}`；旁路裸 fetch 复核 `raw status 404`／`{"message":"Not Found"}`（**本仓尚无 release**＝未发布前结构化降级即真实路通过形态，承 ADR-0044 决策 8 口径）；旁路另证 `GET /repos/admin001-bit/standardcode`=200、`releases?per_page=1`=`[]` |
| **安装/原子更新执行**（`runNpmUpdateAtomic`，ADR-0045） | 已验证（注入面） | 已验证（注入面） | 已验证（注入面） | `packages/platform/test/wp07-updater-atomic.test.ts` **零改动**复跑 10 例全绿（DoD③ 回归） |
| **真进程 `npm i -g`／`npm rm -g`（全链）** 〔**2026-09-26 复验：已验证（本机）**〕 | **已验证（本机）** | 待 CI | 待 CI | M8-WP-08 复验：`npm i -g --prefix <tmp> @standardcode-oss/cli@0.1.0` rc=0（`added 1 package in 10s`）→ `<tmp>/standardcode --version`＝`standardcode 0.1.0` rc=0 → `npm rm -g --prefix <tmp> @standardcode-oss/cli` rc=0（`removed 1 package in 706ms`）→ shim 消失（`No such file or directory`）；旁记：卸载后 `<tmp>/node_modules/@standardcode-oss/` 空目录残留（npm 行为，无害）。原"本机不可验证"仅对记录日（spawnSync EBUSY 期）成立 |

## 2. 卸载通道 × 三平台

| 通道 | win32 | linux | darwin | 证据 / 判据 |
|---|---|---|---|---|
| **CLI 默认卸载**（`npm rm -g` + PATH 还原 + 残留断言） | 已验证（注入面） | 已验证（注入面） | 已验证（注入面） | `apps/cli/test/wp11-uninstall-channels.test.ts`：三平台各跑一遍（`npm.cmd`/`npm` 分型、args 恒 `rm -g @standardcode-oss/cli`、数据目录 `<home>/.standardcode`）＋ `wp07-release-cli.test.ts` 既有 10 例（V-WP11 勘误：原记 8 例，实枚举 10） |
| **CLI `--purge` 全链**（①程序体→②PATH→③残留→④确认→⑤删用户数据） | 已验证（注入面，全链顺序断言 `["runner","restorer","verifyGone","confirm"]`） | 同左 | 同左 | 同上文件「全链贯通」例：exit 0 + 五行关键输出 + 数据目录消失；反向例「残留校验失败→purge 不执行（confirm 零调用、目录保留）」＝防半卸态 |
| **`--purge` fail-closed**（非 TTY 无确认通道=拒绝） | 已验证 | 已验证 | 已验证 | `wp07-release-cli.test.ts`（非 TTY 拒绝 exit 1 + 目录保留；用户拒答 aborted）——平台无关。**2026-09-26（M8-WP-08/V）新增 D-V1**：真 bin（`bin/standardcode.js:19`／`.binary.mjs:25`）均以**单参**调 `runUninstall` ⇒ `io.confirm` 从未装配 ⇒ 真 bin 下 `--purge` **恒走本条拒绝路**（含 TTY＝交互路径不可用；④ 段引导文案指向不可达路径）。fail-closed 安全面成立（无数据删除）；功能面缺口＝交互 purge 通道未装配。**〔2026-09-26 晚（M8-WP-11）D-V1 已修〕**：新增 `runUninstallCli` 入口（TTY 判定→readline y/N 装配默认确认；非 TTY 不装配＝本条拒绝语义零改），bin 两入口改调；判据 `apps/cli/test/wp11-uninstall-purge-confirm.test.ts`（TTY 确认→purge 全链／非 TTY 仍拒绝／拒答中止）＋**真进程** `node apps/cli/bin/standardcode.js uninstall --purge`（非 TTY）→ 本条拒绝 rc=1（沙箱前缀实跑） |
| **手动清理脚本**（`scripts/cleanup.ps1 -PurgeHome` / `scripts/cleanup.sh --purge-home`） | 静态已验证 | 静态已验证 | 静态已验证 | 三平台用例内静态断言：脚本含对应旗标、包名与 `NPM_PACKAGE_NAME` 同字（`@standardcode-oss/cli`）、且不含改判前旧名；**实跑未验证**（spawnSync EBUSY／wsl.exe 拦截） |
| **`reg` 注册表 PATH 还原**（`defaultPathRestorer` win 分支） | 本机不可验证（spawnSync EBUSY） | — | — | 注入面覆盖"条目与 scope 传入还原器"；`reg add` 实跑待 CI/管理员机 |
| **rc 文件行删除**（`defaultPathRestorer` posix 分支） | — | 已验证（真文件系统） | 已验证（同一实现） | `wp07-release-cli.test.ts`「PATH manifest 留痕还原（posix-rcfile 行删除）」：真临时目录 + 真 `writeFileSync`，断言删除后 rc 精确余 `echo keep` |
| **二进制通道卸载器**（`packaging/linux/uninstall.sh`，WP-10 面） | — | WP-10 已验（WSL2 实跑） | — | 本卡不重复验证（边界：只补 GitHub Releases 源与通道矩阵），指针=`packaging/README.md` |
| **winget / Homebrew 卸载** | 本机不可验证（需管理员 LocalManifestFiles / 无 brew） | — | 待 CI | 承 WP-10 BLK-12 未验证面登记 |
| **WSL2 Linux 臂二进制实跑**〔**2026-09-26 新增（M8-WP-08）**〕 | — | **已验证（WSL2 真跑）** | — | `wsl.exe -d Ubuntu -- bash -lc 'cp /mnt/d/projects/standardcode/apps/cli/dist/bin/standardcode-linux-x64 /tmp/sc-linux && chmod +x /tmp/sc-linux && /tmp/sc-linux --version'` → `standardcode 0.1.0`、rc=0（`uname -a`＝`6.6.87.2-microsoft-standard-WSL2 x86_64`）；记录日"wsl.exe 被拦截"已失效（见 §0） |
| **`--purge` 删除失败分支**〔**2026-09-26 新增构造（M8-WP-08）**〕 | **已构造（暴露 D-1；严重度经 V 订正）** | 同实现（平台无关） | 同实现 | 夹具＝子进程以 `dataDir` 为 CWD 占住目录（Windows 目录句柄）→ 注入面真调 `runUninstall(["--purge"])`：`rmSync(dataDir,{recursive,force})` 抛 **EPERM** 未被捕获 → `runUninstall` **reject**；终态 dataDir **保留**（无静默成功 ✅），设计文案 `[uninstall] purge FAILED: … scripts/cleanup.*` 在注入面**不可达**（只覆盖"rmSync 不抛但目录仍在"的窄形）。**D-1 严重度订正（V 核验，2026-09-26）**：真 bin 下该路径**不可达**——④ 段先因 confirm 未装配而 fail-closed 拒绝（rc=1＋引导文案现身）；故 D-1 实为**注入面错误路径质量项**（低危），非 bin 级缺陷。修法建议＝`rmSync` 包 try/catch → 同 FAILED 文案＋rc=1＋夹具用例，且**须先装 confirm 通道（D-V1）**。**〔2026-09-26 晚（M8-WP-11）D-1 已修〕**：`UninstallIo.removeDir` 注入面＋try/catch → 抛错走同一 `purge FAILED: <dir> — <reason>；…scripts/cleanup.*` ＋rc=1（不裸抛）；判据＝`wp11-uninstall-purge-confirm.test.ts` 两例（抛 EPERM→FAILED＋rc=1／窄形保持）；MUT 针（去 try/catch）→ 恰 1 红、复原 sha 字节级一致 |

## 3. 判据判别力（变异针，全红=非恒绿真空断言）

| 针 | 注入/变异 | 结果 |
|---|---|---|
| N1 | GitHub 源忽略 `res.ok`（非 2xx 仍解析体） | 红 1（「非 2xx…即便体含合法 tag_name 也不得成功」） |
| N2 | `normalizeReleaseTag` 取消"需前导数字"判据 | 红 2（normalize 例＋tag 非版本形例） |
| N3 | `normalizeReleaseTag` 返回原 tag（不剥 `v`） | 红 4（成功/URL 注入/normalize/双源同形） |
| N4 | `runUninstall` 跳过残留校验失败分支 | 红 1（防半卸态例） |
| N5 | 坏 manifest 上抛（`catch`→`throw`） | 红 1（坏 manifest 例） |
| N6 | PATH 还原失败改为阻断 `return 1` | 红 1（失败项不阻断例） |

变异后源码已逐针复原（`git diff` 复核：`apps/cli/src/uninstall.ts` 零改动；`packages/platform/src/updater.ts` 仅新增）。

## 4. 未验证面（显式登记）

1. **真进程面**〔**2026-09-26 更新（M8-WP-08）：`npm i -g`／`npm rm -g` 已实跑**（见 §1/§2 复验行）〕：`winget`／`brew`／`reg` 仍**零实跑**（需管理员 LocalManifestFiles／无 brew／需真写注册表）——`npm` 两面已转"已验证"；历史"spawnSync 恒 EBUSY"记录见 §0 行内订正。
2. **Linux 臂**〔**2026-09-26 更新（M8-WP-08）：已实跑**——`wsl.exe -d Ubuntu` 跑 `standardcode-linux-x64`＝`0.1.0` rc=0（见 §2）〕：`cleanup.sh`／`packaging/linux/uninstall.sh` **本卡仍未实跑**（壳脚本链，归 WP-09/10 裁量）。
3. **macOS 臂**：本机无 macOS → 全格待 CI（`release-matrix` / 三平台 CI）。
4. **GitHub Releases 成功路**〔**2026-09-26 更新（M8-WP-06）：已闭合**——Release `v0.1.0` 在线，`scripts/probe-update-sources.mjs` → `github=0.1.0`／`npm=0.1.0`／`probe: PASS` rc=0〕：历史"releases 空数组、无真实成功样本"仅对记录日成立；后续复跑同一脚本即验。
5. **`--purge` 删除失败分支**〔**2026-09-26 更新（M8-WP-08）：已构造**——子进程 CWD 占位 → `rmSync` EPERM（见 §2 两行）〕：构造同时暴露 **D-1**（注入面错误路径文案不可达；真 bin 下不可达＝严重度已由 V 订正）与 **D-V1**（真 bin 的 `--purge` 确认通道从未装配 ⇒ 恒 fail-closed 拒绝＝交互路径不可用；待后续卡裁量）。
6. **`defaultPathRestorer` win 分支实跑**（`reg query/add`）：见 §2，待管理员机/CI。
7. **双源择优/回退**：规格未定义且本卡不引入（ADR-0050 决策 1）；`/update` 仍单接 npm 源，**GitHub 源已导出但未接线** —— 待后续卡按用户裁决决定。
8. **邻通道同族缺陷（本卡发现并登记 D1；已由 main 于 `8fffaa2` 一并订正，非本卡越界）**：`scripts/install.sh` / `scripts/install.ps1`
   原亦字面 `@standardcode/cli`（ADR-0044 决策 10 改判前旧名，安装通道会装到另一个包）。本卡只修卸载通道（`cleanup.sh`/`cleanup.ps1`），
   安装侧登记交 main 裁决 → main 于 `8fffaa2` 订正两脚本并补守卫断言（两脚本新包名在位＋旧名零命中），`wp11-uninstall-channels` 16→17 例。
   现四脚本包名一致＝ `@standardcode-oss/cli`。
