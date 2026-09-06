# 模块证据锚点

> 复制自 `D:\StandardCode\StandardCode_v2.8.md` §5.2（2026-09-07，WP-07 迁移，逐字保留，原文为准；本文件随实现演进）。

### 5.2 模块清单（B-02：层归属与职责不可变更）

> 参考列为经源码核验的修正口径；`_N` 编号仅 v2.1.246 快照有效，不得写入产品代码。

| 模块 | 层 | 语言 | 职责 | 参考（已验证归属） |
| :-- | :- | :-- | :-- | :-- |
| `cli-terminal` | L0 | TS | 输入解析、渲染、快捷键、剪贴板 | [CC] 交互范式（模板层+快照）；TUI 结构参考 Kimi `pi-tui` |
| `session-orchestrator` | L1 | TS | 会话状态机、Agent Loop、撤销回滚 | [CC] 主循环 `lQn`/`oj`（`_440.js:149307/149185`）+ 流式工具执行器 `CAt`（`_440.js:142629`） |
| `permission-broker` | L1 | TS | 权限模式仲裁与用户确认 | [CC] 仲裁链 `STo`（`_440.js:61596-61604` 逐字）；规则引擎 `chunk-4svxqcrq.js`（deny 侧清洗/匹配）、`chunk-3sdc4pj4.js`（allowRules 来源披露收集器）；`_50.js`（权限模式/UI/引导层）、`_83.js`（hook 输出→permissionDecision 决策封装）——dig-02 纠偏定性 |
| `planner` | L1 | TS | 计划生成与执行调度 | [CC] Plan Mode（`_440.js` 内，无独立模块；模板 `system-prompt-plan-mode*`） |
| `prompt-layout` | L2 | TS | Prompt 分区、前缀稳定、cacheScope | [CC] `nz`/`iWt`/`e$s`（`_440.js:266805/267474/273289`）；快照 `evidence/ClaudeCode的系统提示词/prompt-capture/extracted/system-prompt.md` |
| `context-store` | L2 | TS | 压缩、缓存分区、计量 | [CC] `vHe/cCt/uCt/GYn`（`_440.js:132212` 起，常量 MYn=13000/OYn=3000/kHe=0.2 实测 `:132234-132236`）；压缩协调器 `XRt`（`_440.js:141250`）/`MWe`（`_440.js:139978`）；`/context` schema `_670.js` |
| `memory-loader` | L2 | TS | 分层记忆加载、按路径加载、自动记忆索引 | [CC] `_533.js`（ae=200 行 / ot=25000 字节，实测逐字）；模板 `system-prompt-memory-*` |
| `capability-runtime` | L3 | TS | 工具、Skill、Subagent、MCP、Hooks、Plugin | [CC] **hooks 引擎在 `_440.js`**（PreToolUse 等执行路径；`_184.js` 为 REPL 渲染组件层、含 hookEvent 展示——dig-04 §1 定性）、`_440.js`（MCP 客户端 v1/v2 双代运行时，dig-05；`_13.js`/`_660` 为云控制面、`chunk-wd159v90.js` 为 MCP SDK 服务端 transport、`_148.js` 为 REPL 前端）、`_440.js:177800`（Agent 工具）、`_353.js`（fork）、`_386.js`（注册表）、`_26.js`（workflow 基础设施 1.1MB，M6）；hooks-worker 独立线程 |
| `executor` | L4 | TS | 命令执行、文件读写 | [CC] Edit/Bash 实现主体在 `_440.js`；`_525.js`（578KB：bwrap/socat 沙箱依赖、ripgrep 集成、glob 引擎、WebFetch、Read 描述——dig-03 结构更正，非"工具实现集"）、`_0.js`（fs/child_process）；dig-03 executor 语义 |
| `sandbox-backend` | L4 | **Rust** | 本地文件系统隔离（M5，子进程执行器） | Codex `codex-rs/sandboxing` + `linux-sandbox` + `windows-sandbox-rs` |
| `guard-path` | L4 | TS | 高危路径护栏（M1 起常驻，先于沙箱） | [CC] `_616.js`（`.claude` 守卫正则）+ Codex `PROTECTED_METADATA_PATH_NAMES` |
| `provider-adapter` | L5 | **TS** | 多协议适配、能力声明、重试回退 | OpenCode `packages/llm`（Protocol/Route 分离）+ `packages/opencode/src/provider/`（provider.ts 2047 行 / transform.ts 1856 行，注意 `packages/llm/src/provider.ts` 仅 36 行门面）；Kimi `kosong`（方言自适应、四层防御）；Codex `model-provider-info` |
| `platform-services` | L6 | TS | 配置、存储、更新、遥测、计费、i18n | [CC] `_811.js`（467 env）、`_2.js`（--settings 早期处理）、`_710.js`、`_310.js`（keychain）、`_788.js`（**file-history 快照**；"checkpoint"称谓未在其源码出现）、`_367.js`（OTel）、`_7.js`（CA 证书）；错误码常量在 `_795.js:11`（`ERR_FILE_TOO_LARGE`），`_830.js` 仅错误分类 getter |
