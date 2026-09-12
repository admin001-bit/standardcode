# ADR-0040: MCP 配置载体与客户端运行时形状（M4，WP-01）

- 状态：已接受（2026-09-13，M4-WP-01）
- 规格处置：v2.8 §13 行"MCP 配置文件格式：.mcp.json / settings 内嵌二选一——M4 设计"（缺口清单处置点）；§5.3(4)（MCP 命名空间）；§6 ORC-050（传输首批 stdio+SSE/Streamable HTTP；OAuth 推后 M5 复审）；§12.5 接缝⑩；B-06（未覆盖级先 mini-ADR）。

## 背景

M4 引入 MCP 客户端体系（L3 capability-runtime，§5.2 行已登记）。v2.8 对配置载体只给了"二选一"的裁决义务未给答案；实现载体（自研 vs 官方 SDK）与 stdio 子进程环境策略亦无规格外锚点。dig-05 实证 [CC] 形态：项目根 `.mcp.json` + settings 合并双层、官方 MCP SDK 打底+自研包装层、stdio 子进程注入 CLAUDE_* 会话键。

## 决策

1. **载体=settings 内嵌 `mcpServers` 键**（取"二选一"之后项）。理由：项目共享设置已有原生载体 `.standardcode/settings.json`（Q-2 原生布局），独立文件会引入第二落盘契约（schemaVersion/信任门/坏文件跳过各要重做一遍）；内嵌键天然继承五来源合并序（ADR-0030）、`applyTrustGate` 过滤（ADR-0037 形制，WP-03 批准制直接消费 docs）、SEC-020b env 键黑名单、managed 锁定。`.mcp.json` 兼容读取不做（无既有用户，零迁移压力；如 [CC] 生态文件需兼容，另起 ADR）。
2. **服务器粒度整对象合并**：MCP loader 直取 per-source docs 低→高整对象覆盖，**不经 `settingsValue(merged)`**——settings merged 为点路径叶子粒度（ADR-0030），跨层同名 server 混叶子会产生"半程配置"怪形状；整对象替换与 WP-06 注册表整体替换先例同口径。同名冲突=抑制不改名+告警（dig-05 §2.1 tQo :153938-153960/x0l :154004-154018 形状）。
3. **自研最小客户端，不引 @modelcontextprotocol/sdk**。理由：本仓零外部运行时依赖先例（全包仅 workspace deps；ENG-071 依赖白名单纪律首例从紧）；所需面为协议子集（initialize 三步握手/JSON-RPC 帧/roots/list/SSE 与 Streamable HTTP 传输），providers 已有手写 SSE 解析同型先例；官方 SDK 引入 zod 等传递依赖链不划算。协议修订版集合 `2025-06-18/2025-03-26/2024-11-05`（缺省声明最新），server 回非支持版本=拒绝（MCP 规范协商语义）；[CC] era 协商（custom server/discover RPC、钉死 legacy）为规格外面不做。
4. **传输子集**：`stdio`（缺省）/`http`（Streamable HTTP；`streamable-http` 别名）/`sse`（legacy 2024-11-05 endpoint 流）；内部扩展型 `ws/sse-ide/ws-ide/sdk/claudeai-proxy` 配置层拒收（ORC-050 首批范围）。Streamable HTTP 首版不挂 GET 通知长流（list_changed 消费=WP-02 与刷新策略一并定）。
5. **stdio 子进程 env**（`buildStdioEnv`）：`sanitizeToolEnv(process.env)` 清洗基底（MCP server=第三方长驻进程，与工具子进程同 SEC-080 面取严 [自定]）→ 会话键注入 `STANDARD_CODE_PROJECT_DIR`/`STANDARD_CODE_SESSION_ID`/`STANDARD_CODE_MCP=1`（[CC] CLAUDE_* 同构 :299010-299021；STANDARD_CODE_ 前缀=ADR-0007，先滤后注=显式白名单通道）→ `config.env` 最后覆盖（声明式下沉唯一口，其 `${VAR}` 插值引用原始 process.env——API key 不自动下沉）。spawn `shell:false`+`windowsHide:true`（:35763-35764）；stdout 单帧 >16MB（`16777216`，:45637 同值）无消息边界=溢出断连（文案形状 :285543）。
6. **降级语义**：单 server 失败=entry `status:"failed"`+error 留痕，会话不阻塞（dig-05 §2.3 红队全路径无 fail-fast 实证）；连接前置校验错误码 `UNCONFIGURED`（缺 command/url，:298716 形状）/`INVALID_CONFIG`（URL 非法/型非法，:298746 形状）。`needs-auth` 状态值保留不赋值（ORC-050 OAuth=M5 复审）。
7. **连接超时**缺省 30000ms，env `STANDARD_CODE_MCP_TIMEOUT`（>0 生效，clamp ≤2147483647，:156230-156234 同构），测试面可注入。

## 后果

- WP-02（工具注入/超时矩阵/权限默认 ask）与 WP-03（/mcp+批准制）消费本 ADR 的 entries/issues/warnings 结构与 McpConnection 状态机；WP-09 插件 MCP 声明进 `MCP_SOURCE_ORDER` 语义位（plugins 展开合并=dig-05 §2.1 形状）。
- 未解决留后：`.mcp.json` 兼容读取（M5+ 视生态需求）、GET 通知长流（WP-02 消费时定）、era 协商（规格外，B-03 冻结除非升规格）。
