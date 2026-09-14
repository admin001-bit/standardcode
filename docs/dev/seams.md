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
