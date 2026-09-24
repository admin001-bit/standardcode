# 接缝清单与差异登记

> 复制自 `D:\StandardCode\StandardCode_v2.8.md` §12.5（2026-09-07，WP-07 迁移，逐字保留，原文为准；两份登记随实现更新于本文件）。

### 12.5 接缝清单与差异登记 `[新增]`（治"抄作业没抄全"）

[CC] 的机制是互相咬合的，只抄一半会在接缝处断裂。MUST 维护两份登记：

1. **接缝清单（seam inventory）**：跨模块咬合点逐条列出，每条=定义+锚点+测试。首批：①流式工具执行器 × isConcurrencySafe × tool_result 保序回填；②cacheScope × AutoCompact × TTL 双通道；③权限仲裁 × hooks × 沙箱三层裁决顺序；④agent 优先级链 × 插件注入点；⑤恢复链 9 级 × stop_reason 协议映射（Anthropic stop_reason 与 OpenAI finish_reason 非一一对应——如 `pause_turn` 无对应物，映射表在 L5 实现）。
2. **差异登记（deviation log）**：凡与参考实现不同的细节，登记 {原版锚点 → 修改点 → 理由 → 影响的相邻机制}。

## 接缝⑥ reactive 瀑布 × 恢复链② × 流级路径（2026-09-09，WP-05 R1 修复补登）

- 定义：prompt-too-long（ProviderError.kind=context_length）在 catch 路径先走 reactive 瀑布（LoopOptions.reactive：decide=nextReactiveStep 状态机、apply=cleanup/collapse 收缩闭包，auto-compact 级 exhausted 落 autocompact 路由），事件 reactive_step（tokenGap=used−window）逐级上屏；瀑布解决则不压缩。
- 锚点：CTX-037（v2.8:327）+A 级报告 §2.4 reactive 行；ADR-0036（collapse 未覆盖级）。
- 测试：packages/harness/test/reactive-route.test.ts（5 例：触发+tokenGap/升级序/exhausted 落协调器/瀑布先于 auto-compact/未配置原行为）。
- 未解决：流级 streamError 路径（agent-loop.ts:255-263【勘误 2026-09-09：原文 225-233 因同提交插入 30 行漂移，复验勘误③】）仍无条件 context_exhausted——reactive 未接（WP-05 边界登记，留 G 门）。

## 接缝③ 权限仲裁 × hooks ×（沙箱 M5 空位）三层裁决序（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：§5.4 工具生命周期实装序=schema 校验 → PreToolUse hooks 裁决 → 权限仲裁 → 执行 → 回灌；hooks 多裁决聚合 deny > defer(≡ask) > ask > allow 严重度只升不降、deny 恒赢；第三层沙箱 M4 不实现留空位（M5，v2.8 §0.5 B-03）。
- 锚点：v2.8 §5.4/§8.3（聚合 `_440.js:263188-263208`）；dig-04 §3.5 RANK `:60861`；实现 packages/harness/src/tools.ts:148（WP-04 执行回路）+packages/capabilities/src/hooks/engine.ts。
- 测试：apps/cli/test/wp04-hooks-session.test.ts:109（schema 先于 PreToolUse=坏输入 hook 不触发）+packages/harness/test/agent-loop.test.ts:136（新序断言，旧序"权限先于 schema"内联勘误）+packages/capabilities/test/hooks-engine.test.ts（RANK 聚合/退出码协议）。
- 未解决：disableAllHooks 总闸不约束 agent 级 hooks 引擎（WP-10 O1 fail-open 方向，G 定夺）；父→子全局 hooks 传播未接（WP-04 偏差⑥+WP-10 未解决②，G）。

## 接缝④ agent 优先级链 × 插件注入点（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：注册表链位低→高=built-in < plugin < user < project < flag < policy（ORC-022 原文 policy > flag > project > user > plugin > built-in）；plugin 层 M4 激活=WP-09 四组件各注入口（agents 直喂 plugin 层/skills→WP-05 plugin 源/hooks→WP-04 配置源尾位/mcpServers→WP-01 loader plugin 合并位）；生产装配（装配期 built-in+plugin 层，project 层 gate 确认后补装）=WP-10。
- 锚点：v2.8 §6 ORC-022、§9.3 ECO-033、ADR-0043 决策 1；实现 packages/harness/src/agent-registry.ts:9-11（AGENT_SOURCE_ORDER）+apps/cli/src/session.ts:314（生产装配调用点）。
- 测试：packages/harness/test/agent-registry.test.ts:117/:121/:147（链位/六层逐层覆盖语义/高来源覆内置）+apps/cli/test/wp09-plugin-session.test.ts:124（session.plugins.agents() 直喂注册表三层链位）+apps/cli/test/wp10-agent-wiring.test.ts:120（未信任=仅内置+plugin，生产路径端到端）。
- 未解决：无新增（WP-09 O3"registry 生产装配含 plugin 层"已随 WP-10 清偿）。

## 接缝⑩ ORC-022 requiredMCP 校验段 × MCP 客户端 × 任务注册表（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：两面——①spawn 校验序列"类型解析→requiredMCP 30s"真消费：def.mcpServers 名称引用（dig-05 :156421 boundDial 形）→session 连接态投影（connected 清空；failed/缺席=pending 恒含）→30s 超时拒绝；无钩子=fail-closed 拒绝，防恒跳过回潮；②MCP 工具调用 120s 转后台复用 M3 task-registry/TaskStop（WP-02，detach-on-flip 后前台中断不杀后台）。
- 锚点：v2.8 §6 ORC-022（:294 段序）、§5.3(4)；ADR-0040（配置载体）/ADR-0043 决策 5（fail-closed 契约）；dig-05 §3.2 `:293505`（转后台文案形状）。
- 测试：apps/cli/test/wp10-agent-wiring.test.ts:205（投影+注入时钟超时拒绝）/:227（段③ Agent(X) deny）+packages/capabilities/test/mcp-tools.test.ts:219/:247/:273（registry 落账/R1 回归前台中断不杀后台/TaskStop 取消链）。
- 未解决：模型侧 Agent 工具面的校验段供给口径（WP-10 未解决①，G）。

## 接缝⑪ Skill 清单/记忆维护段 × prompt-layout 追加不改写（CTX-005）× 前缀稳定（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：skills 清单与自动记忆索引注入共用载体=turn 首 meta user 追加消息，既有前缀字节不动；清单首轮全量、后续 per-agent 增量去重（缓存命中守卫）；记忆轨 hash 增量（内容未变不重发）。
- 锚点：v2.8 §5.2 prompt-layout 行（CTX-005）、§9.1 ②；dig-06 §4.1 `:318109`（清单 meta 消息形状）；实现 packages/context/src/memory-loader/automemory.ts:7（同载体注记）。
- 测试：packages/context/test/prompt-layout.test.ts:75（CTX-005 追加不改写=引用/字节守卫）+apps/cli/test/wp05-skills-session.test.ts:112（首轮全量 meta/二轮 per-agent 不重发）+apps/cli/test/wp06-memory-session.test.ts:98（hash 增量二轮不重发+system 纪律段）。
- 未解决：子代理清单注入未接（WP-05 偏差⑩与 WP-06 偏差⑨同面，:156977 传播口径，G）。

## 接缝⑫ 记忆索引 × 多会话并发写（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：memory 目录多会话并发写经 M2 SessionLock（acquireIn 互斥）串行化，锁不可用=降级形制照 ADR-0031。
- 锚点：v2.8 §9.1/§9.2、§12.5 接缝⑫；ADR-0031（session-lock-and-degrade）。
- 测试：apps/cli/test/wp06-memory-session.test.ts:129（"接缝⑫：memory 目录并发写经 SessionLock"最小断言，DoD⑦）。
- 未解决：无。

## 接缝⑬ hook/skill 执行子进程 × SEC-080 env 清洗（2026-09-15，WP-12 随 M4-1 板补登）

- 定义：执行外部可控代码的子进程面（hooks command 子进程/plugin git clone/updater npm）env 一律过 SEC-080 基线剥离（STANDARD_CODE_*/KEY/TOKEN/SECRET/GIT_CONFIG_*/NODE_OPTIONS/BASH_ENV/ENV 剔，PATH/HOME 留），fail-closed 方向；skill shell 预执行缺省关=策略剥离（ubo 形状）不启子进程；剥离规则单一事实源=platform env-baseline（installer/updater/plugin 多消费者共享面，防双份漂移）。
- 锚点：v2.8 §11 SEC-080；dig-04 §7 安全清单；实现 packages/capabilities/src/hooks/engine.ts:90+packages/platform/src/env-baseline.ts。
- 测试：packages/capabilities/test/hooks-engine.test.ts:170（hook 子进程密钥剔除/PATH 在位）+packages/platform/test/wp08-updater.test.ts:87/:103/:118（剥除规则/共享化回归/runner 交付）+packages/platform/test/wp09-plugin.test.ts:164（clone env 剥离）。
- 未解决：无（WP-08 V 针 C 变异横红双消费者=共享面判别实锤）。

## 接缝③（M5 沙箱落地更新，2026-09-17，WP-10 补登——M4 原条目见上，既有行零触碰，本条为落地补充）

- 定义：M4 条目留出的第三层沙箱空位已落地——执行序=guard 硬停（EXE-020 行 429 护栏独立于沙箱常驻）→ schema 校验 → PreToolUse hooks 裁决（deny 恒赢、严重度只升不降）→ 权限仲裁 → guard confirm → **沙箱执行**（默认关，`-sdb` 旗标/settings 键显式开，开启默认档 workspace-write；`.git/hooks`、`.standardcode` 元数据路径默认禁写）；后端拉起/握手失败=执行拒绝非绕过（fail-closed，B-12）；thinking/stdout 不截断不过滤。
- 锚点：v2.8 §5.3(3)（三档策略）/§5.4（执行序）/EXE-010~012/ENG-072/B-12；实现 packages/harness/src/tools.ts:148（执行回路）+packages/executor/src/bash.ts:21/:67/:71（沙箱臂）+packages/executor/src/sandbox/client.ts:256（createSandboxHandle）+crates/sandbox/src/serve.rs:47（spawn+policy）。
- 测试：apps/cli/test/wp03-sandbox-config.test.ts:8/:13/:17（全缺省关/旗标开且默认档 workspace-write/settings 独立开）+apps/cli/test/wp03-sandbox-integration.test.ts:44/:59/:68/:102（越界写拒且可诊断/元数据禁写/文件写面/fail-closed）+packages/executor/test/wp03-sandbox-routing.test.ts:29/:34（无 sandbox 零经手/env 与退出码同形）。
- 未解决：Windows deny-read 需 elevated（首版按非 elevated 常态档，BLK-04=① 三段形终态）；elevated 路线并入实机回归清单（提权渠道到手后 `--ignored` 补跑）。

## 接缝⑭ 沙箱 × SEC-080 env 清洗（2026-09-17，WP-10 补登）

- 定义：入沙箱执行路径同经 SEC-080 清洗，禁"开沙箱即豁免"——宿主侧先剥离（工具子进程 env 基线：STANDARD_CODE_*/KEY/TOKEN/SECRET/GIT_CONFIG_*/NODE_OPTIONS/BASH_ENV/ENV），沙箱 server 侧再按策略剥离代理族（策略 net=deny 时 HTTP(S)_PROXY/ALL_PROXY/NO_PROXY 不外逃=WP-02 DoD⑤ 代理 fail-closed）；env 未设=默认不开启（透传语义）。两闸独立可验、规则单一事实源。
- 锚点：v2.8 §11 SEC-080、§5.3(3) 教训清单；实现 packages/platform/src/env-baseline.ts:7（stripEnvBaseline，installer/updater/plugin 共享单源）+crates/sandbox/src/run.rs:18（PROXY_ENV_KEYS 策略剥离）+packages/executor/src/sandbox/client.ts（请求 env 透传）。
- 测试：packages/executor/test/wp03-sandbox-routing.test.ts:45（接缝⑭：SEC-080 剔除键不入沙箱请求，代理键由 server 策略闸承担=双闸归位）+packages/platform/test/wp08-git-net.test.ts（策略透传语义：代理族不在剥离面、env 未设=默认不开启）。
- 未解决：无。

## 接缝⑮ 遥测 × 转录 × 脱敏（2026-09-17，WP-10 补登）

- 定义：转录落盘与遥测事件体共用 SEC-030 同一脱敏单源函数（session-store `redactSecrets`），非各自复制实现；遥测侧经 `sanitizeProps` 对事件体字符串属性逐值过同一函数，键名不脱敏（固定枚举）；关态零构造=无脱敏调用面。
- 锚点：v2.8 §11 SEC-030 行 457/S-10 行 452；实现 packages/platform/src/session-store.ts:29（redactSecrets 单源）+packages/platform/src/telemetry.ts:14（自 session-store 导入）/199-203（sanitizeProps 逐值调用）。
- 测试：packages/platform/test/telemetry.test.ts:127/:128（事件体字符串值经 redactSecrets，sk- 形状→SECRET_PLACEHOLDER）/packages/platform/test/telemetry.test.ts:134（结构证据：telemetry.ts 自 session-store.ts 导入=单源非复制）+packages/platform/test/session-store.test.ts:58（转录侧形状白名单脱敏）+evals/benchmark/tasks.ts b23/b24（recorded 族同面对位：疑似密钥告警+redactSecrets 幂等 / 遥测门序+事件体脱敏）。
- 未解决：无。

## 接缝⑰ workflow vm 沙箱 × resume 缓存（2026-09-19，WP-12 随 M6-1 板补登）

- 定义：vm 沙箱内禁 `Date.now()`/`Math.random()`/无参 `new Date()`（context 内守卫 prelude，`configurable:false` 防 delete 回落）不是独立洁癖——journal resume 的 key 派生（`wfkey-`+sha256(规范 JSON([prompt,opts])) 前 16 hex）以"同输入必同 key"为前提，脚本可注入时间/随机源即键不稳定、跨 run 必不命中（续跑重复消耗）。判据双向：注入计数器/随机源→假命中红；生产键掺 `Date.now()`→命中类断言全红。
- 锚点：v2.8 ORC-023/024（行 295「vm 沙箱（`__proto__:null` + 禁 `Date.now/Math.random`）+ journal 续跑」同条并列）+§12.5 接缝⑰；A 级 workflow 报告 §2.3（L171026 禁项理由=break resume）；实现 packages/capabilities/src/workflow/sandbox.ts:59/:62/:132（守卫文案与 prelude）+workflow/journal.ts:255-261（defaultWorkflowAgentKey）/:337（keyDerivation 注入位=接缝⑰ 变异面）。
- 测试：packages/capabilities/test/wp04-workflow-journal.test.ts:367（DoD⑤ 接缝⑰：注入时间/随机源 → resume 缓存必不命中，双向）+wp02 沙箱套件三禁用例（packages/capabilities/test/wp02-workflow-sandbox.test.ts）。
- 未解决：无（WP-04 V 核销双向确证）。

## 接缝⑱ workflow budget × 主循环 token 池（2026-09-19，WP-12 随 M6-1 板补登）

- 定义：workflow token budget 硬顶与主循环同轴（共享 token 池）；内核硬顶语义=只止新发、在途跑完保留结果（`WorkflowBudgetError` 文案同构 A 级 §6）；`total=null → remaining()=Infinity`。记账单源由宿主注入（`spent()` 注入面），内核不累计子 agent token——共享池的并入点在装配层（未接线，M6 统一接线义务）。
- 锚点：v2.8 ORC-023/024（行 295 budget 硬顶）+§12.5 接缝⑱；A 级 workflow 报告 §6（L168064-168076、L169801-169806）；实现 packages/capabilities/src/workflow/kernel.ts:70（WorkflowBudgetError）/:322-331（超顶判定只止新发）。
- 测试：packages/capabilities/test/wp03-workflow-kernel.test.ts:176/:187（超顶零新 spawn+在途保留）+apps/cli/test/wp11-workflow-telemetry.test.ts:84/:85（真内核 budget 硬顶→桥→facade sink 实收）。
- 未解决：`spent()` 生产装配位（M6 统一接线义务，WP-03 V 存疑③同源）。

## 接缝⑲ Teams 消息泵 × 任务注册表 × subagent 生命周期（2026-09-19，WP-12 随 M6-1 板补登）

- 定义：消息工具负责通知、任务工具负责状态——看板全变更零 mailbox/inbox 投递、收消息全链任务字段零改动（双向互不承载）；状态通知=进程内 `updated` 事件≠消息；停止 worker 按 agentId 续聊=从转录恢复（SendMessage 投递进 inbox＋续聊种子读 per-agentId 转录，六阶段 fail-closed 逐一点名）。
- 锚点：v2.8 ORC-040~042（行 296）+§12.5 接缝⑲；A 级 teams 报告 §8（「a send resumes it from its transcript」实锚 `_440.js` L208382）；实现 packages/capabilities/src/teams/task-board.ts+teams/worker-resume.ts+teams/events.ts。
- 测试：packages/capabilities/test/wp09-teams-task-board.test.ts:208（接缝⑲ 双向举证）/:307（写入 emits updated=事件≠消息）+packages/capabilities/test/wp09-worker-resume.test.ts:296（续聊不改任务状态）。
- 未解决：per-agentId 转录生产者与 loop 灌回（M6 统一接线义务，WP-09 F1/F2）。

## 接缝⑳ SendMessage 载体 × transcript 存储（2026-09-19，WP-12 随 M6-1 板补登）

- 定义：跨 teammate/跨会话 SendMessage 载体=本地 transcript 存储目录基座上的文件 mailbox（`<teamsDir>/<净化 team>/<净化成员>.inbox.json`，顶层数组+schema 校验、非法条目丢弃并告警禁静默）+事件总线（in-process 泵/回灌），与 ORC-041 同协议；teamsDir 路径单源在 platform（`transcripts.ts` 同 `encodeProjectPath` 基座，`workflowsDir` 先例）——capabilities 零路径编码复制。
- 锚点：v2.8 Q-4（行 578「跨会话 SendMessage 载体=本地 transcript 存储+事件总线，与 ORC-041 同协议」）+§12.5 接缝⑳；A 级 teams 报告 §5（TeammateMailbox L55647-55680）；实现 packages/platform/src/transcripts.ts:59（teamsDir）+packages/capabilities/src/teams/mailbox.ts。
- 测试：packages/capabilities/test/wp07-teams-mailbox.test.ts:95（append 懒 mkdir+读改写往返=跨实例持久化语义）/:129（teammateInboxPath 组合形状）+apps/cli/test/wp07-teams-session.test.ts:61（`to:"main"` 恒路由主对话 once-only）。
- 未解决：无（mailbox 跨进程并发写与 WP-04 同族留白，登记）。

## 接缝㉑ 实验特性位 × 命令注册 × 遥测事件（2026-09-19，WP-12 随 M6-1 板补登）

- 定义：flag 默认关=三层零产出——命令不注册（基表逐字等于 `CLI_COMMANDS` **恰 35**〔M7 分期逐件注册后现值；本条 2026-09-19 立文时为 30，递增链 30→31→32→33→34→35〕；**门内注册六件**＝`workflows` `batch` `loop`（workflow flag）＋`fork` `export` `branch`（fork flag）〔2026-09-24 M7-WP-07 迁移后实况：原推后四件中的 `/branch` `/batch` `/loop` 已并入对应 flag；**teams flag 无命令面**，`/btw` 为**侧信道**——恒不进注册表、仅 REPL 在 teams 开启时旁路派发，见 `EXPERIMENTAL_SIDECHANNEL_COMMANDS` 与 mini-ADR-0049〕）、工具不注册（默认六件无 SendMessage/Workflow）、遥测零事件（双层：遥测门关=emit 纯布尔即返零构造零写盘；flag 关=桥接不注入=onTelemetry 缺位零事件）；非法值 fail-closed 不猜、未知名/未知键告警不静默。
- 锚点：v2.8 ORC-050（行 298）+§8.2 行 365+§12.5 接缝㉑+ENG-090 行 433；实现 packages/platform/src/experimental.ts:28（EXPERIMENTAL_FLAGS）/:75（resolveExperimental）+apps/cli/src/experimental-gate.ts（命令/工具注册门）+packages/capabilities/src/workflow/telemetry-bridge.ts（onTelemetry 注入件）。
- 测试：apps/cli/test/wp12-milestone.test.ts（M6 收口断言集：基表计数随分期递增〔现值 35，见上条〕+七件候选零命中+工具面六件+门候选守恒 7 件）+apps/cli/test/wp14-milestone.test.ts（**M7 收口断言集**：基表仍 35＋七件候选零命中＋门候选守恒 7 件＋附录 E 通道面在位）+apps/cli/test/wp11-workflow-telemetry.test.ts:129/:130/:149（接缝㉑ 双层=门关 emit 即返/flag 关桥接不注入）+wp01-experimental.test.ts（门序/告警/零注册）。
- 未解决：无（桥接生产装配位=M6 统一接线义务，WP-11 F1）。

## 接缝㉒ OTel 导出 × 遥测 opt-in 门（2026-09-25，WP-14 随 M7 收口补登）

- 定义：OTel 导出通道与遥测 opt-in 门**同门序**——默认关=零构造零外发（endpoint 未配置 ⇒ `createOtelSink` 返回 null、OTel SDK 整族不加载、facade emit 后 exporter 收 0 span）；门开后事件经 **sanitizeProps→redactSecrets 同一单源**脱敏入 span（与接缝⑮ 同函数，导出通道**不旁路**脱敏单源，防第二套实现漂移）；span resource `service.name` 缺省 `standardcode`、可被 `serviceName` 显式覆盖（非缺省形必须可判别）；endpoint 配置序 env > settings > 缺省，空串/非字符串=fail-closed 不猜。
- 锚点：v2.8 §5.2 行 226（platform-services L6 参考 `_367.js` OTel）+ENG-090 行 433+SEC-050 行 458+§12.5 接缝⑮（脱敏单源）；实现 packages/platform/src/otel.ts（TelemetrySink：事件→instant span，span 名=ENG-090 事件名）+packages/platform/src/telemetry.ts:14/199-203（自 session-store 导入 redactSecrets＋sanitizeProps 逐值调用）+packages/platform/src/session-store.ts:29（单源）。
- 测试：packages/platform/test/otel.test.ts:28（无 endpoint 零构造）/:34（关态 SDK 亦不加载，注入计数双向确证）/:47（门关 emit→0 span＝接缝㉒ 关侧）/:66（门开经 redactSecrets 单源＝开侧）/:87（turn_end 逐枚入 span，ENG-090 参数对位）/:110（env 凌驾 settings、空串 fail-closed）/:120（service.name 缺省＋非缺省两形）。
- 未解决：OTel sink 生产装配点未接线（WP-05 遗留，属 M6 统一接线义务族，留 G 门）；真 OTLP 外发未实跑（无 collector，登记）。

## 接缝㉓ `/sandbox` 命令面 × M5 沙箱后端三平台臂（2026-09-25，WP-14 随 M7 收口补登）

- 定义：`/sandbox` 命令与用户开关只做**键位持久化＋状态显示**，不改 M5 已冻结的沙箱后端与策略编译器；读侧判定单源=`sandbox-config.ts`（命令面不自写第二套判定），写入落 `sandbox.enabled`／`sandbox.tier` **点路径标量键**（本仓 settings 装配把嵌套对象展开为点路径叶子，对象形键取不到值——WP-03/04 同族教训），新会话经 `resolveSandboxSettings` 生效；后端缺席时 `on` 请求**零落盘并拒绝**（fail-closed，B-12），`off` 不需探针；env 逃逸舱 `STANDARD_CODE_SANDBOX` 凌驾时**明示**不静默；**开关翻转对在途会话的语义 [自定]＝当前会话保持、新会话生效**（不重建 session、不触碰工具装配）。
- 锚点：v2.8 §5.3(3)（三档策略）/§5.4（执行序）/EXE-010~012/ENG-072/B-12+§8.2 行 365（M7 分期含 /sandbox）；M5-1-results §WP-03（宿主接线＋默认档 workspace-write＋元数据禁写＋fail-closed）；实现 apps/cli/src/sandbox-config.ts（读侧单源）+apps/cli/src/commands.ts（`/sandbox` 末位注册，CLI_COMMANDS 33→34）+packages/platform/src/settings.ts（点路径叶子装配）。
- 测试：apps/cli/test/wp06-sandbox-command.test.ts:61（末位注册且全集恰 35）/:70（来源判定 env>flag>settings>default）/:84（档位全集相等＝命令面校验单源）/:96/:108/:116（缺省/开/关三态）/:133（持久化＋新会话生效）+apps/cli/test/wp03-sandbox-integration.test.ts（越界写拒/元数据禁写/fail-closed＝M5 冻结面零改回归）。
- 未解决：Windows deny-read 需 elevated（承接缝③ M5 条目，提权渠道到手后 `--ignored` 补跑）；真探针读 `process.env` 一例本机不可覆盖（WP-06 V O1，判据强度类非缺陷）。

## 接缝㉔ 主题/快捷键 × 终端渲染单源（2026-09-25，WP-14 随 M7 收口补登）

- 定义：色板与键位表收敛于 cli-terminal L0 **单源**（`theme.ts`／`keybindings.ts`）——渲染一律经 `colorize` 着色、键事件一律消费单源键位表，命令面与 REPL 面**禁散落硬编码色码/键位字面量**（防双份漂移，守卫用例判别新增散落）；二者均落 settings 点路径键（`ui.theme`／`ui.keybindings.<action>`）并由 settings 装配解析即恢复重启态；非法值 fail-closed 抛错**不静默回落缺省**；保留键（如 `ctrl+c`）冲突拒绝且不落盘。
- 锚点：v2.8 §5.2 行 214（cli-terminal L0 职责含渲染；主题/快捷键属该层）+§13 行 532（终端兼容矩阵维持 M1 裁决）+§12.5 接缝㉔；实现 apps/cli/src/theme.ts（THEMES/themeTokens/resolveTheme/colorize/themeFromSettings）+apps/cli/src/keybindings.ts（动作全集/parseKeySpec/matchKeyEvent/keybindingsFromSettings/resolveKeybindings）+apps/cli/src/render.ts（经 colorize，零裸 ANSI）。
- 测试：apps/cli/test/wp03-theme.test.ts:51/:55/:64/:73（单源纯函数，**非缺省形必覆盖**）/:88（themeFromSettings＝重启恢复入口）/:132/:142（持久化＋重启恢复）/:167（**渲染单源守卫**：`apps/cli/src` 除 theme.ts/main.ts 无裸 ANSI，三书写形态全覆盖）；apps/cli/test/wp04-keybindings.test.ts:79（动作全集与缺省表全集相等）/:93（非法形 fail-closed）/:100（修饰位全等才命中）/:108（重启恢复入口）/:132（冲突拒绝且不改当前表）/:205（**键位表单源守卫**：判据**不绑定变量名**、去注释后无硬编码键位字面量）。
- 未解决：无（不做自定义主题文件格式、不做多键序 chord，均 [自定] 留白登记）。
