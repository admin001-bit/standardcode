// WP-07（M4）：i18n 双包（ECO-010~012；ADR-0042）。
// catalog 形状/选择链/缺失策略/收敛范围=ADR-0042 四要素 [自定]（本地无 [CC] i18n 一手）。渲染面命令面经运行时 getter t()+active 单例（configureI18n；复验 R3 取代早期 tEn 模块级形制）。
// EN=单一事实源（渲染文案唯一定义处；commands.ts description/usage 为运行时 getter t()，active 由 configureI18n 同步——R3 复验取代早期 tEn 模块级直读形制）；ZH_CN 键集合 MUST 与 EN 全等（测试钉）。
// 选择链：env STANDARD_CODE_LANG（en|zh-CN；非法=告警回退 en）> settings.language > en（resolveLang）。
// 缺失：t(key) 当前包无键→回退 EN；EN 亦无→返回 key+一次性告警（进程内去重）。
// 技术术语保留（DoD⑥）：ZH_CN 内 model/tool/provider/MCP/skill/hook/plugin 等英文原形（I18N_TERMS_KEEP+测试抽查）。

export type I18nLang = "en" | "zh-CN";

export const I18N_LANGS: readonly I18nLang[] = ["en", "zh-CN"];
export const I18N_LANG_ENV = "STANDARD_CODE_LANG";

/** 技术术语保留清单（DoD⑥；ZH_CN 值内保留英文原形的术语——测试抽查断言）。 */
export const I18N_TERMS_KEEP: readonly string[] = ["model", "tool", "provider", "MCP", "skill", "token", "cache", "settings", "subagent", "diff", "context", "transcript", "session", "server"];

const warnOnce = (() => {
  const seen = new Set<string>();
  return (msg: string): void => {
    if (seen.has(msg)) return;
    seen.add(msg);
    process.stderr.write(`[i18n] ${msg}\n`);
  };
})();

// —— EN 基准 catalog（单一事实源）——
export const EN: Record<string, string> = {
  // 命令面（cmd.<name>.desc / .usage）
  "cmd.help.desc": "list all available commands",
  "cmd.clear.desc": "clear conversation history (keeps this session)",
  "cmd.exit.desc": "exit standardcode",
  "cmd.model.usage": "[name]",
  "cmd.model.desc": "show or switch the model (WP-01 provider catalog)",
  "cmd.permission.usage": "[default|acceptEdits|plan|bypassPermissions]",
  "cmd.permission.desc": "cycle (no args, EXE-001 order) or set the permission mode",
  "cmd.rewind.usage": "<N>",
  "cmd.rewind.desc": "restore files to the state before snapshot N (file-history, EXE-040)",
  "cmd.context.desc": "show context window breakdown with real usage reconciliation (CTX-038; ADR-0027)",
  "cmd.diff.desc": "show session file changes vs pre-write snapshots (self-implemented unified diff, ADR-0032 rework; S-10 redaction)",
  "cmd.new.desc": "start a new session (previous transcript stays intact and resumable, CTX-101)",
  "cmd.resume.usage": "[query]",
  "cmd.resume.desc": "pick a past session (search + preview) and restore it (UI-030)",
  "cmd.rename.usage": "<title>",
  "cmd.rename.desc": "rename the current session (shows in /resume list)",
  "cmd.compact.usage": "[window | partial <msgIndex>]",
  "cmd.compact.desc": "manually compact the conversation (9-section summary, CTX-036; window 100k-1M)",
  "cmd.config.usage": "[key [value]]",
  "cmd.config.desc": "show merged settings (5-source order, WP-01) or set key into local layer",
  "cmd.provider.usage": "[anthropic|openai]",
  "cmd.provider.desc": "show or switch provider (takes effect next turn, MDL-010~013)",
  "cmd.doctor.desc": "environment health check with minimal self-repair (ENG-043, S-10 hints, ENG-080 migration)",
  "cmd.cd.usage": "<dir>",
  "cmd.cd.desc": "change the working directory (tools re-created; transcript project follows cwd)",
  "cmd.add-dir.usage": "<dir>",
  "cmd.add-dir.desc": "allow an additional working directory (gated by workspace trust, §8.3)",
  "cmd.reload.desc": "reload memory (WP-02) and settings (WP-01) from disk",
  "cmd.tasks.usage": "[all] [limit 1-100]",
  "cmd.tasks.desc": "list tasks (active_only default true, limit 1-100 default 20 — ORC-032)",
  "cmd.background.desc": "list backgrounded tasks (ORC-032)",
  "cmd.subtask.usage": "[[type] prompt]",
  "cmd.subtask.desc": "run a synchronous subtask via subagent spawn and inject the result (optional leading registered agent type【WP-10】; sync-only before M6)",
  "cmd.effort.usage": "[off|low|medium|high]",
  "cmd.effort.desc": "show or set the reasoning effort level (writes model.thinking, takes effect next turn — MDL-010~013)",
  "cmd.init.desc": "generate an AGENTS.md skeleton in the project root (never overwrites an existing file)",
  "cmd.status.desc": "session state overview (model/provider/permission mode/context water level/task count — real-time)",
  "cmd.usage.desc": "token four-column session totals + cache hit rate (in-session real-time) + built-in price table cost estimate (CTX-102/ENG-046)",
  "cmd.mcp.usage": "[list | approve|reject|enable|disable <server>]",
  "cmd.mcp.desc": "MCP servers: per-server approval state/transport/origin (S-3); manage approval and disable (persists to local layer)",
  "cmd.skills.usage": "[list | run <name> [args]]",
  "cmd.skills.desc": "list skills (name/description/source/state) or invoke a skill by name (user invocation bypasses disable-model-invocation)",
  "cmd.memory.desc": "show memory dual-track view (user-track sources & order MEM-044 + auto-track index summary)",
  // 命令参数错误（cmd.<name>.err.*）
  "cmd.permission.err.unknown": "unknown mode: {value} (choose {choices})",
  "cmd.rewind.err.notInteger": "/rewind N: N must be a positive integer (got {value})",
  "cmd.rewind.err.exceeds": "/rewind N: N ({value}) exceeds latest snapshot ({latest})",
  "cmd.cd.err.required": "/cd <dir>: directory required",
  "cmd.add-dir.err.required": "/add-dir <dir>: directory required",
  "cmd.subtask.err.required": "/subtask <prompt>: prompt required",
  "cmd.rename.err.required": "/rename <title>: title required",
  "cmd.compact.err.window": "/compact window: must be integer in [100000, 1000000] (CTX-036 manual window)",
  "cmd.tasks.err.limit": "/tasks limit must be integer in [1,100] (ORC-032), got: {value}",
  "cmd.mcp.err.unknownSub": "unknown /mcp subcommand: {value} (choose list | approve | reject | enable | disable)",
  "cmd.mcp.err.nameRequired": "/mcp {sub} <server>: server name required",
  "cmd.mcp.err.oneName": "/mcp {sub}: exactly one server name expected (got: {value})",
  "cmd.mcp.err.listExtra": "/mcp list: unexpected argument(s): {value}",
  "cmd.skills.err.unknownSub": "unknown /skills subcommand: {value} (choose list | run)",
  "cmd.skills.err.nameRequired": "/skills run <name> [args]: skill name required",
  "cmd.skills.err.listExtra": "/skills list: unexpected argument(s): {value}",
  "cmd.memory.err.args": "/memory takes no arguments",
  // repl 核心状态行（repl.*）
  "repl.done.cleared": "[clear] conversation history cleared",
  "repl.model.switched": "[model] switched to {value}",
  "repl.permission.mode": "[permission] mode: {label} ({value})",
  "repl.rename.done": "[rename] session renamed",
  "repl.command.unknown": "[command] unknown: /{value} (B-03: unregistered commands; try /help)",
  "repl.command.usage": "[command] usage: /<command> — try /help",
  "repl.shell.usage": "[shell] usage: !<command>",
  "repl.file.usage": "[file] usage: @<path> [prompt]",
  "repl.error.prefix": "[error] {value}",
  // help 头
  "repl.help.header": "commands:",
};

// —— ZH-CN 汉化包（键集合 MUST 与 EN 全等；技术术语保留英文——DoD⑥）——
export const ZH_CN: Record<string, string> = {
  "cmd.help.desc": "列出全部可用命令",
  "cmd.clear.desc": "清空对话历史（保留本 session）",
  "cmd.exit.desc": "退出 standardcode",
  "cmd.model.usage": "[name]",
  "cmd.model.desc": "查看或切换 model（WP-01 provider 目录）",
  "cmd.permission.usage": "[default|acceptEdits|plan|bypassPermissions]",
  "cmd.permission.desc": "循环切换（无参数，EXE-001 顺序）或设置权限模式",
  "cmd.rewind.usage": "<N>",
  "cmd.rewind.desc": "把文件恢复到快照 N 之前的状态（file-history，EXE-040）",
  "cmd.context.desc": "显示 context 窗口占用分布（含真实 usage 对账，CTX-038；ADR-0027）",
  "cmd.diff.desc": "显示会话文件变更（相对写盘前快照；自研 unified diff，ADR-0032；S-10 脱敏）",
  "cmd.new.desc": "开新会话（旧 transcript 完好可 /resume，CTX-101）",
  "cmd.resume.usage": "[query]",
  "cmd.resume.desc": "选择历史会话（搜索+预览）并恢复（UI-030）",
  "cmd.rename.usage": "<title>",
  "cmd.rename.desc": "重命名当前会话（/resume 列表可见）",
  "cmd.compact.usage": "[window | partial <msgIndex>]",
  "cmd.compact.desc": "手动压缩对话（9 段摘要，CTX-036；窗口 100k-1M）",
  "cmd.config.usage": "[key [value]]",
  "cmd.config.desc": "查看合并 settings（五来源序，WP-01）或写 local 层",
  "cmd.provider.usage": "[anthropic|openai]",
  "cmd.provider.desc": "查看或切换 provider（下一 turn 生效，MDL-010~013）",
  "cmd.doctor.desc": "环境健康检查与最小自修复（ENG-043、S-10 提示、ENG-080 迁移）",
  "cmd.cd.usage": "<dir>",
  "cmd.cd.desc": "切换工作目录（tool 重建；transcript 项目随 cwd）",
  "cmd.add-dir.usage": "<dir>",
  "cmd.add-dir.desc": "追加授权工作目录（受 workspace 信任门控，§8.3）",
  "cmd.reload.desc": "从磁盘重载记忆（WP-02）与 settings（WP-01）",
  "cmd.tasks.usage": "[all] [limit 1-100]",
  "cmd.tasks.desc": "列任务（active_only 缺省 true、limit 1-100 缺省 20 — ORC-032）",
  "cmd.background.desc": "列挂后台的任务（ORC-032）",
  "cmd.subtask.usage": "[[type] prompt]",
  "cmd.subtask.desc": "经 subagent spawn 跑同步子任务并注入结果（首词可选 registered agent 类型【WP-10】；M6 前仅同步语义）",
  "cmd.effort.usage": "[off|low|medium|high]",
  "cmd.effort.desc": "查看或设置推理力度档位（写 model.thinking，下一 turn 生效 — MDL-010~013）",
  "cmd.init.desc": "在项目根生成 AGENTS.md 骨架（绝不覆盖既有文件）",
  "cmd.status.desc": "会话状态总览（model/provider/权限模式/context 水位/任务数 — 实时）",
  "cmd.usage.desc": "token 四列累计 + cache 命中率（会话内实时）+ 内置价格表成本估算（CTX-102/ENG-046）",
  "cmd.mcp.usage": "[list | approve|reject|enable|disable <server>]",
  "cmd.mcp.desc": "MCP server：逐 server 批准状态/传输/来源（S-3）；管理批准与停用（落 local 层持久）",
  "cmd.skills.usage": "[list | run <name> [args]]",
  "cmd.skills.desc": "列 skill（名称/描述/来源/状态）或按名调用（用户点名豁免 disable-model-invocation）",
  "cmd.memory.desc": "显示记忆双轨视图（用户轨来源与顺序 MEM-044 + 自动轨索引摘要）",
  "cmd.permission.err.unknown": "unknown mode：{value}（可选 {choices}）",
  "cmd.rewind.err.notInteger": "/rewind N：N 必须为正整数（得到 {value}）",
  "cmd.rewind.err.exceeds": "/rewind N：N（{value}）超出最新快照（{latest}）",
  "cmd.cd.err.required": "/cd <dir>：必须提供目录",
  "cmd.add-dir.err.required": "/add-dir <dir>：必须提供目录",
  "cmd.subtask.err.required": "/subtask <prompt>：必须提供 prompt",
  "cmd.rename.err.required": "/rename <title>：必须提供标题",
  "cmd.compact.err.window": "/compact 窗口：必须为 [100000, 1000000] 内整数（CTX-036 手动窗口）",
  "cmd.tasks.err.limit": "/tasks limit 必须为 [1,100] 内整数（ORC-032），得到：{value}",
  "cmd.mcp.err.unknownSub": "未知 /mcp 子命令：{value}（可选 list | approve | reject | enable | disable）",
  "cmd.mcp.err.nameRequired": "/mcp {sub} <server>：必须提供 server 名",
  "cmd.mcp.err.oneName": "/mcp {sub}：只应提供一个 server 名（得到：{value}）",
  "cmd.mcp.err.listExtra": "/mcp list：多余的参数：{value}",
  "cmd.skills.err.unknownSub": "未知 /skills 子命令：{value}（可选 list | run）",
  "cmd.skills.err.nameRequired": "/skills run <name> [args]：必须提供 skill 名",
  "cmd.skills.err.listExtra": "/skills list：多余的参数：{value}",
  "cmd.memory.err.args": "/memory 不接受参数",
  "repl.done.cleared": "[clear] 对话历史已清空",
  "repl.model.switched": "[model] 已切换到 {value}",
  "repl.permission.mode": "[permission] 模式：{label}（{value}）",
  "repl.rename.done": "[rename] 会话已重命名",
  "repl.command.unknown": "[command] 未知命令：/{value}（B-03：未注册命令，试试 /help）",
  "repl.command.usage": "[command] 用法：/<command> — 试试 /help",
  "repl.shell.usage": "[shell] 用法：!<command>",
  "repl.file.usage": "[file] 用法：@<path> [prompt]",
  "repl.error.prefix": "[error] {value}",
  "repl.help.header": "可用命令：",
};

Object.assign(EN, {
  // —— WP-07 复验修复（R1）：repl 渲染面全量目录化；en 值=现文本逐字（零行为变化；中英混排为既有基线，纯英化留 G 观察）——
  "cmd.tasks.err.multiple": "/tasks: expected [all] [limit 1-100], got multiple numbers: {value}",
  "cmd.model.err.unknownModel": "unknown model: {value}（可用：{list}）",
  "repl.session.transcriptUnavailable": "[session] transcript unavailable ({value}) — session continues without persistence",
  "repl.resume.none": "[resume] no sessions recorded for this project",
  "repl.resume.noPicker": "[resume] interactive picker unavailable（非交互环境；索引如下）",
  "repl.resume.cancelled": "[resume] cancelled",
  "repl.resume.restored": "[resume] {id} — {title}：{n} message(s) restored{tail}",
  "repl.resume.lastReason": "（上次终态 {reason}）",
  "repl.config.unset": "(unset)",
  "repl.config.set": "[config] {key} = {value} -> .standardcode/settings.local.json（已重载）",
  "repl.provider.switched": "[provider] {name}（切换即时生效于下一 turn；adapter {state}）",
  "repl.provider.unchanged": "未变",
  "repl.provider.rebuilt": "已重建",
  "repl.model.header": "models (current: {value}):",
  "repl.cd.working": "[cd] working directory: {value}",
  "repl.cd.notDir": "/cd: not a directory: {value}",
  "repl.adddir.err": "/add-dir: {value}",
  "repl.adddir.authorized": "[add-dir] authorized: {value}",
  "repl.adddir.trustNote": "\n  ! directory is an untrusted git repository — shared settings there stay gated (§8.3)",
  "repl.reload.done": "[reload] memory ({files} file(s)) and settings (sources: {sources}) reloaded",
  "repl.subtask.guard": "Cannot start a subtask before the first conversation turn",
  "repl.subtask.refused": "[subtask] refused: {value}",
  "repl.subtask.unexpected": "[subtask] unexpected channel: {value}（M3 /subtask 恒同步）",
  "repl.subtask.completed": "[subtask] {type} completed ({tokens} tokens / {uses} tool uses)",
  "repl.subtask.injected": "<subtask agent=\"{type}\" tokens=\"{tokens}\">\n{report}\n</subtask>",
  "repl.effort.current": "[effort] current: {label}（可选 {levels}；写 model.thinking local 层，下一 turn 生效——MDL-010~013 同构）",
  "repl.effort.set": "[effort] {value}（model.thinking={thinking}，下一 turn 生效）",
  "repl.effort.unknown": "unknown effort: {value}（可选 {levels}）",
  "repl.init.exists": "[init] AGENTS.md already exists — left unchanged（只生成不覆盖）",
  "repl.init.created": "[init] created {value}（骨架）",
  "repl.tasks.none": "[tasks] {which}（注册表共 {total} 条）",
  "repl.tasks.header": "[tasks] {shown}/{all}{mode}",
  "repl.tasks.activeOnly": "（active_only；/tasks all 含终态）",
  "repl.tasks.noneActive": "no active tasks",
  "repl.tasks.noneAll": "no tasks",
  "repl.background.none": "[background] 无挂后台任务",
  "repl.background.header": "[background] {value} 条",
  "repl.status.header": "[status]",
  "repl.status.model": "  model: {model}（provider: {provider}；catalog: {catalog}）",
  "repl.status.permission": "  permission: {value}",
  "repl.status.context": "  context: {occupied}/{window} tokens（{pct}%，grid 估算占用=/context 同源）",
  "repl.status.tasks": "  tasks: {active} active / {total} total",
  "repl.status.session": "  session: {id}（cwd={cwd}；memory={files} file(s)；turns={turns}）",
  "repl.usage.header": "[usage] session totals（API usage=唯一权威口径 ADR-0027；本地估算不位移展示值——DP-4 显式>隐式）",
  "repl.usage.totals": "  input={input} output={output} cache_creation={cacheCreation} cache_read={cacheRead}",
  "repl.usage.hitrate": "  cache hit rate（会话内实时，M1 WP-05 同源=cache_read/input）: {value}",
  "repl.usage.noInput": "n/a（no input usage yet）",
  "repl.usage.costKnown": "  cost estimate: ${usd}（四列×单价行合计；内置固定价格表 [自定] 结构性占位，官方标定缺位登记未解决）in=${input}/M out=${output}/M cacheW=${cw}/M cacheR=${cr}/M",
  "repl.usage.costUnknown": "  cost estimate: n/a（{model} 不在内置价格表——env 自定目录模型不设价，拒绝静默套价）",
  "repl.mcp.header": "[mcp] {value} server(s)",
  "repl.mcp.pendingHint": "  pending project server(s) are not active until approved: /mcp approve <name> (S-3)",
  "repl.mcp.action": "[mcp] {done} {name}{suffix}{hint}",
  "repl.mcp.suffix": " — {state}{status}",
  "repl.mcp.suffixStatus": " ({value})",
  "repl.mcp.hintRejected": "（decision=rejected 仍在——恢复批准用 /mcp approve）",
  "repl.mcp.errorCol": "error: {value}",
  "repl.mcp.done.approve": "approved",
  "repl.mcp.done.reject": "rejected",
  "repl.mcp.done.enable": "enabled",
  "repl.mcp.done.disable": "disabled",
  "repl.skills.header": "[skills] {value} skill(s)",
  "repl.skills.state.active": "active",
  "repl.skills.state.userOnly": "user-only",
  "repl.skills.state.model": "model",
  "repl.skills.invoked": "[skills] invoked {value}（内容已注入会话）",
  "repl.skills.warnPrefix": "  [warn] {value}",
  "repl.skills.activeLine": "  active: {name}{tools}",
  "repl.skills.activeTools": "（tools: {list}）",
  "repl.memory.userHeader": "[memory] 用户编写轨（加载序=数组序，MEM-044 双读 CLAUDE.md→AGENTS.md）:",
  "repl.memory.userEmpty": "  (empty)",
  "repl.memory.autoHeader": "[memory] 自动轨（§9.1 ②；{state}）",
  "repl.memory.autoEnabled": "enabled",
  "repl.memory.autoDisabled": "disabled (memory.autoTrack=false)",
  "repl.memory.indexLine": "  索引: {detail}",
  "repl.memory.indexNone": "(no MEMORY.md)",
  "repl.memory.indexDetail": "{lines} 行 / {bytes} 字节{truncated}",
  "repl.memory.indexTruncated": "（已硬截断）",
  "repl.memory.filesLine": "  记忆文件: {value} 个",
  "repl.memory.missingLine": "  未写链接: {value}",
  "repl.hooks.promptBlocked": "[hooks] prompt blocked by UserPromptSubmit hook: {value}",
  "repl.hooks.stopBlocked": "[hooks] Stop hook blocked {value} times — returning control to user",
  "repl.hooks.stopFeedback": "[Stop hook] {value}",
  "repl.file.notFound": "[file] not found: {value}",
  "repl.shell.exitCode": "[shell] exit code {value}",
  "repl.shell.truncated": "[output truncated]",
  "repl.command.failed": "[command] /{name} failed: {value}",
  "repl.provider.switchHint": "provider: {name}（可用：anthropic|openai；/provider <name> 切换，下一 turn 生效——MDL-010~013）",
  "repl.compact.errManual": "compact window: must be integer in [{min}, {max}] (CTX-036 manual window; fail-closed)",
  "repl.rewind.noStore": "file-history unavailable（/rewind 需要 file-history store）",
  "repl.compact.done": "[compact] {pre} -> {post} tokens（摘要 {chars} chars，已替换历史）",
  "repl.doctor.header": "doctor: environment health check (ENG-043)",
  "repl.doctor.settingsWarn": "  [warn] settings {source} ({path}): {reason}",
  "repl.doctor.settingsOk": "  [ok] settings sources readable",
  "repl.doctor.dirFix": "  [fix] created missing project .standardcode",
  "repl.doctor.dirWarn": "  [warn] project .standardcode missing and could not be created: {value}",
  "repl.doctor.writableOk": "  [ok] directories writable",
  "repl.doctor.writableWarn": "  [warn] project .standardcode not writable: {value}",
  "repl.doctor.transcripts": "  [info] transcripts: {n} session(s), {kib} KiB total{big}",
  "repl.doctor.transcriptsBig": "（S-10 提示：体积较大，考虑清理旧转录）",
  "repl.doctor.schemaWarn": "  [warn] {value} settings file(s) missing schemaVersion (ENG-080: migration hint)",
  "repl.doctor.noRepair": "  [ok] no self-repair needed",
  "repl.config.sourcesHeader": "effective sources (high->low): {value}",
  "repl.config.sourceLine": "{source}: {keys}",
  "repl.config.sourceAbsent": "(absent)",
  "repl.config.sourceEmpty": "(empty)",
  "repl.config.mergedLine": "merged keys: {value}",
  "repl.config.none": "(none)",
  // —— M4-WP-09：/plugin（ECO-030~033；S-5 安装确认；技术术语 plugin/agent/skill/hook/MCP 保留英文——ECO-011）——
  "cmd.plugin.usage": "[install <name|path|git-url> | list | remove <name>]",
  "cmd.plugin.desc": "plugins (ECO-030~033): install with component-list confirmation (S-5), list installed, remove (directory-level cleanup)",
  "cmd.plugin.err.unknownSub": "unknown /plugin subcommand: {value} (choose install | list | remove)",
  "cmd.plugin.err.targetRequired": "/plugin install <name|path|git-url>: target required",
  "cmd.plugin.err.nameRequired": "/plugin remove <name>: plugin name required",
  "cmd.plugin.err.oneTarget": "/plugin {sub}: exactly one target expected (got: {value})",
  "cmd.plugin.err.listExtra": "/plugin list: unexpected argument(s): {value}",
  "cmd.plugin.err.noConfirm": "plugin install requires explicit confirmation (S-5) — no confirm UI in this session (fail-closed)",
  "repl.plugin.header": "plugins ({value}):",
  "repl.plugin.empty": "no plugins installed",
  "repl.plugin.broken": "(broken manifest — injection skipped)",
  "repl.plugin.mktHeader": "marketplaces ({value}):",
  "repl.plugin.warn": "  [warn] {value}",
  "repl.plugin.confirmDetail": "install plugin {name} v{version} — components to be injected: {commands} command(s), {agents} agent(s), {skills} skill(s){hooks}{mcp}",
  "repl.plugin.hookCol": ", hook events: [{value}]",
  "repl.plugin.mcpCol": ", MCP servers: [{value}]",
  "repl.plugin.installed": "[plugin] installed {name} v{version} (source: {source})",
  "repl.plugin.effectNote": "  injection surfaces (agents/skills/hooks/MCP) take effect at next session assembly",
  "repl.plugin.denied": "[plugin] install declined — nothing landed (S-5)",
  "repl.plugin.exists": "[plugin] already installed: {value} (remove first)",
  "repl.plugin.noManifest": "[plugin] no valid plugin.json at target: {value}",
  "repl.plugin.cloneFailed": "[plugin] git source failed: {value}",
  "repl.plugin.notFound": "[plugin] not found (local path, git URL, or configured marketplaces): {value}",
  "repl.plugin.marketAdded": "[plugin] marketplace \"{name}\" ({source}) added — {value} entries",
  "repl.plugin.removed": "[plugin] removed {value} (install dir cleaned + record deleted)",
  // —— M4-WP-10：项目级 agent 二次确认（SEC-070 生产接线，ADR-0043）——
  "repl.agents.confirmDetail": "SEC-070: project-level agent requests escalating field(s) [{value}] — explicit confirmation required and persisted to local layer",
});
Object.assign(ZH_CN, {
  "cmd.tasks.err.multiple": "/tasks：应为 [all] [limit 1-100]，收到多个数字：{value}",
  "cmd.model.err.unknownModel": "unknown model：{value}（可用：{list}）",
  "repl.session.transcriptUnavailable": "[session] transcript 不可用（{value}）——会话继续，不落盘",
  "repl.resume.none": "[resume] 本项目无历史会话记录",
  "repl.resume.noPicker": "[resume] 交互式选择器不可用（非交互环境；索引如下）",
  "repl.resume.cancelled": "[resume] 已取消",
  "repl.resume.restored": "[resume] {id} — {title}：已恢复 {n} 条消息{tail}",
  "repl.resume.lastReason": "（上次终态 {reason}）",
  "repl.config.unset": "（未设置）",
  "repl.config.set": "[config] {key} = {value} -> .standardcode/settings.local.json（已重载）",
  "repl.provider.switched": "[provider] {name}（切换即时生效于下一 turn；adapter {state}）",
  "repl.provider.unchanged": "未变",
  "repl.provider.rebuilt": "已重建",
  "repl.model.header": "models（当前：{value}）:",
  "repl.cd.working": "[cd] 工作目录：{value}",
  "repl.cd.notDir": "/cd：不是目录：{value}",
  "repl.adddir.err": "/add-dir：{value}",
  "repl.adddir.authorized": "[add-dir] 已授权：{value}",
  "repl.adddir.trustNote": "\n  ！目录属未信任 git 仓库——其内共享设置仍受门控（§8.3）",
  "repl.reload.done": "[reload] 记忆（{files} 个文件）与 settings（来源：{sources}）已重载",
  "repl.subtask.guard": "首轮对话开始前无法发起 subtask",
  "repl.subtask.refused": "[subtask] 被拒：{value}",
  "repl.subtask.unexpected": "[subtask] 意外通道：{value}（M3 /subtask 恒同步）",
  "repl.subtask.completed": "[subtask] {type} 完成（{tokens} tokens / {uses} 次工具调用）",
  "repl.subtask.injected": "<subtask agent=\"{type}\" tokens=\"{tokens}\">\n{report}\n</subtask>",
  "repl.effort.current": "[effort] 当前：{label}（可选 {levels}；写 model.thinking local 层，下一 turn 生效——MDL-010~013 同构）",
  "repl.effort.set": "[effort] {value}（model.thinking={thinking}，下一 turn 生效）",
  "repl.effort.unknown": "unknown effort：{value}（可选 {levels}）",
  "repl.init.exists": "[init] AGENTS.md 已存在——保持不变（只生成不覆盖）",
  "repl.init.created": "[init] 已生成 {value}（骨架）",
  "repl.tasks.none": "[tasks] {which}（注册表共 {total} 条）",
  "repl.tasks.header": "[tasks] {shown}/{all}{mode}",
  "repl.tasks.activeOnly": "（active_only；/tasks all 含终态）",
  "repl.tasks.noneActive": "无 active 任务",
  "repl.tasks.noneAll": "无任务",
  "repl.background.none": "[background] 无挂后台任务",
  "repl.background.header": "[background] {value} 条",
  "repl.status.header": "[status]",
  "repl.status.model": "  model: {model}（provider: {provider}；catalog: {catalog}）",
  "repl.status.permission": "  permission: {value}",
  "repl.status.context": "  context: {occupied}/{window} tokens（{pct}%，grid 估算占用=/context 同源）",
  "repl.status.tasks": "  tasks: {active} active / {total} total",
  "repl.status.session": "  session: {id}（cwd={cwd}；memory={files} file(s)；turns={turns}）",
  "repl.usage.header": "[usage] 会话累计（API usage=唯一权威口径 ADR-0027；本地估算不位移展示值——DP-4 显式>隐式）",
  "repl.usage.totals": "  input={input} output={output} cache_creation={cacheCreation} cache_read={cacheRead}",
  "repl.usage.hitrate": "  cache 命中率（会话内实时，M1 WP-05 同源=cache_read/input）: {value}",
  "repl.usage.noInput": "n/a（尚无 input 用量）",
  "repl.usage.costKnown": "  cost estimate: ${usd}（四列×单价行合计；内置固定价格表 [自定] 结构性占位，官方标定缺位登记未解决）in=${input}/M out=${output}/M cacheW=${cw}/M cacheR=${cr}/M",
  "repl.usage.costUnknown": "  cost estimate: n/a（{model} 不在内置价格表——env 自定目录模型不设价，拒绝静默套价）",
  "repl.mcp.header": "[mcp] {value} 个 server",
  "repl.mcp.pendingHint": "  待批准的 project server 不会生效：/mcp approve <name>（S-3）",
  "repl.mcp.action": "[mcp] {done} {name}{suffix}{hint}",
  "repl.mcp.suffix": " — {state}{status}",
  "repl.mcp.suffixStatus": "（{value}）",
  "repl.mcp.hintRejected": "（decision=rejected 仍在——恢复批准用 /mcp approve）",
  "repl.mcp.errorCol": "错误：{value}",
  "repl.mcp.done.approve": "已批准",
  "repl.mcp.done.reject": "已拒绝",
  "repl.mcp.done.enable": "已启用",
  "repl.mcp.done.disable": "已停用",
  "repl.skills.header": "[skills] {value} 个 skill",
  "repl.skills.state.active": "active",
  "repl.skills.state.userOnly": "仅用户",
  "repl.skills.state.model": "model",
  "repl.skills.invoked": "[skills] 已调用 {value}（内容已注入会话）",
  "repl.skills.warnPrefix": "  [warn] {value}",
  "repl.skills.activeLine": "  active: {name}{tools}",
  "repl.skills.activeTools": "（tools: {list}）",
  "repl.memory.userHeader": "[memory] 用户编写轨（加载序=数组序，MEM-044 双读 CLAUDE.md→AGENTS.md）:",
  "repl.memory.userEmpty": "  （空）",
  "repl.memory.autoHeader": "[memory] 自动轨（§9.1 ②；{state}）",
  "repl.memory.autoEnabled": "enabled",
  "repl.memory.autoDisabled": "disabled (memory.autoTrack=false)",
  "repl.memory.indexLine": "  索引: {detail}",
  "repl.memory.indexNone": "（无 MEMORY.md）",
  "repl.memory.indexDetail": "{lines} 行 / {bytes} 字节{truncated}",
  "repl.memory.indexTruncated": "（已硬截断）",
  "repl.memory.filesLine": "  记忆文件: {value} 个",
  "repl.memory.missingLine": "  未写链接: {value}",
  "repl.hooks.promptBlocked": "[hooks] 提示词被 UserPromptSubmit hook 阻断：{value}",
  "repl.hooks.stopBlocked": "[hooks] Stop hook 已连续阻断 {value} 次——交还用户",
  "repl.hooks.stopFeedback": "[Stop hook] {value}",
  "repl.file.notFound": "[file] 找不到：{value}",
  "repl.shell.exitCode": "[shell] 退出码 {value}",
  "repl.shell.truncated": "[输出已截断]",
  "repl.command.failed": "[command] /{name} 失败：{value}",
  "repl.provider.switchHint": "provider: {name}（可用：anthropic|openai；用 /provider <name> 切换，下一 turn 生效——MDL-010~013）",
  "repl.compact.errManual": "compact 窗口：必须为 [{min}, {max}] 内整数（CTX-036 手动窗口；fail-closed）",
  "repl.rewind.noStore": "file-history 不可用（/rewind 需要 file-history store）",
  "repl.compact.done": "[compact] {pre} -> {post} tokens（摘要 {chars} chars，已替换历史）",
  "repl.doctor.header": "doctor: 环境健康检查（ENG-043）",
  "repl.doctor.settingsWarn": "  [warn] settings {source} ({path}): {reason}",
  "repl.doctor.settingsOk": "  [ok] settings 各来源可读",
  "repl.doctor.dirFix": "  [fix] 已创建缺失的 project .standardcode",
  "repl.doctor.dirWarn": "  [warn] project .standardcode 缺失且无法创建：{value}",
  "repl.doctor.writableOk": "  [ok] 目录可写",
  "repl.doctor.writableWarn": "  [warn] project .standardcode 不可写：{value}",
  "repl.doctor.transcripts": "  [info] transcripts: {n} 个会话，共 {kib} KiB{big}",
  "repl.doctor.transcriptsBig": "（S-10 提示：体积较大，考虑清理旧转录）",
  "repl.doctor.schemaWarn": "  [warn] {value} 个 settings 文件缺 schemaVersion（ENG-080：迁移提示）",
  "repl.doctor.noRepair": "  [ok] 无需自修复",
  "repl.config.sourcesHeader": "生效来源（高→低）：{value}",
  "repl.config.sourceLine": "{source}: {keys}",
  "repl.config.sourceAbsent": "（缺席）",
  "repl.config.sourceEmpty": "（空）",
  "repl.config.mergedLine": "合并键：{value}",
  "repl.config.none": "（无）",
  // —— M4-WP-09：/plugin zh 包（技术术语 plugin/agent/skill/hook/MCP 保留英文——ECO-011）——
  "cmd.plugin.usage": "[install <name|path|git-url> | list | remove <name>]",
  "cmd.plugin.desc": "插件（ECO-030~033）：安装须显式确认并展示组件清单（S-5）、列出已安装、卸载（目录级清理）",
  "cmd.plugin.err.unknownSub": "未知 /plugin 子命令：{value}（可选 install | list | remove）",
  "cmd.plugin.err.targetRequired": "/plugin install <name|path|git-url>：必须提供安装目标",
  "cmd.plugin.err.nameRequired": "/plugin remove <name>：必须提供插件名",
  "cmd.plugin.err.oneTarget": "/plugin {sub}：只应提供一个目标（得到：{value}）",
  "cmd.plugin.err.listExtra": "/plugin list：多余的参数：{value}",
  "cmd.plugin.err.noConfirm": "插件安装必须显式确认（S-5）——本会话无确认 UI（fail-closed）",
  "repl.plugin.header": "插件（{value}）：",
  "repl.plugin.empty": "尚未安装任何插件",
  "repl.plugin.broken": "（manifest 坏件——注入面跳过）",
  "repl.plugin.mktHeader": "市场（{value}）：",
  "repl.plugin.warn": "  [warn] {value}",
  "repl.plugin.confirmDetail": "安装插件 {name} v{version} —— 将注入的组件：{commands} 个 command、{agents} 个 agent、{skills} 个 skill{hooks}{mcp}",
  "repl.plugin.hookCol": "、hook 事件：[{value}]",
  "repl.plugin.mcpCol": "、MCP server：[{value}]",
  "repl.plugin.installed": "[plugin] 已安装 {name} v{version}（来源：{source}）",
  "repl.plugin.effectNote": "  注入面（agents/skills/hooks/MCP）于下一次会话装配生效",
  "repl.plugin.denied": "[plugin] 安装已拒绝——零落地（S-5）",
  "repl.plugin.exists": "[plugin] 已安装同名插件：{value}（请先卸载）",
  "repl.plugin.noManifest": "[plugin] 目标无有效 plugin.json：{value}",
  "repl.plugin.cloneFailed": "[plugin] git 源失败：{value}",
  "repl.plugin.notFound": "[plugin] 未找到插件（本地路径、git URL 或已配置市场均无）：{value}",
  "repl.plugin.marketAdded": "[plugin] 已添加市场 \"{name}\"（{source}）——{value} 个条目",
  "repl.plugin.removed": "[plugin] 已卸载 {value}（安装目录已清理 + 留痕已删）",
  // —— M4-WP-10：项目级 agent 二次确认（SEC-070 生产接线，ADR-0043）——
  "repl.agents.confirmDetail": "SEC-070：项目级 agent 请求提权字段 [{value}]——须显式确认并落 local 层留痕",
});

const CATALOGS: Record<I18nLang, Record<string, string>> = { en: EN, "zh-CN": ZH_CN };

/** 语言解析（DoD② 选择链）：env STANDARD_CODE_LANG（非法=告警回退 en）> settings.language（同值域）> en。 */
export function resolveLang(env: Record<string, string | undefined> = process.env, settingsLanguage?: unknown): I18nLang {
  // O2/O3 加固（复验后）：env 空/白串=未设置（落到 settings）；settings 非字符串=告警回退（fail-closed 不崩启动）
  const envRaw = env[I18N_LANG_ENV];
  const fromEnv = typeof envRaw === "string" && envRaw.trim() !== "" ? envRaw : undefined;
  if (settingsLanguage !== undefined && typeof settingsLanguage !== "string") warnOnce("invalid settings.language (non-string) — falling back to env/en");
  const fromSettings = typeof settingsLanguage === "string" && settingsLanguage.trim() !== "" ? settingsLanguage : undefined;
  const raw = fromEnv ?? fromSettings;
  if (raw === undefined) return "en";
  const v = raw.trim();
  if ((I18N_LANGS as readonly string[]).includes(v)) return v as I18nLang;
  warnOnce(`invalid language "${v}" (${I18N_LANG_ENV}/settings.language) — falling back to en`);
  return "en";
}

export interface I18n {
  lang: I18nLang;
  /** 渲染文案：当前包缺失→回退 EN；EN 亦无→返回 key+一次性告警（DoD③）。 */
  t(key: string, params?: Record<string, string | number>): string;
}

/** 组装 i18n 面（lang=resolveLang 产物；会话级快照，无热切换）。 */
export function createI18n(lang: I18nLang): I18n {
  return {
    lang,
    t(key, params) {
      let text = CATALOGS[lang][key];
      if (text === undefined) {
        if (lang !== "en") {
          text = EN[key];
          if (text !== undefined) return interpolate(text, params); // 回退 EN（DoD③）
        }
        warnOnce(`missing i18n key: ${key}`);
        return key;
      }
      return interpolate(text, params);
    },
  };
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** EN 直读（缺省工具；命令面运行时求值已改 getter t()+active——本函数保留供 en 基线直读面）。 */
export function tEn(key: string): string {
  const v = EN[key];
  if (v === undefined) warnOnce(`missing i18n key: ${key}`);
  return v ?? key;
}

let ACTIVE: I18n = createI18n("en");
/** 会话装配点调用（与 session.i18n 同步）；测试 try/finally 恢复 en。 */
export function configureI18n(lang: I18nLang): void {
  ACTIVE = createI18n(lang);
}
export function getActiveI18n(): I18n {
  return ACTIVE;
}
/** 运行时渲染（active lang；commands 静态面 getter/渲染点共用）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  return ACTIVE.t(key, params);
}
