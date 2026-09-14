# ADR-0042: i18n catalog 形状与选择链（M4，v2.8 §8.5 ECO-010~012 行、§5.2 platform-services 行 i18n L6）

- 状态：已接受（2026-09-13，M4-WP-07）
- 规格处置：v2.8 §8.5「ECO-010~012 基准语言 English；技术术语保留英文；English 标准包 + Simplified Chinese 汉化包（M4）」——条目仅一行，**未覆盖级**（B-06）→本 ADR 承载设计。本地无 [CC] i18n 机制一手（附录 F 指针无此模块；模板层与代码层均未检出 i18n 体系）→**设计全 [自定]**。

## 决策

1. **catalog 形状**：单文件 `packages/platform/src/i18n.ts` 内双常量对象——`EN`（基准，全量）与 `ZH_CN`（汉化包，键集合 MUST 与 EN 全等）。键=点路径字符串（`cmd.<name>.desc` / `cmd.<name>.usage` / `repl.<topic>.<detail>`），值=最终渲染文案（含参数占位时经 `t(key, params)` 的 `{name}` 形插值）。**单一事实源=EN catalog**：渲染面键值唯一定义于此；commands.ts description/usage 为**运行时 getter**（`t(cmd.*.desc)`，active lang 由 configureI18n 于会话装配同步——复验 R3 修复：模块级 tEn 使 zh 下命令面永远英文，已废弃该形制）；tEn 保留为缺省 en 直读工具。【勘误 2026-09-14：本段随 R3 清偿更新，原 tEn 模块级直读表述作废】
2. **选择链**（DoD②）：`env STANDARD_CODE_LANG`（合法值 `en`|`zh-CN`；非法值=告警+回退 en，fail-closed）> `settings.language`（同值域；ADR-0030 键位登记义务）> 缺省 `en`。运行时经 `resolveLang(env, settingsValue)` 求值；**不做 locale 自动探测**（卡边界）。语言为会话级快照（装配时定），无热切换命令（§8.2 M4 命令分期无 /language，B-03 不注册）。
3. **缺失策略**（DoD③）：`t(key)` 在当前包无键→回退 EN 同键；EN 亦无→返回 key 本身+一次性告警（进程内 Set 去重）。测试钉 ZH_CN/EN 键集合全等。
4. **收敛范围**（DoD④"渲染面"全量——复验 R1 裁定：B-06 可操作化不得缩小 DoD 字面，原"repl 其余行推 M7"分期裁定撤销）：①命令面全量（28 条 description+15 条 usage 运行时 getter；13 命令 usage 字段缺席形）②命令 execute 参数错误 throw 全量 ③repl 全部固定文案写点与 throw 模板（doctor/status/usage/mcp/skills/memory/resume/config/cd/add-dir/reload/subtask/effort/init/tasks/background/hooks/shell/file/command-unknown/compact/provider/model-header 等；en 值=现文本逐字零行为变化，中英混排既有基线的纯英化另列策略决定留 G）④死键守卫（全 catalog 键必被消费，动态拼装基名豁免=repl.mcp.done.* 四键显式清单）+写点三路扫描守卫（双引号/反引号模板头/throw；反引号路第四轮勘误=原 $ 尾锚死代码改正字符类定界，模板中部固定片段暂不扫——resume 索引列 (no title)/msgs, last 系数据回退形，登记留 G）。平台导出（译员工作流）=M7 不变（卡边界原义）。【勘误 2026-09-14：R1 清偿随修】
5. **技术术语保留**（DoD⑥ [自定]）：ZH_CN 包内 model/tool/provider/MCP/skill/hook/plugin/token/cache 等术语保留英文原形（清单 `I18N_TERMS_KEEP` 常量+抽查断言）。
6. **Golden/prompt 零影响**（DoD⑤）：i18n 只触 L0 渲染面（用户终端输出），系统提示词/工具描述/模型输出不译（卡边界）——不进 prompt 装配链，L2 字节一致性守卫（golden antifab）零改动复用。

## 影响的相邻机制

- commands.ts：`description`/`usage` 改运行时 getter `t(key)`（active 单例由 configureI18n 同步——复验 R3 勘误取代原"tEn 模块级直读"表述）；execute 内错误文案经 `t(key)` 运行时求值（lang 会话级快照）。
- repl.ts：核心状态行经 `t(key)`；/help、Tab hint 经 `t()` 渲染。
- ADR-0030 键位全集增补：`language`（settings 键）与 `STANDARD_CODE_LANG`（env 逃逸舱，MDL-010~013 同族）——附录 C/键位登记义务随本卡结果页履行。

## 参考

- v2.8 §8.5/§5.2 行；卡 WP-07 DoD①-⑥；无外部一手锚（全 [自定]）。
