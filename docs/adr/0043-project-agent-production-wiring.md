# ADR-0043: 项目级 agent 生产接线时序与整体替换语义（M4，v2.8 §11 SEC-070 行、§6 ORC-022 行；M4-1 板 WP-10 交付物）

- 状态：已接受（2026-09-14，M4-WP-10）
- 背景：M3-WP-09 留未解决①——`createSession` 同步 vs SEC-070 二次确认（`gateProjectAgentDefinitions.confirm`）异步的装配时序=本接线卡裁量；另 M3-WP-06 观察=注册表**整体替换语义**（同名高来源整对象覆盖，policy 覆盖后他字段丢失）、M3-WP-09 观察=gate 拒绝路**就地 mutation 入参 def**。三者在本卡一并处置。

## 决策

1. **同步启动 + 首轮异步补装** [自定]：`createSession` 保持同步（启动零阻塞，MCP `mcpReady` 不阻塞先例同族）——装配期 registry 只含 **built-in + plugin** 层（plugin 层=WP-09 装载件，本卡生产装配激活=M4-1 板头接缝④+WP-09 O3 义务）；项目层经 `session.agents.loadProjectAgents({confirm})` 异步补装，repl `runRepl` 于 SessionStart hook 后、首输入前调用一次。时序链=isTrusted（trust store/启动信任对话框产物，session.trust 承载）→ `loadProjectAgentDefinitions`（platform，同步读盘解析）→ `gateProjectAgentDefinitions`（harness 纯函数；提权字段无留痕时经 confirm UI 回调+`recordAgentTrust` 落盘）→ registry sources.project 注入。**未信任=整层不加载**（gate layerWithheld，"未信任时仅内置可用"=SEC-070 原文；plugin 层不受此门——其门=S-5 安装确认，WP-09 边界口径）。补装异常=吞错降级（零项目层+告警态，MCP 降级面同族），不阻塞会话。
2. **确认通道映射** [自定]：`ConfirmPrompt.confirm("agent:<name>", 提权字段清单) !== "deny"` 为真（once/always 皆批准——留痕 `agentTrust` 落 local 层后不再复问，无"总是/单次"差义）；非交互（confirm 通道缺席）=gate fail-closed 剥离提权字段（M3-WP-09 既有契约，定义本体保留可注册）。
3. **整体替换语义登记**（M3-WP-06 观察处置）：registry 每次装载**重建**（`createAgentRegistry` 构造期闭包 Map 不可变更）=整体替换语义原样保留并显式化——同名链位 built-in<plugin<project（ORC-022 优先级链段内位），高来源胜者**整对象**覆盖（被覆盖者字段不合并）。风险面（自定义件遮蔽内置 Explore 后 omit/tools 随本体走）在 SEC-070 二次确认+留痕+禁用位三重用户可控面内，不做合并语义（合并=隐式字段混合怪形状，ADR-0040 整对象裁决同向）。
4. **gate 入参新对象契约**（M3-WP-09 就地 mutation 观察处置）：接线层**每次装载重新读盘+解析**（`loadProjectAgentDefinitions` 产新数组新 def），跨门不复用上次 parsed——gate 拒绝路的字段剥离只污染当轮对象，下一轮从磁盘重建。行为断言=二次装载（先拒后批）提权字段完整复现。
5. **requiredMCP 校验段真接**（ORC-022:294"类型解析→requiredMCP 30s"段）：`SubagentDefinition.mcpServers?: string[]`=**名称引用**（字符串数组形；解析时非字符串条目丢弃+告警——内联对象形拒=dig-05 §2.4 :156421 boundDial"字符串名经磁盘配置解析"最小形 [自定]）。校验段契约：required 为空=直通；required 非空且 `pendingRequiredMcp` 钩子缺席=**拒绝**（fail-closed [自定]：永不来的服务器不配放行——M4 前恒跳过形态自本卡起仅适用于无 mcpServers 声明件）；钩子提供时 30s/500ms 轮询既有形制不变。cli 装配钩子=`required.filter(∉ session.mcpConnections connected)`（连接态每次调用实读；failed 亦计 pending——重拨退避面 [CC]-only 不做，B-03）。
6. **def 运行面三键消费**：`initialPrompt`=子代理首轮预热注入（messages 首条 user 载体，MEM-030 primed 形制同族 [自定]；不进 buildSubagentSystem=Golden 基线零影响）；`hooks`=frontmatter **单行 JSON 串**形 [自定]（splitFrontmatter 最小 YAML 子集不可达嵌套映射；settings.hooks 事件映射同形），经确认/留痕后于 spawn 注入该子代理执行面 HookEngine（source 标签=`"agent"`，decisionReason.hookSource 消费；未确认=gate 剥离 `def.hooks` 整键——提权字段剥离语义一致）；`isolation` 维持 M3 标记透传面（真 worktree=M5，卡边界）。
7. **禁用位**（M3-WP-09 未解决③清偿）：settings 键 `agents.projectDisabled: boolean`（缺省 false）[自定 键位；卡边界"[CC] env/settings 双形制只取 settings 键"]——真=项目层整体不加载（先于读盘，confirm 零调用，留痕不读写），`session.agents.state().disabled` 登记可见。**键位登记**（ADR-0030 附录 C 义务，ADR-0042 先例=随本卡结果页履行）：`agents.projectDisabled`（settings 键）。

## 影响的相邻机制

- session.ts：`SessionAgents` 门面（registry/loadProjectAgents/state/prepareSpawn）；`repl.ts` 首轮补装+/subtask 类型首词解析（`splitSubtaskType`，无匹配=现行为恒 general-purpose——usage 文案更新）；capabilities `hooks/config.ts` 来源类型加 `"agent"`（`HookSourceName = McpSourceName | "agent"`，SOURCE_HIGH_TO_LOW 尾位最低）。
- WP-11 基准（custom agent 端到端任务）消费面=本卡 `session.agents`（装配函数导出可注入桩）。

## 参考

- v2.8 §11 SEC-070（:459 原文）/§6 ORC-022（:294 段序）/§12.5 接缝④；M3-1-results §WP-09 未解决①②③+§WP-09 核验 mutation 观察+§WP-06 复验整体替换观察+§G 门审移交清单"接线卡义务"；A 级 dig-05 §2.4 :156421-156425（boundDial 字符串名形）。其余 [自定]。
