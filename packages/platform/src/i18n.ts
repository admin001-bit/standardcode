// WP-07（M4）：i18n 双包（ECO-010~012；ADR-0042）。
// catalog 形状/选择链/缺失策略/收敛范围=ADR-0042 四要素 [自定]（本地无 [CC] i18n 一手）。
// EN=单一事实源（commands.ts 经 tEn 模块级直读——en 与运行环境无关）；ZH_CN 键集合 MUST 与 EN 全等（测试钉）。
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
  "cmd.subtask.usage": "<prompt>",
  "cmd.subtask.desc": "run a synchronous subtask via subagent spawn and inject the result (sync-only before M6)",
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
  "cmd.permission.err.unknown": "unknown mode: {value}（可选 {choices}）",
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
  "cmd.subtask.usage": "<prompt>",
  "cmd.subtask.desc": "经 subagent spawn 跑同步子任务并注入结果（M6 前仅同步语义）",
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
  "cmd.permission.err.unknown": "unknown mode: {value}（可选 {choices}）",
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

const CATALOGS: Record<I18nLang, Record<string, string>> = { en: EN, "zh-CN": ZH_CN };

/** 语言解析（DoD② 选择链）：env STANDARD_CODE_LANG（非法=告警回退 en）> settings.language（同值域）> en。 */
export function resolveLang(env: Record<string, string | undefined> = process.env, settingsLanguage?: string): I18nLang {
  const raw = env[I18N_LANG_ENV] ?? settingsLanguage;
  if (raw === undefined || raw.trim() === "") return "en";
  const v = raw.trim();
  if ((I18N_LANGS as readonly string[]).includes(v)) return v as I18nLang;
  warnOnce(`invalid language "${raw}" (${I18N_LANG_ENV}/settings.language) — falling back to en`);
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

/** EN 直读（模块级求值面——commands.ts description/usage 单一事实源；en 与运行环境无关）。 */
export function tEn(key: string): string {
  const v = EN[key];
  if (v === undefined) warnOnce(`missing i18n key: ${key}`);
  return v ?? key;
}
