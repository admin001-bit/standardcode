# ADR-0046: §14.2 Q-5~Q-9 开放问题结案（M7，v2.8 §14.2 行 584-588、§2 行 115、§0.5 B-06；M7-1 板 WP-12 交付物）

- 状态：已定（2026-09-20，M7-WP-12 结案登记）
- 背景：§14.2 五条开放问题（Q-5~Q-9）自 M1 起以"倾向 + 后置复审"形式挂账；M5 已就 Q-5/6/7 复审并落 ADR-0044（另含包名改判决策 10），M6 已就 Q-8 复审（用户裁决 BLK-06=①）。本 ADR 为**终态复核与结案登记**：只给出结案结论与可亲查依据锚，**不新开设计**（WP-12 卡边界）；Q-6 的实选型仍以 BLK-09 用户裁决为准（本 ADR 仅登记其结案路径）。
- 锚点（v2.8 行号）：§14.2 行 584-588（Q-5~Q-9 原文与倾向）、§2 行 115（M7 范围列"Q-5~Q-9 遗留裁决"）、§0.5 B-06（mini-ADR 形制）、附录 E 行 630（分发通道阶梯）、§3 行 131（bun 前置触发）。

## 决策（五条逐条结案）

1. **Q-5「首版分发形态：npm 先行 vs npm+Bun 双通道」→ 结案：按倾向序进，双通道演进项已在 M7 本板落地推进。**
   - 事实锚（可亲查）：`npm view @standardcode-oss/cli --registry=https://registry.npmjs.org version dist-tags time.created` → `0.1.0`／`latest: 0.1.0`／创建于 `2026-09-17T12:44:59.446Z`（npm 先行通道已真实上线）。
   - 演进锚：M7-1 板 **WP-09**（独立二进制+checksum，阻塞 BLK-09）→ **WP-10**（winget/直接下载/Homebrew/Linux 通道包）→ **WP-11**（更新双源+卸载全通道）即双通道的落地载体；WP-09 开工即从"骨架就位"转入实发（外发动作仍逐项用户明示，承 BLK-02=① 口径）。
   - 与 ADR-0044 的关系：ADR-0044 决策 1 的"二进制=骨架与文档就位、不实发"限定**M5 期**（B-03 里程碑边界），M7 本板执行该演进项属既定排期推进，**非矛盾**。

2. **Q-6「Bun 作运行时的取舍」→ 结案：维持"仅作打包器"定位；M7 期**预授权**=Bun compile（条件性，**未最终定案**），定案落点=BLK-09 的 WP-09 开工 mini-ADR。**
   - 事实锚：M5 复审（ADR-0044 决策 2）= **M5 期不引入 bun**（打包器=esbuild 单文件 ESM bundle，零运行时依赖，bun 未安装）；M7 BLK-09（M7-1 板阻塞卡）= 独立二进制选型二选一（Bun compile〔P 倾向〕vs Node SEA），**用户 2026-09-19 附条件预授权=「需定案时选 Bun compile」**（用户可改选）。
   - 与 ADR-0044 的关系：ADR-0044 决策 2 的"不引入"限于 M5 期口径；M7 选型属新里程碑决策，且 Q-6 原文倾向即"**仅作打包器**"——"Bun compile"正是**打包器**用法（非运行时替换），二者方向一致，**非矛盾**。
   - 结案判定：本卡只登记结案路径（实选型定案落点=**WP-09 开工时点的 mini-ADR**，依 §0.5 B-06）；在未定案前 bun 仍不进入运行时依赖面。

3. **Q-7「Windows 代码签名」→ 结案：维持"首版不签名"，以 SHA-256 checksum 为完整性通道。**
   - 事实锚：ADR-0044 决策 2/4 = 首版不签名（签名+公证待证书采购〔用户侧义务〕后复审）；checksum 形状=`scripts/checksum.mjs gen|verify`（SHA-256，SHA256SUMS 风格）；`docs/release.md:26` 指向 ADR-0044 通道/签名/uninstall 语义。
   - **登记缺口（如实声明未签名的落地不完整）**：ADR-0044 决策 2 要求"**README**/ADR 如实声明未签名"——ADR 侧已载，但仓库 `README.md` **未见**未签名声明（`grep -rniE "unsign|not signed|未签名" README.md` 零命中）。归属=发布通道包上下文（M7 **WP-10** 或 WP-11 落地 README/发布说明时补），本 ADR 不代改 README（WP-12 边界：不新开设计）。

4. **Q-8「/goal /btw /branch 等长尾命令去留」→ 结案：M6 复审已裁（BLK-06=①），四件延后件已**排期**落 M7 本板（WP-07，卡态=待执行）＝去留问题自此闭合。**
   - 事实锚：v2.8 行 587 内联标注（M6 复审 2026-09-18 用户裁决 BLK-06=①：`/btw` `/branch` 延后 M7，`/batch` `/loop` 同批延后；M6 只落 `/workflows` `/fork` `/export`）；M7-1 板 **WP-07**（四长尾 `/branch` `/batch` `/loop` `/btw`）= 该四件的落地载体（另含 §3.2 迁移点：四件自 `experimental-gate.ts` 的 `EXPERIMENTAL_DEFERRED_COMMANDS` 移入对应 flag 映射）；`/goal` 已由本板 **WP-01** 落地（完成，2026-09-20 V 核销）。
   - 结案判定：去留问题（哪些命令做、在哪个里程碑做）已全部裁决且各有落点，**结案**；剩余为执行排期，不再是开放问题。

5. **Q-9「产品许可证」→ 结案：Apache-2.0。**
   - 事实锚（可亲查）：仓库根 `LICENSE` = Apache License 2.0 全文；`apps/cli/package.json` `"license": "Apache-2.0"`；`gh api repos/admin001-bit/standardcode --jq .license.spdx_id` → `Apache-2.0`（GitHub 识别一致）。复用 Codex 代码 NOTICE 干净（§14.2 原文依据）。
   - **卫生建议（非阻断，登记不切分）**：根 `package.json` 与 `packages/*/package.json` **无** `license` 字段（仅 `apps/cli` 有）→ 随发版卫生项顺带补齐（归属：任何触及 package.json 的后续卡；本卡不改）。

## 与 ADR-0044 一致性核对（DoD②）

| ADR-0044 决策 | 本 ADR 结论 | 判定 |
| :-- | :-- | :-- |
| 决策 1（M5 生效通道=最小集；二进制仅骨架不实发） | Q-5 双通道演进项在 M7 本板推进（WP-09~11） | 一致（里程碑边界不同，非矛盾） |
| 决策 2（M5 期不引入 bun；Q-7 首版不签名；checksum 通道） | Q-6 维持"仅作打包器"、M7 选型随 BLK-09；Q-7 维持不签名+checksum | 一致（Q-6 阶段不同、方向一致；Q-7 完全一致） |
| 决策 10（包名改判 `@standardcode-oss/cli`） | Q-5 事实锚即该包名（npm 实况查询） | 一致 |
| 决策 2 尾句（README/ADR 如实声明未签名） | README 侧**未落地** | **登记缺口**（见决策 3，归 WP-10/11） |

## 影响

- 本 ADR 为**结案登记**：不引入新需求、不改既有实现、不占新编号面（沿用 §14.2 既有条目）。
- v2.8 §14.2 表相应条目加行内结案标注（工作区文档侧，原文保留）。
- 后续动作：BLK-09 定案时（WP-09 开工）落 mini-ADR（本 ADR 决策 2 为其结案路径）；README 未签名声明随 WP-10/11 补（登记缺口）。

## 引用

- v2.8 §14.2 行 584-588（Q-5~Q-9 原文/倾向）、§2 行 115、§0.5 B-06、附录 E 行 630、§3 行 131；**验证级别**出处=`plan/protocol.md:35`（A=X+V+main 抽查／B=X+V／C=X+G 抽查；v2.8 §12.6 是"参考深度三级"，非验证级别）。
- `docs/adr/0044-release-channels-and-uninstall.md`（决策 1/2/4/10）、`docs/adr/0045-update-atomicity.md`、`docs/release.md`。
- M7-1 板 WP-12 卡（结案范围）与 WP-01/07/09/10/11（落点）、M6-1-results 解阻塞节（BLK-06=①）、M7-1-results 批准节（BLK-09 附条件预授权原文）。
- 亲查命令：`npm view @standardcode-oss/cli --registry=https://registry.npmjs.org`；`gh api repos/admin001-bit/standardcode --jq .license.spdx_id`。
