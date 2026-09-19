# ADR-0047: 独立二进制选型=Bun compile（M7，v2.8 附录 E 行 630、§14.2 Q-6 行 585、§3 行 131；M7-1 板 WP-09 交付物 / BLK-09 裁决落档）

- 状态：已接受（2026-09-20，用户裁决=①Bun compile；承 2026-09-19 附条件预授权）
- 背景：附录 E 行 630 将独立二进制两路线并列（"Bun compile/Node SEA，附 checksum"）=规格空白（§0.5 B-06 未覆盖级），M7-1 板以 **BLK-09** 升级（protocol §5）。2026-09-19 用户批准 M7 整板时给**附条件预授权**（原话逐字：「暂时没想好；未完工继续推进；需定案时选 Bun」）；2026-09-20 用户正式裁决=**①Bun compile**。本 ADR 即 B-06 mini-ADR 的定案落点（ADR-0046 决策 2 所指结案路径）。

## 决策

1. **选型定案=Bun compile**：独立二进制以 `bun build --compile` 产出。Bun 定位**仅作打包器**（Q-6 口径不扩张）：不替换运行时、不改 Node ≥24 主目标（ADR-019）、不进 npm 包 `dependencies`。
2. **目标族**（官方文档枚举，`--target` 支持交叉编译）：Windows=`bun-windows-x64`、Linux=`bun-linux-x64`、macOS=`bun-darwin-arm64`（arm64/musl 目标随 WP-10 通道需求另定）。产物=单文件，内含 Bun 运行时（无 Node 前置）。
3. **工具链获取口径**：bun 以**仓内 devDependency 固定版本**引入（隔离于仓库，不改系统环境；BLK-09 裁决前"不装 bun"约束随本裁决解除）；版本随 `pnpm-lock.yaml` 固定，CI 侧按同版本装。渠道实测锚=npm 包 `bun` 在册（`registry.npmjs.org/bun` → `latest=1.4.2`，2026-09-20 直连查询）。安装须显式官方源（承 M7 教训：`--registry=https://registry.npmjs.org`）；首次交叉编译需联网下载目标运行时，本机 IDE 代理对 github 502／直连间歇超时为既知风险（重试处置）。
4. **构建输入与 checksum**：输入沿用既有 esbuild 单文件 ESM bundle（`apps/cli/dist/standardcode.mjs`，ADR-0044 决策 3），不新造第二套打包链；checksum 复用 `scripts/checksum.mjs`（ADR-0044 决策 4 的 SHA-256／SHA256SUMS 形状），逐平台产物生成与校验。
5. **DoD①「三平台单文件产物本地可执行（version/cold-start 门）」核销口径**（环境事实：本机=Windows 原生 + WSL2 Ubuntu，无 macOS）：**Windows=本机实跑、Linux=WSL2 实跑**（与 ADR-0044 决策 7 同形）、**macOS=CI runner 实跑**。即"三平台产物可产出 + 两平台本地实跑 + macOS 由 CI runner 实跑"，可执行性以 `--version` 与冷启动门为准。**此口径为本 ADR 对 DoD① 的唯一解释，供 V/G 门对质。**
6. **边界与归属**：①**Rust 沙箱臂（-sdb 子进程）不内嵌**单文件产物（跨语言=子进程+JSON，ADR-0021）——其随包分发属 **WP-10** 通道包边界；产物在无沙箱臂环境的行为沿用 M5 fail-closed 语义，本卡不改。②npm bin 随包复核（M5 §G ③）=本卡顺带项，形制不变（bin shim 消费 dist bundle）。③**不签名**（Q-7 维持，ADR-0046 决策 3），checksum 为完整性通道；macOS 产物的 Gatekeeper 提示归 WP-10 发布说明候选（Q-7 口径内）。④**不外发**：产物/脚本只在本地与 CI 产出，一切发布动作逐项用户明示（BLK-02=①）。
7. **否决 Node SEA 的理由（记录，供后续复议）**：①**本机可用形态受限**——官方 SEA 文档：`--build-sea` 自 Node **v25.5.0** 起内置；本机 Node=v24.14.0（`--experimental-sea-config` 实测在、`--build-sea` 实测缺）→ 只能走"生成 blob + postject 注入"旧工作流（macOS 另需去签/再签）。②**ESM 入口限制面**——官方文档：`mainFormat: "module"` 下 `import()` 仅可加载内置模块、**文件系统动态导入抛错**；本仓源码存在运行期动态导入点（`apps/cli/src/main.ts:151/153/171/179`、`uninstall.ts:62/92`；多为内置/workspace 模块，bundle 后是否仍为文件系统导入需实测），改造面不确定。③**与 Q-6 倾向、附录 E 序次、§3 行 131 前置的一致性**不及 Bun（Bun `--compile` 为官方稳定形制，交叉编译目标族完备）。
   - 说明：SEA **并非能力不可用**——官方文档述其支持跨平台生成（须 `useCodeCache=false`／`useSnapshot=false`）。本裁决基于本机 Node 版本、ESM 限制面与工程链成本取 Bun，属**成本取舍，非能力否定**。

## 影响

- **scripts/**：新增二进制构建件（与 `build-cli.mjs`／`pack-release.mjs`／`checksum.mjs` 同族），WP-09 交付物。
- **CI**：二进制臂（产物产出 + 实跑门）挂接位置=`release-matrix.yml` 或 `ci.yml` 新增臂，随 WP-09 定；本 ADR 只登记可选挂接，不改 `ci.yml` 既有门面。
- **相邻机制**：WP-10（通道包须带 Rust 臂与未签名声明）、WP-11（双源更新／卸载通道矩阵）、WP-14 收口（DoD 勾验引用决策 5 的核销口径）。
- v2.8 §14.2 Q-6 行内定案标注（工作区文档侧，原文保留）。

## 参考

- v2.8 附录 E 行 630／§14.2 Q-6 行 585／§3 行 129-131／§2 行 115／§0.5 B-03、B-06；ADR-0044（决策 2/3/4/7）、ADR-0019、ADR-0021、ADR-0046 决策 2；M7-1 板 BLK-09 与 WP-09 卡；M7-1-results 批准节（BLK-09 附条件预授权原文逐字）。
- 外部锚（2026-09-20 亲查）：Bun 官方 `Single-file executable` 文档（`--compile`／"Cross-compile to other platforms"节；目标族枚举 `bun-linux-x64|arm64|musl`、`bun-windows-x64|arm64`、`bun-darwin-x64|arm64`；macOS 需 codesign）；Node 官方 `Single Executable Applications` 文档（Stability 1.1 Active development；`--build-sea` 自 v25.5.0；跨平台生成须关 code cache/snapshot；`mainFormat: "module"` 的文件系统 `import()` 限制；macOS 需签名）。
- 本机实测（2026-09-20）：Node v24.14.0（`--experimental-sea-config` 在、`--build-sea` 缺）；bun 未安装；WSL2 Ubuntu 在位；npm registry 直连可用（`bun` 包 `latest=1.4.2`）。
