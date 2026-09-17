# ADR-0044: 发布通道集与卸载语义（M5，v2.8 附录 E 行 630、SEC-040 行 458、§14.2 Q-5/6/7 行 584-586；M5-1 板 WP-07 交付物）

- 状态：已接受（2026-09-17，M5-WP-07；BLK-02=① 用户裁决 2026-09-15 为前提）
- 背景：附录 E 给出通道阶梯（npm 首选→独立二进制→winget/直下→Homebrew→Linux 脚本/deb|rpm），Q-5/6/7 均标 M5 复审；BLK-02 裁决=①最小集——npm 真实路+三平台安装/卸载脚本+checksum+uninstall --purge；二进制/winget/brew/deb|rpm 仅骨架与文档就位不实发；签名不采用。**npm publish/GitHub 转 public=外发动作，逐项用户明示授权后方可执行（BLK-02 登记口径，本 ADR 不构成授权）。**

## 决策

1. **通道集定案（BLK-02=① 落档）**：M5 生效通道=**npm（`@standardcode-oss/cli`，全平台首选）+ 三平台安装/手动清理脚本 + checksum**。二进制（Bun compile/Node SEA）=骨架与文档就位（构建脚本位登记，不实发；Q-5 倾向"npm → 双通道演进"序进读法=双通道为 M5 后演进项）；winget/直接下载/Homebrew/deb|rpm=仅本 ADR 登记占位，零实现（B-03：进不了本 M 的不做）。
2. **Q-5 复审=维持倾向**：npm 先行，双通道演进后置。**Q-6 复审=Bun 不引入**（M5 期打包器=esbuild 单文件 ESM bundle，零运行时依赖；bun="发布前装"项且"单文件分发实验"语义与最小集不符——不装 bun，登记 §3 行 131 口径）。**Q-7 复审=首版不签名**：checksum（SHA-256）为完整性通道，签名+公证待证书采购（用户侧义务）后 M5+ 复审；README/ADR 如实声明未签名（附录 E"签名 Q-7"处置）。
3. **npm 包形制（postinstall 零提权=附录 E 供应链约束原文）**：
   - 仓内 `apps/cli` 保持 workspace 开发形制（private 移除+`publishConfig.access="public"`+`engines.node>=18`；root 保持 private:true）；
   - 发布物=**esbuild 单文件 ESM bundle**（`apps/cli/dist/standardcode.mjs`，platform=node、内置模块外置、零 npm 运行时依赖）+`bin/standardcode.js` shim（dev 树缺 dist 时回落 `src/main.ts`，冷启动 --version 短路面不变）；
   - **pack 走 staged manifest**（`scripts/pack-release.mjs`）：仓内 package.json 不为发布改写——staging 目录生成发布 manifest（name/version/type/bin/engines/license/repository/publishConfig，**无 dependencies、无任何生命周期脚本**）+ bin/ + dist/ → `npm pack` → tarball + SHA-256 checksums 文件；
   - **包形制审计**（DoD⑤）：staged manifest 与仓内 apps/cli manifest 均不得含 `preinstall/postinstall/prepare` 等生命周期脚本字段——单测断言（离线）。
4. **checksum 形状（SEC-040 checksum 半；签名半=决策 2）**：`scripts/checksum.mjs gen|verify`——SHA-256（node:crypto），输出 SHA256SUMS 风格 `<hex>  <filename>`（BSD/GNU 两用核验格式）；gen 随 pack 产出于 `apps/cli/dist/`，verify 独立命令（校验路=下载方复核通道）。checksum 覆盖面=tarball 与 bundle 文件。
5. **卸载语义（`standardcode uninstall [--purge]`，CLI 子命令非斜杠——命令全集 30 断言保持）** [自定]：
   - **默认**：①`npm rm -g @standardcode-oss/cli`（命令全硬编码零注入面，win32→npm.cmd+shell:true 承 M4 形制；env 过 SEC-080 基线剥离）②**PATH 项清偿**：安装脚本写 PATH 前经确认（ENG-040 行 431/§8.4 行 387）并留痕 `~/.standardcode/install-manifest.json`（记录所写条目与落点）——uninstall 读 manifest 逐项还原（Windows=HKCU\Environment Path reg 读写；POSIX=rc 文件行删除），无 manifest=提示无 PATH 项；③残留断言输出（全局包存在性核查）。
   - **`--purge`**：连 `~/.standardcode` 用户数据（会话/凭据/信任留痕）——**确认提示后执行；非 TTY 无确认通道=拒绝（fail-closed）**；程序体卸载失败=不执行 purge（fail-closed，防半卸态）；执行后残留断言（目录不存在）。手动清理脚本（`scripts/cleanup.*`）=不经 CLI 的等价通道（供自动化矩阵与 CLI 不可用时）。
6. **安装脚本形状（三平台；[CC]/Codex 安装器一手锚零→全 [自定]，附录 E 为机制主干）**：`scripts/install.sh`（darwin+linux，平台自适应）+`scripts/install.ps1`（windows）——流程=环境前置核查（node≥18+npm 在位）→ `npm i -g @standardcode-oss/cli@latest` → `standardcode --version` 自证 → PATH 缺失时**确认后**写入并留痕 manifest → 完成行（含 checksum 提示）。手动清理= `scripts/cleanup.sh`/`cleanup.ps1`（npm rm -g+manifest PATH 还原+`~/.standardcode` 删除，逐步打印）。零提权：脚本不做 sudo/管理员动作（npm 全局目录用户可写语义；附录 E"postinstall 不做提权"同源延伸到脚本面）。
7. **三平台矩阵实跑形制（DoD① 载体）**：装（tarball 本地安装）→`--version`→更（bump 版重装覆盖=更新路；registry 真实发布步见决策 8）→卸（CLI uninstall；purge 路用 cleanup 脚本替代非交互确认）→残留断言。Windows=本机实跑、Linux=WSL2 实跑、**macOS=CI 矩阵实跑**（`.github/workflows/release-matrix.yml`，workflow_dispatch；本机无 mac=登记）。通道形制按 BLK-02=真实/模拟双轨：安装/更新/卸载=模拟通道（本地 tarball）；registry 查询=真实通道（见 8）。
8. **真实 registry 复验（DoD⑦；M4 WP-08 未解决① 清偿）**：`checkRegistryLatest` 真实网络路（registry.npmjs.org，scoped percent-encode+超时+结构化降级）实测执行并留证；**包未发布前=HTTP 404 结构化 ok:false 即为真实路通过形态**（网络+编码+解析+降级全链真跑）。npm publish 与"装→更"全 registry 路以待发布授权为前提（BLK-02：未到手=卡收口前上报，不折减其余 DoD）；授权到手后补跑全 registry 路即闭。
10. **包名改判（2026-09-17 发布执行时）**：附录 E 行 630 原文名 `@standardcode/cli` 的 scope `standardcode` 在 npm registry 已被第三方占用（org 创建页实测 "not available"；无前缀名 `standardcode` 亦已被占，实测 200）——首发改判 **`@standardcode-oss/cli`**（org `standardcode-oss` 由账号 npm001user 创建持有；候选探测：`standardcode-cli`/`@standardcode-cli/cli`/`@stdcode/cli` 均可用，取舍=保留品牌词根+scoped 结构最接近原文形态）。本 ADR 决策 3/8 及 NPM_PACKAGE_NAME、i18n 引导文案、审计断言同步改判；附录 E 原文不回改，此偏差随 ADR 登记〔规格偏差回流：行 630 包名→@standardcode-oss/cli，供 v2.8 修订〕。
9. **发布授权停点登记**：本卡交付至"tarball+checksum+矩阵+真实查询路"为止；`npm publish`（含 private 移除后的首次发布）与 GitHub 转 public 均为外发动作，执行前逐项请示用户明示（BLK-02 口径原文落档）。

## 影响的相邻机制

- platform/updater.ts：新增原子更新执行面（ADR-0045）与 `runNpmUninstall`（runner 注入面同族）；NpmRunResult 增 stdout 捕获（npm ls --json 校验路消费，additive）。
- apps/cli：bin shim 子命令路由（uninstall）、`src/uninstall.ts`（确认/manifest/残留断言，全注入面可离线测）；main.ts usage 行文案更新。
- scripts/：build/pack/checksum/install/cleanup 五件；CI 新增 release-matrix workflow（workflow_dispatch，非 gate——ci.yml 门面不变）。

## 参考

- v2.8 附录 E 行 630（通道阶梯+postinstall 约束+卸载命令字面）/SEC-040 行 458/ENG-040~042 行 431/§13 行 534/§14.2 Q-5/6/7 行 584-586/§8.4 行 387/§3 行 131/§0.5 B-03；M4-1-results §WP-08（updater 形制+未解决①③）；BLK-02（M5-1 板）裁决原文。其余 [自定]。
