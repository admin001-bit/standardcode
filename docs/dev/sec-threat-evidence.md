# SEC 威胁表逐行对策证据（M5-WP-05 交付物）

> 规格：`D:\StandardCode\StandardCode_v2.8.md` §11（行 437-460）。逐行三列=对策条目号/实现指针/测试指针；指针行号以本表落盘 commit（WP-05）为准，漂移按勘误纪律登记不回改。
> 审计方法（DoD② 审计先行）：逐行枚举既有实现与测试（grep 全仓+亲读），不预设缺集；缺口集见文末审计遍记录。

## S-1~S-10 逐行证据

| # | 威胁（§11 行 443-452） | 对策条目 | 实现指针 | 测试指针 |
| :-- | :-- | :-- | :-- | :-- |
| S-1 | 提示注入（web/MCP/文件/记忆内容） | SEC-010 | 外部内容一律 isMeta `<system-reminder>` user 消息前插（追加式不改写原消息）：`packages/context/src/prompt-layout/layout.ts:78-81`、类型 `packages/context/src/prompt-layout/types.ts:16-18`；注入消费面=`apps/cli/src/repl.ts`（skills 清单/MCP 通知/memory 索引同载体）；高危动作仍过仲裁（S-2 链） | `packages/context/test/prompt-layout.test.ts` |
| S-2 | 数据外泄 | 权限仲裁（§8.3）+managed deny | 全部外发通道（工具执行）经 broker 评估序 deny→ask→allow 首匹配：`packages/harness/src/permission-broker/index.ts:230-256`（B-13 deny 恒赢）；managed 源=`packages/platform/src/settings.ts:47-58`（五来源最高位，deny 列表键合并 `:26-32`）；**企业档可禁 Web 类工具=managed deny 规则能力面**（规则链已足，不造企业专用开关 [自定] WP-05 边界登记） | `packages/harness/test/permission-broker.test.ts`（deny 恒赢/评估序）+`apps/cli/test/session-trust.test.ts` |
| S-3 | MCP 供应链 | 安装确认+来源持久+默认 ask | 连接批准状态机+批准库留痕（ADR-0037）：`packages/platform/src/mcp-trust.ts`+`apps/cli/src/session.ts:800-810`（recordMcpTrust）；MCP 工具缺省 ask=经 full name 走 broker 评估序无自动放行：`packages/capabilities/src/mcp/tools.ts:5` | `packages/platform/test/mcp-trust.test.ts`+`apps/cli/test/wp02-mcp-session.test.ts`+`apps/cli/test/wp03-mcp-trust.test.ts` |
| S-4 | Hook 任意代码执行 | SEC-020 fail-closed+信任门 | 信任门未接受跳全部：`packages/capabilities/src/hooks/engine.ts:222-226`（:262013 同构）；hook 错误 fail-closed=PreToolUse 超时/异常→deny：`engine.ts:324-332`（:61919）；deny 恒赢 RANK 聚合 `:60-61`；M5 WP-04 总闸 OR 延伸覆盖 agent 级引擎（disableAllHooks）：`apps/cli/src/session.ts:661-670`+`engine.ts:221` | `packages/capabilities/test/hooks-engine.test.ts`+`apps/cli/test/wp04-hooks-session.test.ts`+`apps/cli/test/wp04-security-triad.test.ts` |
| S-5 | Skill/Plugin 投毒 | 安装确认+清单展示+allowed-tools 白名单 | 技能信任门前置（SEC-070）：`packages/capabilities/src/skills/discovery.ts`（trusted 参数）；allowed-tools 白名单收窄（toolFace，Skill 恒保留）：`apps/cli/src/session.ts:748-756`；plugin 安装确认门先于任何写盘：`packages/platform/src/plugin/installer.ts:189`；清单展示=`apps/cli/src/repl.ts`（/skills /plugin list 面） | `packages/capabilities/test/skills.test.ts`+`apps/cli/test/wp05-skills-session.test.ts`+`apps/cli/test/wp09-plugin.test.ts` |
| S-6 | 密钥泄露 | SEC-030 优先级链+疑似密钥告警+脱敏 | 优先级链 keychain>env>settings：`packages/platform/src/keychain.ts`（链首读面适配器，win32=unavailable fail-open [自定]）→`apps/cli/src/session.ts:820-832`（buildProvider 链序，:826 keychain 链首）；疑似密钥告警（≥20 字符赋 KEY/TOKEN/SECRET 类命名键→警告+建议 keychain）：`packages/platform/src/settings.ts:198-215`（scanSuspectedSecrets，:190 调用点）；转录脱敏=值替换：`packages/platform/src/session-store.ts:29-31,246-252`；遥测脱敏随 SEC-050 载体（WP-06，默认关）；日志面=SEC-080 env 剥离（无独立日志密钥通道） | `packages/platform/test/keychain.test.ts`+`packages/platform/test/settings.test.ts`（SEC-030 describe）+`packages/platform/test/session-store.test.ts` |
| S-7 | 提权逃逸 | 护栏常驻+元数据保护+symlink 拒绝 | 护栏独立于沙箱常驻：`packages/platform/src/guard-path.ts:107-133`（EXE-020 工具层权威判定 `:156-185`）；元数据目录保护：`guard-path.ts:10,118-131`+沙箱层叠加（`crates/sandbox/src/policy.rs` protected_names `.git/.standardcode`）；symlink 拒绝（Codex 测试范本）：`crates/sandbox/src/compile.rs:83,912`（DeepSymlink 拒/顶层别名许） | `packages/platform/test/guard-path.test.ts`+`crates/sandbox/src/compile.rs`（快照测 `three_tiers_shapes`/`symlink_rejected_top_alias_allowed`，cargo test） |
| S-8 | 恶意工作区 | UI-061 信任对话框+未信任共享设置不生效 | 信任位以 git 仓库根为密钥：`packages/platform/src/trust.ts`（isTrusted/acceptTrust）；信任门控共享设置（allow/env/additionalDirectories 剔除，deny/ask 保留）：`trust.ts:20-23`（isTrustGatedKey）+applyTrustGate；项目级 agent 按 SEC-070 | `packages/platform/test/trust.test.ts`（三断言）+`apps/cli/test/session-trust.test.ts` |
| S-9 | 持久化提权（.bashrc/PowerShell profile/cron/PATH 内脚本/git hooks） | EXE-020 护栏清单（行 451 枚举原文） | 高危持久化清单：`packages/platform/src/guard-path.ts:21-35`（PERSISTENCE_PATH_FRAGMENTS=§11 行 451 五类枚举）+PATH 目录写入 `:38-50`+全局包管理器命令形 `:179-181`；命中=confirm 强制确认且 **Auto mode not exempt**（detail 原文 `:116`）；Auto 豁免面强制=allow 降 ask：`packages/harness/src/tools.ts:178-194`（bypassPermissions 亦不豁免） | `packages/platform/test/guard-path.test.ts`（S-9 describe 逐类含 cron/systemd/LaunchAgents 写面+detail 原文断言）+`packages/harness/test/permission-broker.test.ts:163-171`（guard confirm→allow 降 ask，S-9 Auto 不豁免） |
| S-10 | 会话转录落盘敏感面 | 文件权限 0600 语义+/doctor 提示+写入前脱敏 | 权限收紧：`packages/platform/src/session-store.ts:38-44`（chmod 0600，缺省开，win32 语义面如实降级）；写入前密钥值替换脱敏：`session-store.ts:29-31`（redactSecrets→`[REDACTED]`）+`:246-252`（逐 block 遍历）；/doctor 清理提示=转录枚举+体积+超限提示：`apps/cli/src/repl.ts:313-321` | `packages/platform/test/session-store.test.ts`+`packages/platform/test/transcripts.test.ts` |

## SEC 全章条目对账（010/020/020b/030/040/050/060/070/080）

| 条目 | 状态 | 载体指针 |
| :-- | :-- | :-- |
| SEC-010 | ✅ 落地 | isMeta 同构载体=S-1 行实现/测试指针（M2/M3 起常态面） |
| SEC-020 | ✅ 落地 | deny 恒赢 fail-closed=broker 评估序+hooks fail-closed+S-4/S-9 行指针（M1/M2/M4） |
| SEC-020b | ✅ 本卡清偿（WP-05） | settings env 注入键黑名单（PATH/LD_PRELOAD/NODE_OPTIONS 禁经项目级源）：`packages/platform/src/settings.ts:236`（SEC_020B_BLOCKED_ENV_KEYS）+`:245-286`（applySettingsEnv 拒注入+告警，:273 黑名单判定）；managed/user/flag 源不设限 [自定] | 
| SEC-030 | ✅ 本卡清偿（WP-05） | 优先级链=keychain.ts+buildProvider 链序；疑似密钥告警=scanSuspectedSecrets；脱敏=转录 redact（S-6/S-10 行）；遥测脱敏随 WP-06 载体 |
| SEC-040 | ◐ 载体=WP-07（待执行） | 产物 checksum 半随发布工程（附录 E）；签名半按 Q-7 倾向落 ADR-0044（WP-07 交付物） |
| SEC-050 | ◐ 载体=WP-06（待执行） | 遥测默认关/opt-in：当前态=全仓零遥测上报路径（WP-06 DoD⑥ grep 守卫将钉死）；脱敏单源随 WP-06 接缝⑮ |
| SEC-060 | ✅ 落地 | `SECURITY.md`（仓库根，M3-WP-12：SEC-060 三要素） |
| SEC-070 | ✅ 落地 | 项目级扩展信任门：M3-WP-09（agent/skill 加载门）+M4-WP-10（生产闭环 gate/留痕/剥离）；指针=S-5 行+`apps/cli/src/session.ts:662` |
| SEC-080 | ✅ 落地 | 工具子进程 env 清洗：`packages/executor/src/env.ts:37-62`（TOOL_ENV_STRIP_RULES/sanitizeToolEnv）+`packages/platform/src/env-baseline.ts:4-9`（ENV_BASELINE_STRIP 共享面）+M5-WP-03 接缝⑭双闸（宿主清洗+server 策略剥） |

## 审计遍记录（DoD②；2026-09-17 WP-05 X 执行）

- 审计范围：§11 行 443-452 十行+行 454-460 九条目；方法=全仓 grep 关键词族（isMeta/BASH_ENV/keychain/redact/bashrc/guard/0600/SECURITY 等）+逐文件亲读+测试指针亲验存在。
- 审计输出（实缺集，均已本卡清偿）：①SEC-020b 黑名单缺（applySettingsEnv 无黑名单，项目级可注入 PATH/LD_PRELOAD/NODE_OPTIONS）②SEC-030 疑似密钥告警缺（全仓零命中）③SEC-030 keychain 链首缺（此前仅 env>settings）④S-9 逐条断言缺口（cron 写面用例缺+detail 未钉"Auto mode not exempt"原文）。
- 既有面确认非缺：S-9 主体（M1-WP-09+M1-WP-07 扩）、S-10 三件、SEC-060（根 SECURITY.md）、S-3/S-4/S-5/S-7/S-8 各 M 档案指针如上表。
- [自定] 登记族：S-2 企业档=managed deny 能力面；SEC-020b 级别域（项目级源禁、managed/user/flag 许）+类边界=spec 点名三键；SEC-030 keychain=读面适配器（macOS security/Linux secret-tool；win32 unavailable fail-open）+负缓存=适配器实例级+缺省适配器模块级单例；疑似密钥分词边界判定（camelCase 切分防 monkey 误报）；审计未见之表外威胁行不新增（卡边界）。
