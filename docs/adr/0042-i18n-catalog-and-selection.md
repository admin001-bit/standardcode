# ADR-0042: i18n catalog 形状与选择链（M4，v2.8 §8.5 ECO-010~012 行、§5.2 platform-services 行 i18n L6）

- 状态：已接受（2026-09-13，M4-WP-07）
- 规格处置：v2.8 §8.5「ECO-010~012 基准语言 English；技术术语保留英文；English 标准包 + Simplified Chinese 汉化包（M4）」——条目仅一行，**未覆盖级**（B-06）→本 ADR 承载设计。本地无 [CC] i18n 机制一手（附录 F 指针无此模块；模板层与代码层均未检出 i18n 体系）→**设计全 [自定]**。

## 决策

1. **catalog 形状**：单文件 `packages/platform/src/i18n.ts` 内双常量对象——`EN`（基准，全量）与 `ZH_CN`（汉化包，键集合 MUST 与 EN 全等）。键=点路径字符串（`cmd.<name>.desc` / `cmd.<name>.usage` / `repl.<topic>.<detail>`），值=最终渲染文案（含参数占位时经 `t(key, params)` 的 `{name}` 形插值）。**单一事实源=EN catalog**：命令 description/usage 的英文文案唯一定义于此，commands.ts 经 `tEn(key)` 模块级直读（en 与运行环境无关，模块级求值稳定）。
2. **选择链**（DoD②）：`env STANDARD_CODE_LANG`（合法值 `en`|`zh-CN`；非法值=告警+回退 en，fail-closed）> `settings.language`（同值域；ADR-0030 键位登记义务）> 缺省 `en`。运行时经 `resolveLang(env, settingsValue)` 求值；**不做 locale 自动探测**（卡边界）。语言为会话级快照（装配时定），无热切换命令（§8.2 M4 命令分期无 /language，B-03 不注册）。
3. **缺失策略**（DoD③）：`t(key)` 在当前包无键→回退 EN 同键；EN 亦无→返回 key 本身+一次性告警（进程内 Set 去重）。测试钉 ZH_CN/EN 键集合全等。
4. **收敛范围裁定**（DoD④ "渲染面" 的可操作化 [自定]）：M4 首批收敛=①命令面全量（28 条 description/usage）+/help 头/Tab hint ②命令 execute 参数错误文案（throw 面约 25 条）③repl 核心状态行（[done]/[error]/[command] unknown/[shell]/[model]/[permission] 等 ~15 条）。**repl 其余渲染行与平台导出=M7**（卡边界"不做 i18n 平台导出（M7）"同族分期，本 ADR 登记）。硬编码残留守卫（DoD④ 实现选择 [自定]=grep 型）：守卫测试以源码正则提取 commands.ts 全部 `description:`/`usage:` 字面量，逐一断言"该字面量 ∈ EN catalog 值集"——命令面可穷举、可机器钉死；repl 收敛行以 t() 键存在性测试覆盖。
5. **技术术语保留**（DoD⑥ [自定]）：ZH_CN 包内 model/tool/provider/MCP/skill/hook/plugin/token/cache 等术语保留英文原形（清单 `I18N_TERMS_KEEP` 常量+抽查断言）。
6. **Golden/prompt 零影响**（DoD⑤）：i18n 只触 L0 渲染面（用户终端输出），系统提示词/工具描述/模型输出不译（卡边界）——不进 prompt 装配链，L2 字节一致性守卫（golden antifab）零改动复用。

## 影响的相邻机制

- commands.ts：`description`/`usage` 改经 `tEn(key)`（模块级 en 求值）；execute 内错误文案经 `t(key)` 运行时求值（lang 会话级快照）。
- repl.ts：核心状态行经 `t(key)`；/help、Tab hint 经 `t()` 渲染。
- ADR-0030 键位全集增补：`language`（settings 键）与 `STANDARD_CODE_LANG`（env 逃逸舱，MDL-010~013 同族）——附录 C/键位登记义务随本卡结果页履行。

## 参考

- v2.8 §8.5/§5.2 行；卡 WP-07 DoD①-⑥；无外部一手锚（全 [自定]）。
