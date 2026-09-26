# ADR-0054: §14.2 Q-B3 开放问题结案（TUI 自研 vs 基座库）

- 状态：已定（2026-09-27 结案登记；依据＝M1 既成事实复核）
- 背景：v2.8 §14.2 Q-B3「TUI 自研 vs 基座库」倾向＝「自研薄层（参考 pi-tui 结构），M1 实验定」。Q-5~Q-9 已于 M7-WP-12 结案（ADR-0046）；Q-B3 因属"M1 实验"项未随批处理，为本表唯一无结案标注条目。M1 期已按倾向落地。本 ADR 为**追认既成事实的结案登记**：只给结案结论与可亲查依据锚，不新开设计。

## 决策

**Q-B3「TUI 自研 vs 基座库」→ 结案：自研薄层（参考 pi-tui 结构），M1 实验已定案并落地。**

- 事实锚（可亲查）：
  1. **落点卡**：`plan/T0-地基/M1-最小会话/M1-1-board.md` WP-03（L0 输入四模式+五命令，含 streaming render，:35 起）——其"参考资料"行明文「TUI 结构参考 kimi `pi-tui`（§5.2 锚点）」（:38）；WP-11（终端兼容矩阵+IME）→ `docs/dev/terminal-compat.md` + IME spike 记录（commit `dfcaf58`）。
  2. **实现证据**（产品仓）：`apps/cli/src/render.ts`（自研渲染层；`git log --follow` 首落 `120d6a3`＝M1-WP-03「streaming render」）；配套薄层组件 `theme.ts` / `keybindings.ts` / `tab-complete.ts` / `input-modes.ts`；`apps/cli/package.json` dependencies **零第三方 TUI 库**（仅 5 个 workspace 包）。
  3. **沿用事实**：M1 后（M2–M8）渲染架构未变，全部里程碑在此薄层上迭代（主题/键位/品牌标识等均为 additive）。
- 结案判定：Q-B3 的"M1 实验定"条件已满足——M1 已冻结验收（2026-09-08），实现按"自研薄层"路线成型并沿用至今；无待决内容，**结案**。

## 影响

- 本 ADR 为结案登记：不引入新需求、不改既有实现。
- v2.8 §14.2 表 Q-B3 条目加行内结案标注（工作区文档侧，原文保留）。
- 后续若变更 TUI 架构（如引入基座库），属新决策，须新 ADR。

## 引用

- v2.8 §14.2 行 590（Q-B3 原文/倾向）；`plan/T0-地基/M1-最小会话/M1-1-board.md`（WP-03 含 :38 参考行；WP-11）；产品仓 `apps/cli/src/render.ts`（首落 `120d6a3`）、`apps/cli/package.json`、`docs/dev/terminal-compat.md`（`dfcaf58`）；ADR-0046（结案先例形制）。
