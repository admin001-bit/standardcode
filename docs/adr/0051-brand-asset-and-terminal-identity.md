# ADR-0051: 品牌资源入库路径与终端标识位渲染（M8-1 板 WP-02 交付物；[自定] 登记）

- 状态：已接受（2026-09-26，X 会话按卡内定并登记；§2 行 116 M8 范围"品牌资源 dog-logo 入库"）
- 前序锚：v2.8 附录 E 行 631（品牌资源条款：三件清单＋标识位＋tagline 原文）；接缝㉔（渲染单源）；ADR-0049（mini-ADR 最短形制先例）；M7 遗留 #19（`docs/milestones/M7.md` 行 109：产品仓素材文件零命中）。

## 背景

- 附录 E 行 631 只定品牌资源的**构成**（`dog-logo.ts` ESM 主源／`dog-logo.js` CommonJS 版／`dog-logo.png` 成品图）与**呈现**（"logo 置终端左侧产品标识位，正右方上下居中配 StandardCode, Born for Engineering."），未定入库路径与渲染落点（规格空白面）。
- 产品仓实测：素材文件零命中（`git ls-files` 无 dog 系文件，`docs/milestones/M7.md` 仅文本提及）＝本卡从零入库。
- 落点实测：启动期唯一产品标识输出＝`apps/cli/src/main.ts` 的 `standardcode ${CLI_VERSION} — /help 查看命令，/exit 退出` 行；无其它横幅/标识渲染面。既有测试对该行零断言（全仓 grep 零命中）。
- 约束：接缝㉔ 定义色/键位单源——ANSI 颜色字面量仅许出现在 `theme.ts`，且主题 token 为**封闭六元集**（`wp03-theme.test.ts` 全集断言）；新增 token 会改既有渲染测试，与 WP-02 DoD③「既有渲染测试零改动仍绿」冲突。

## 决策

1. **入库路径 = `apps/cli/assets/dog-logo/`（三件同目录，不拆散）**（[自定]）。理由：资产仅由 CLI 消费；与 `src/` 分离可避免 CJS `.js` 落在 ESM 包源码面、并避免资产业务化后被源码扫描型守卫（如裸 ANSI 三书写形态守卫）纳入判据面。
2. **位图单源 = 渲染模块 import 资产 `dog-logo.ts`**（零复制）：`apps/cli/src/brand.ts` 消费其 `asciiFrame("rest")`，终端形制由资产自身定义（改资产即改渲染，无第二份位图）。代价如实登记（esbuild metafile `bytesInOutput` 实测）：资产文件对 bundle 贡献 **3092 B**、`brand.ts` **848 B**，合计 3940 B / bundle 599388 B（≈0.66%）。**未走渲染路径的动画段随包**——成因是资产模块级副作用块（`import.meta.url`＋argv 判 `--play`）引用 `startDogCli`，保留链把 `playDogAnimation`/`DOG_FRAMES`/`DOG_SEQUENCE` 一并带入（同源 `DOG_COLORS`/`svgForDog` 等未被引用者确已剔除）；CLI 入口只接受 `[]`/`-sdb`（其余 argv 走 usage＋exit 1），故该判据在 CLI 路径恒不触发。
3. **渲染形制**（[自定]）：18 行 logo 左对齐（行尾空白去除、左缩进保留＝轮廓所在）＋ tagline 落在第 9 行（`floor(18/2)`，0 起）右侧，水平间距 2 空格；即"正右方上下居中"的最小可行实现。
4. **零 ANSI**（接缝㉔ 遵从）：横幅全裸文本，不经 `colorize`、不新增主题 token——新增 token 会改既有主题测试（违 DoD③）。着色需求若提出，须走 theme.ts 单源另立卡。
5. **打印门控 = `process.stdout.isTTY`**（[自定]，与仓内交互面惯用的 `process.stdin.isTTY` **不同源**）：决定"是否打扰"的是输出目的地——`standardcode | tee log` 时 stdout 非 TTY 即零输出；stdin 门控会漏此形。落点＝既有 version/help 行**之前**，该行保留不动（信息面零删减）。
6. **宽度降级**（[自定]）：列数 < `BANNER_MIN_COLUMNS = LOGO_WIDTH(16) + 间距(2) + tagline(35) = 53` → 输出单行纯文本 tagline（不截断 logo 成残图）；列数未知（`process.stdout.columns` 缺省）回落 80；非有限数（NaN）按降级处理，不静默出残图。
7. **发布面零变更**：`scripts/pack-release.mjs` staged `files: ["bin/","dist/"]`——资产为构建期输入（esbuild 内联），不进 npm tarball；`apps/cli/dist/` 本就在 `.gitignore`。
8. **资产参与类型检查**：`brand.ts` 的静态 import 使 `apps/cli/assets/dog-logo/dog-logo.ts` 进入 `tsc -p apps/cli` 的 program（`--listFiles` 实测命中），即入库资产非"未受检的裸文本"。

## 理由

- **路径选 `apps/cli/assets/` 而非仓根 `dog-logo/`**：仓根为仓库级产物层（LICENSE/README/CI）；本资产仅 CLI 消费，就近内聚且不新增仓根条目。
- **import 而非复制位图**：单源优先于 bundle 体积（3940 B / 599388 B ≈ 0.66%）；复制方案会留双份漂移面（V 判接缝问题的先例：M7 多处"双份漂移"退回）。
- **不截断 logo**：宽度不足时残图比纯文本更难辨认，且降级形可判别（测试断言"无块字符"）。
- **保留既有 version 行**：该行承载版本与 `/help`、`/exit` 提示，删改会外溢到启动信息面（越界）。

## 边界

- 不做动画（资产内 `playDogAnimation`/`DOG_FRAMES` 入库但**不接线**：本卡不新增任何动画/交互入口，`main.ts` 入口只接受 `[]`/`-sdb`，故资产内的 `--play` 判据在 CLI 路径恒不触发）。
- 不新增 settings 键、不改主题/键位单源、不改既有 version 行文本。
- `dog-logo.png` 仅入库（终端无图形面，不参与渲染）。
- 不新增接缝（板头接缝自检：本卡不新增，㉕㉖ 归 WP-03/WP-06）。

## 参考

- v2.8 附录 E 行 631（品牌资源条款）、§2 行 116（M8 范围）；M8-1 板 WP-02 卡；M7 遗留 #19。
- `apps/cli/src/brand.ts`（渲染＋门控）、`apps/cli/src/main.ts`（装配落点）、`apps/cli/assets/dog-logo/*`（三件入库）、`apps/cli/test/wp02-brand.test.ts`（DoD①②判据＋sha256 记录）、`apps/cli/src/theme.ts`＋`apps/cli/test/wp03-theme.test.ts:167`（接缝㉔ 单源守卫）、`docs/dev/terminal-compat.md` §2（非 TTY 行模式）、`scripts/pack-release.mjs`（staged 面）、`scripts/build-cli.mjs`（内联链）。
- ADR-0049（mini-ADR 形制先例）。
