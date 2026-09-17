// 会话状态与 L5 装配（v2.8 §5.1 L0 消费 L1/L5；§8.3 EXE-001 权限四模式）。
// M2 WP-01：M1"env 直读"偏差清偿——启动装配经 platform/settings 五来源合并（§7.7）；
// STANDARD_CODE_* env 为保留逃逸舱（MDL-010~013），优先级 env > settings > 默认（ADR-0030）。
// 模型目录为内置最小集（WP-01 边界：不做模型目录全集），数值取 v2.8 MDL-001 注记
//（claude-sonnet-4-6=32000/128000、claude-opus-5=64000/128000，_695.js 实测），
// maxOutputTokens.upper 缺证取=default，thinking/input 能力位 [自定]。
import { AnthropicAdapter, OpenAIChatAdapter, ResponsesAdapter, parseWireApi, type AnthropicModelEntry, type LLMMessage, type OpenAIModelEntry, type ProviderAdapter, type ProviderOptions } from "@standardcode/providers";
import { UsageMeter } from "@standardcode/context";
import { buildMcpToolsForConnection, connectAll, createHookEngine, createSkillTool, createStandardTools, expandSkillBody, gateMcpServerDocs, loadHookConfigs, loadMcpServerConfigs, loadSkills, loadSkillsFromDir, parseTransportType, SKILL_ALREADY_LOADED_NOTE, SKILL_LISTING_HEADER, buildSkillListing, createSandboxHandle, type HookEngine, type HookEventName, type HookEventOutcome, type HookSourceName, type LoadedSkill, type McpApprovalState, type McpConnection, type McpServerEntry, type McpSourceName, type SandboxHandle, type SandboxTier, type SkillUsageRecord, type StandardTool } from "@standardcode/capabilities";
import { createPermissionBroker, createTaskRegistry, parseAgentMarkdown, type PermissionBroker, type Ruleset, type SubagentDefinition, type TaskRegistry, type ToolHooks } from "@standardcode/harness";
import { createAgentRegistry, gateProjectAgentDefinitions, type AgentRegistry, type SpawnValidationContext } from "@standardcode/harness";
import { applySettingsEnv, buildPluginDocs, configureI18n, createI18n, createKeychainAdapter, createTelemetryFacade, loadInstalledPlugins, loadProjectAgentDefinitions, loadSettings, managedSettingsPath, readAgentTrust, recordAgentTrust, resolveLang, settingsValue, keychainAccountFor, TELEMETRY_SETTINGS_KEY, type InstalledPluginView, type KeychainAdapter, type PluginRecord, type I18n, type LoadedSettings, type SettingsEnvHandle, type TelemetryFacade, type TelemetrySink } from "@standardcode/platform";
import { createTrustGate, isTrusted, projectMemoryDir, readMcpTrust, readTrustStore, recordMcpTrust, type McpTrustRecord, type TrustGateResult } from "@standardcode/platform";
import { buildMemoryDisciplinePrompt, createCompactionCoordinator, detectProjectWorkspace, loadAutoMemory, loadMemory, renderAutoMemoryContext, resolveAutocompactConfig, type AutoMemoryView, type CompactionCoordinator, type LoadedMemory, type MemoryPrecedence, type ThinkingSetting } from "@standardcode/context";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** EXE-001 循环切换序与四模式枚举的唯一权威在 harness permission-broker（WP-08）。 */
export { PERMISSION_MODES as PERMISSION_CYCLE } from "@standardcode/harness";
export type { PermissionMode } from "@standardcode/harness";
import type { PermissionMode } from "@standardcode/harness";
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "Manual",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "Auto",
};

/** M4-WP-03：/mcp list 视图（活动定义+被门控剔除项；状态/传输/来源/连接态）。 */
export interface McpServerView {
  name: string;
  origin: McpSourceName;
  transport: "stdio" | "sse" | "http";
  /** 批准状态机终态（S-3；approved/rejected/disabled/pending）。 */
  state: McpApprovalState;
  /** 连接态（未装载=缺席）。 */
  status?: "pending" | "connected" | "failed" | "needs-auth";
  error?: string;
}

/** M4-WP-04：hooks 门面（可阻断 gate=await 聚合；fire=通知面吞错）。 */
export interface SessionHooks {
  gate(
    event: HookEventName,
    query: { toolName?: string; agentType?: string; source?: string; reason?: string } | undefined,
    payload: Record<string, unknown>,
    stopHookActive?: boolean,
  ): Promise<HookEventOutcome>;
  fire(
    event: HookEventName,
    query: { toolName?: string; agentType?: string; source?: string; reason?: string } | undefined,
    payload: Record<string, unknown>,
  ): void;
  /** harness 工具链适配（PreToolUse 三裁决序/PostToolUse/PostToolUseFailure/PermissionRequest）。 */
  toolAdapter(): ToolHooks;
}

/** M4-WP-05：skills 门面（清单增量+激活收窄+用户点名豁免）。 */
export interface SessionSkills {
  all(): LoadedSkill[];
  warnings(): string[];
  /** 增量清单 meta 文本（CTX-005 追加载体；null=无新增；内部推进 sent 名集合——DoD⑧ per-agent 去重）。 */
  listing(): string | null;
  active(): { name: string; allowedTools?: string[] } | null;
  /** allowed-tools 白名单收窄后的工具面（DoD⑤ S-5；Skill 工具恒保留 [自定]）。 */
  toolFace(base: StandardTool[]): StandardTool[];
  /** 用户点名豁免（/skills run；不经 Skill tool=免 disable-model-invocation 限制，DoD④ 双轨）。 */
  runByName(name: string, args?: string): { text: string; injected: string | null };
}

/** M4-WP-09：plugin 门面（会话装配期聚合四注入面消费；生效时点=会话创建，/reload 不重建装配面与 skills/hooks 既有口径一致 [自定] 登记偏差）。 */
export interface SessionPlugins {
  /** 插件基目录（=<home>/.standardcode；installer 落盘/留痕根，/plugin 命令动作面消费）。 */
  baseDir(): string;
  /** 安装记录视图（每次读盘刷新——/plugin list 即时反映 install/remove）。 */
  installed(): InstalledPluginView[];
  /** plugin 层 agent 定义（注册表 sources.plugin 消费形制；链位 built-in<plugin<user ORC-022）。 */
  agents(): SubagentDefinition[];
  /** 聚合告警（坏件/缺目录/同名抑制——/plugin list 消费面）。 */
  warnings(): string[];
}

/** M4-WP-10（ADR-0043）：项目级 agent 生产接线门面——同步启动（built-in+plugin）+首轮异步补装（project 层）。 */
export interface AgentsLoadState {
  /** loadProjectAgents 已执行（true=装配尝试过，含失败降级）。 */
  loaded: boolean;
  /** 整层未装载（未信任 SEC-070 门/禁用位/装配异常降级）。 */
  layerWithheld: boolean;
  /** settings agents.projectDisabled=true（DoD⑥ [自定] 键位）。 */
  disabled: boolean;
  /** 提权字段未确认剥离留痕（gate 输出）。 */
  stripped: { file: string; name: string; fields: string[] }[];
  warnings: string[];
}

export interface SessionAgents {
  /** 当前注册表（built-in+plugin；补装后含 project——整体替换重建，ADR-0043 决策 3）。 */
  registry(): AgentRegistry;
  names(): string[];
  /** 首轮异步补装（isTrusted→load→gate(confirm UI)→注入；未信任/禁用/异常=整层不加载降级，不抛）。 */
  loadProjectAgents(deps?: { confirm?: (name: string, fields: string[]) => Promise<boolean> }): Promise<AgentsLoadState>;
  state(): AgentsLoadState;
  /** spawn 接线统一 ctx（DoD②③：names() 真消费+requiredMCP 连接态投影+Agent(X) deny 提取）+子代理工具链 hooks
   * 执行面（WP-10 DoD⑤ 定义级引擎；WP-04 M5 恒返回——合并引擎含父会话源集=传播接通，无 def.hooks 时=纯父传播面）。 */
  prepareSpawn(subagentType?: string): { ctx: Omit<SpawnValidationContext, "concurrentSubagents">; definition: SubagentDefinition | undefined; hooks: ToolHooks };
}

export interface Session {
  /** 当前会话 ID（WP-10：转录文件名+锁键+/resume 目标；repl 初始化时赋 UUID）。 */
  id: string;
  provider: ProviderAdapter;
  providerName: string;
  /** /model 可切目录（WP-01 adapter 模型目录投影）。 */
  catalog: readonly string[];
  model: string;
  messages: LLMMessage[];
  tools: StandardTool[];
  cwd: string;
  meter: UsageMeter;
  /** 权限仲裁（WP-08）：模式与评估序唯一权威；permissionMode 为其投影（/permission 经 cycleMode 操作）。 */
  broker: PermissionBroker;
  exitRequested: boolean;
  /** 进行中 turn 的中断控制器（Ctrl+C → abort；§8.4 中断不变量的 L0 触发点）。 */
  activeAbort: AbortController | null;
  /** 五来源合并结果（WP-01；/config 展示与 /reload 重载的消费点，WP-11）。 */
  settings: LoadedSettings;
  /** 记忆用户轨（M2 WP-02：MEM-011 加载序+MEM-044 双读+@import；text 进 prompt-layout memory 分段）。 */
  memory: LoadedMemory;
  /** WP-06：自动记忆轨视图（索引+互链；memory.autoTrack=false 时 view=null）。 */
  autoMemory: AutoMemoryView | null;
  /** WP-06：维护纪律提示词段（system 拼接；memory.autoTrack=false 时为空串）。 */
  memoryDiscipline: string;
  /** WP-06：自动轨注入面（索引+互链；内容 hash 变化才返回文本，否则 null——增量 [自定]）。 */
  autoMemoryListing(): string | null;
  /** 扩展思维配置（M2 WP-06，缺省关闭=不发 thinking 字段；每 turn 请求与压缩请求共用）。 */
  thinking: ThinkingSetting | undefined;
  /** AutoCompact 协调器（M2 WP-03：四道闸+重压缩链；执行体 runCompaction 在 repl 装配=WP-04）。 */
  autocompact: CompactionCoordinator;
  /** 工作区信任门控（WP-07/S-8）：生效信任态+被门控剔除的共享设置登记（信任对话框消费）。 */
  trust: TrustGateResult;
  /** 家目录覆写（测试隔离用；"总是允许"落盘路径随之，未传=真实家目录）。 */
  home?: string;
  /** 已授权附加工作目录（§8.3 additionalDirectories 运行时通道，WP-11 /add-dir；初始自 settings）。 */
  additionalDirectories: string[];
  /** env 副本快照（WP-07 R-env 修复的断言面：settings env.* 注入经信任门控后落此；只读消费）。 */
  env: Record<string, string | undefined>;
  /** M4-WP-02：MCP 连接清单（/mcp 消费面；status/origin/error 均在 McpConnection）。 */
  mcpConnections: McpConnection[];
  /** MCP 装配 Promise（不阻塞启动；单 server 失败只降级 DoD④，异常静默）。 */
  mcpReady: Promise<void>;
  /** drain 后台终态通知（repl turn 首注入 <system-reminder>，SEC-010 载体同构）。 */
  drainMcpNotifications(): string[];
  /** M4-WP-03：raw 定义全集（门控前；/mcp list 与批准动作的名字校验/来源快照消费）。 */
  mcpRawServers: McpServerEntry[];
  /** M4-WP-03：逐来源逐 server 批准态（批准状态机终态，每次装配刷新）。 */
  mcpGateStates: { name: string; origin: McpSourceName; state: McpApprovalState }[];
  /** M4-WP-03：/mcp list 视图。 */
  mcpServers(): McpServerView[];
  /** M4-WP-03：approve|reject|enable|disable → local 层留痕（ADR-0037 形制）+按现行门控重装配。 */
  mcpRecord(action: "approve" | "reject" | "enable" | "disable", name: string): Promise<void>;
  /** M4-WP-03：按现行门控重装配（关旧连+清旧工具+重连；装配链串行防竞态）。 */
  refreshMcp(): Promise<void>;
  /** M4-WP-04：hooks 门面（引擎+工具链适配；配置源=settings 五来源+信任门运行时判定）。 */
  hooks: SessionHooks;
  /** M4-WP-05：skills 门面（三源发现+清单增量+allowed-tools 收窄+用户点名豁免）。 */
  skills: SessionSkills;
  /** M4-WP-09：plugin 门面（四注入面装配聚合+安装记录）。 */
  plugins: SessionPlugins;
  /** M4-WP-10：项目级 agent 生产接线门面（ADR-0043 时序=同步启动+首轮异步补装）。 */
  agents: SessionAgents;
  /** M4-WP-07：i18n 面（lang=会话级快照：env STANDARD_CODE_LANG > settings.language > en；ADR-0042）。 */
  i18n: I18n;
  /** M5-WP-03：沙箱句柄（-sdb/settings/env 开启时装配；lazy 拉起=构造零进程，DoD①②）。 */
  sandbox?: SandboxHandle;
  /** 任务注册表（M3 WP-04；/subtask 走 spawn 与 WP-05 /tasks 面板的共享实例）。 */
  taskRegistry: TaskRegistry;
  /** M5-WP-06：遥测门面（ENG-090 七事件+SEC-050 默认关；sink 可注入，关态零构造；门刷新=repl turn 界）。 */
  telemetry: TelemetryFacade;
  /** WP-11 /provider 切换（重建 provider；下一 turn 生效）。 */
  switchProvider(name: string): void;
  /** WP-11 /reload：重载记忆与设置（原位更新可变字段）。 */
  reload(): void;
  /** WP-11 /add-dir：追加授权目录（过信任门控）。 */
  addAdditionalDirectory(dir: string): void;
}

/** settings 注入 env 的粘滞登记读取点（Session 接口伴生函数；handle 本体由装配方持有）。 */
export function settingsEnvInjectedOf(handle: SettingsEnvHandle): ReadonlySet<string> {
  return handle.injected;
}

export interface SessionInit {
  /** 直接注入 ProviderAdapter（测试/自定义装配）。 */
  provider?: ProviderAdapter;
  providerName?: string;
  catalog?: readonly string[];
  model?: string;
  cwd?: string;
  /** env 逃逸舱（MDL-010~013）读取得替身（测试）。 */
  env?: NodeJS.ProcessEnv;
  /** 权限规则（M1 注入通道保留；settings permissions.* 持久化落 local 层=WP-07）。 */
  rules?: Partial<Ruleset>;
  /** settings 装配参数（WP-01）：projectRoot 定位项目 local/共享层；home/programData/platform 供测试替换。 */
  projectRoot?: string;
  home?: string;
  programData?: string;
  platform?: NodeJS.Platform;
  /** 命令行 flag 源（优先级仅低于 managed，§7.7）。 */
  flagOverrides?: Record<string, unknown>;
  /** 跨会话粘滞登记（settings 注入 env 不可 unset；省略则本会话新建）。 */
  settingsEnv?: SettingsEnvHandle;
  /** SEC-030 keychain 适配器注入（测试；缺省=createKeychainAdapter()，win32=unavailable fail-open）。 */
  keychain?: KeychainAdapter;
  /** 记忆加载覆写（测试/特殊装配）：inProject 缺省=MEM-043 检测（cwd 祖先链有 .git/.standardcode）。 */
  memoryOptions?: { inProject?: boolean; relevantPaths?: string[] };
  /** 扩展思维直接注入（测试/装配）；缺省走 env/settings 解析（resolveThinking）。 */
  thinking?: ThinkingSetting;
  /** 信任覆写（测试/装配）：缺省按 trust store 判定（WP-07）。 */
  trusted?: boolean;
  /** M5-WP-03 沙箱开启（装配层已解析确认，缺席=默认关 DoD①）：档+二进制覆写。 */
  sandbox?: { tier: SandboxTier; binaryPath?: string };
  /** M5-WP-06 遥测 sink 注入（测试；缺席=默认文件桩）。 */
  telemetrySink?: TelemetrySink;
  /** M5-WP-06 文件桩基目录覆写（测试隔离；缺省 ~/.standardcode）。 */
  telemetryBaseDir?: string;
}

/**
 * WP-06 解析序（env 逃逸舱 > settings > 默认关闭，ADR-0030 键 model.thinking + env STANDARD_CODE_THINKING）：
 * 值形 "adaptive" | "budget" | "budget:<tokens>" | "off"。缺省/无效 → undefined（不发 thinking 字段）。
 */
export function resolveThinking(init: ThinkingSetting | undefined, env: Record<string, string | undefined>, settings: LoadedSettings): ThinkingSetting | undefined {
  if (init) return init;
  const raw = env.STANDARD_CODE_THINKING ?? settingsValue<string>(settings, "model.thinking");
  if (!raw || raw === "off" || raw === "none") return undefined;
  if (raw === "adaptive") return { type: "adaptive" };
  const m = /^budget(?::(\d+))?$/.exec(raw);
  if (m) return { type: "budget", budgetTokens: m[1] ? Number(m[1]) : 8_000 };
  return undefined;
}

const ANTHROPIC_ENTRIES: Record<string, AnthropicModelEntry> = {
  "claude-sonnet-4-6": {
    contextWindow: 128_000,
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    thinking: "adaptive",
    input: ["text", "image"],
  },
  "claude-opus-5": {
    contextWindow: 128_000,
    maxOutputTokens: { default: 64_000, upper: 64_000 },
    thinking: "adaptive",
    input: ["text", "image"],
  },
};

/** plugin agents .md 枚举（platform agent-discovery collectMarkdown 同形——harness 解析面在 cli 侧消费，起步注记裁决）。 */
function collectPluginMarkdown(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在=无定义（常态，非错误）
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectPluginMarkdown(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
}

export function createSession(init: SessionInit = {}): Session {
  // env 逃逸舱为独立副本（settings 注入不外泄污染调用方；凭据/override 语义不变）
  const env: Record<string, string | undefined> = { ...(init.env ?? process.env) };
  // settings 五来源（§7.7）：managed > flag > 项目 local > 项目共享 > 用户；env.* 注入粘滞（ADR-0030）
  const settings = loadSettings({
    projectRoot: init.projectRoot ?? init.cwd ?? process.cwd(),
    ...(init.home !== undefined ? { home: init.home } : {}),
    ...(init.programData !== undefined ? { programData: init.programData } : {}),
    ...(init.platform !== undefined ? { platform: init.platform } : {}),
    ...(init.flagOverrides !== undefined ? { flagOverrides: init.flagOverrides } : {}),
  });
  // WP-07 R-env 修复（V 退回 2026-09-09）：信任门控 MUST 先于 env 注入——§8.3 L380"多数 env 须先接受
  // 信任对话框才生效"，env 注入消费门控后 settings（原版先注入后门控，未信任共享层 env.* 漏注入）。
  // trust store 随 home 覆写（测试隔离；未传=真实家目录）。
  const sessionCwd = init.cwd ?? process.cwd();
  const trustStoreFile = init.home ? path.join(init.home, ".standardcode", "trust.json") : undefined;
  const trust = createTrustGate(sessionCwd, settings, init.trusted ?? isTrusted(sessionCwd, readTrustStore(trustStoreFile)));
  const gatedSettings = trust.settings;
  const settingsEnv: SettingsEnvHandle = init.settingsEnv ?? { injected: new Set() };
  applySettingsEnv(gatedSettings, env, settingsEnv);
  // SEC-030 keychain 链首适配器（会话一次创建；测试经 init.keychain 注入；win32=unavailable fail-open）。
  const keychain = init.keychain ?? createKeychainAdapter();

  // M5-WP-06：遥测门面（SEC-050 默认关；门初值=env STANDARD_CODE_TELEMETRY > settings telemetry.enabled > 关，
  // 非法值 fail-closed 不猜；sink 测试注入，缺席=文件桩 <~/.standardcode>/telemetry/events.ndjson 惰性构造；
  // turn 界门刷新（env 重读即时生效）在 repl runPromptTurn。sessionId 懒取=repl 初始化时才赋 UUID）。
  const telemetry = createTelemetryFacade({
    sessionId: () => session.id,
    env: process.env,
    settingsEnabled: settingsValue<boolean>(gatedSettings, TELEMETRY_SETTINGS_KEY),
    ...(init.telemetrySink ? { sink: init.telemetrySink } : {}),
    ...(init.telemetryBaseDir !== undefined ? { baseDir: init.telemetryBaseDir } : {}),
  });

  // —— M4-WP-09：Plugin 装配（ECO-030~033）——安装留痕 <home>/.standardcode/plugins.json（platform installer 纯 fs 面）。
  // 四注入面聚合：hooks/MCP=docs 的 plugin 源位（buildPluginDocs）；skills=loadSkillsFromDir(dir,"plugin")；
  // agents=cli 侧调 harness parseAgentMarkdown（注册表 sources.plugin 消费形制，生产接线=WP-10 义务）。
  // 生效时点=会话装配（/plugin install 后新会话/reload 设置面可见；与 hooks/skills 既有装配口径一致 [自定]）。
  // 安装确认≠信任确认（卡边界）：插件 hooks 仍受引擎信任门 :262013；插件 MCP 非 projectShared 不进 S-3 批准门（S-5 安装确认为其门）。
  const pluginBaseDir = path.join(init.home ?? homedir(), ".standardcode");
  const pluginViews = loadInstalledPlugins(pluginBaseDir);
  const pluginDocs = buildPluginDocs(pluginViews);
  const pluginSkillWarnings: string[] = [];
  const pluginSkills: LoadedSkill[] = [];
  const pluginAgentWarnings: string[] = [];
  const pluginAgentDefs: SubagentDefinition[] = [];
  for (const v of pluginViews) {
    if (v.manifest === null) continue; // 装后坏件=不进注入面（告警继续，DoD① 同构）
    for (const dir of v.manifest.components.skillsDirs) pluginSkills.push(...loadSkillsFromDir(dir, "plugin", pluginSkillWarnings));
    const agentFiles: string[] = [];
    for (const dir of v.manifest.components.agentsDirs) collectPluginMarkdown(dir, agentFiles);
    agentFiles.sort(); // 枚举序稳定（loadProjectAgentDefinitions 同口径）
    for (const f of agentFiles) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch (err) {
        pluginAgentWarnings.push(`${f}: unreadable (${err instanceof Error ? err.message : String(err)}) — skipped`);
        continue;
      }
      const p = parseAgentMarkdown(text, f);
      pluginAgentWarnings.push(...p.warnings);
      if (p.def) pluginAgentDefs.push(p.def);
    }
  }

  // —— M4-WP-10：项目级 agent 生产接线（ADR-0043 决策 1：同步启动+首轮异步补装；注册表生产装配
  // 含 built-in+plugin 层=板头接缝④激活+WP-09 O3 义务；project 层=gate 确认后整体替换重建）——
  const agentsProjectRoot = init.projectRoot ?? sessionCwd;
  let agentsRegistry = createAgentRegistry({ sources: { plugin: pluginAgentDefs } });
  const agentsState: AgentsLoadState = { loaded: false, layerWithheld: false, disabled: false, stripped: [], warnings: [] };
  function extractDeniedAgentTypes(): string[] {
    // 校验段③权限规则的 deniedAgentTypes 供给（ctx 注释契约=从 Agent(X) deny 规则原文提取；settings+init 通道合并）
    const deny = [...(settingsValue<string[]>(session.trust.settings, "permissions.deny") ?? []), ...(init.rules?.deny ?? [])];
    const out: string[] = [];
    for (const raw of deny) {
      const m = /^Agent\(([^)]+)\)$/.exec(raw.trim());
      if (m?.[1] !== undefined && m[1].trim() !== "") out.push(m[1].trim());
    }
    return out;
  }
  async function loadProjectAgents(deps?: { confirm?: (name: string, fields: string[]) => Promise<boolean> }): Promise<AgentsLoadState> {
    agentsState.loaded = true;
    try {
      const disabled = settingsValue<boolean>(session.trust.settings, "agents.projectDisabled") === true; // DoD⑥（[自定] 键位=ADR-0043 决策 7）
      agentsState.disabled = disabled;
      if (disabled) {
        agentsState.layerWithheld = true;
        agentsState.stripped = [];
        agentsState.warnings = ["project agent definitions disabled by settings agents.projectDisabled=true"];
        agentsRegistry = createAgentRegistry({ sources: { plugin: pluginAgentDefs } });
        return { ...agentsState, stripped: [], warnings: [...agentsState.warnings] };
      }
      const files = loadProjectAgentDefinitions(agentsProjectRoot); // 每次装载新对象=ADR-0043 决策 4（DoD⑦：跨轮不携带 gate mutation）
      const gated = await gateProjectAgentDefinitions(files.parsed, {
        trusted: session.trust.trusted,
        records: readAgentTrust(agentsProjectRoot),
        ...(deps?.confirm !== undefined ? { confirm: deps.confirm } : {}),
        onConfirmed: (name, rec) => {
          recordAgentTrust(agentsProjectRoot, name, rec); // SEC-070 留痕=local 层 agentTrust（ADR-0037 形制，M3 WP-09 读写面）
        },
      });
      agentsState.layerWithheld = gated.layerWithheld;
      agentsState.stripped = gated.stripped;
      agentsState.warnings = [...files.warnings, ...gated.warnings];
      agentsRegistry = createAgentRegistry({ sources: { plugin: pluginAgentDefs, project: gated.loadable } }); // 整体替换重建（决策 3）
    } catch (err) {
      // 补装异常=零项目层+告警（降级不阻塞会话——MCP 降级面同族；ADR-0043 决策 1）
      agentsState.layerWithheld = true;
      agentsState.warnings = [...agentsState.warnings, `project agent load failed (degraded): ${err instanceof Error ? err.message : String(err)}`];
      agentsRegistry = createAgentRegistry({ sources: { plugin: pluginAgentDefs } });
    }
    return { ...agentsState, stripped: [...agentsState.stripped], warnings: [...agentsState.warnings] };
  }
  function prepareSpawn(subagentType?: string): { ctx: Omit<SpawnValidationContext, "concurrentSubagents">; definition: SubagentDefinition | undefined; hooks: ToolHooks } {
    const hit = agentsRegistry.get(subagentType ?? "general-purpose");
    const ctx: Omit<SpawnValidationContext, "concurrentSubagents"> = {
      depth: 0,
      availableTypes: agentsRegistry.names(), // DoD②：类型解析真消费 names()（repl 硬编码 ["general-purpose"] 退役）
      definitionsOf: (n) => agentsRegistry.get(n),
      deniedAgentTypes: extractDeniedAgentTypes(),
      // DoD③ requiredMCP 真接：要求服务器未 connected（含 failed/缺席）=pending→校验面 30s 等待（连接态每次调用实读）
      pendingRequiredMcp: (required) => required.filter((n) => !session.mcpConnections.some((c) => c.name.toLowerCase() === n.toLowerCase() && c.status === "connected")),
    };
    return { ctx, definition: hit, hooks: agentHooksFor(hit ?? undefined) };
  }

  // 记忆用户轨（WP-02）：precedence/autoRead 自 settings（ADR-0030 memory.* 键）；MEM-043 项目工作区检测
  const memory = loadMemory({
    cwd: sessionCwd,
    ...(init.home !== undefined ? { home: init.home } : {}),
    managedDir: path.dirname(managedSettingsPath(init.platform ?? process.platform, init.programData)),
    inProject: init.memoryOptions?.inProject ?? detectProjectWorkspace(sessionCwd),
    rulesEnabled: settingsValue<boolean>(gatedSettings, "memory.autoRead") ?? true,
    precedence: (settingsValue<MemoryPrecedence>(gatedSettings, "memory.precedence") ?? "claude-first"),
    ...(init.memoryOptions?.relevantPaths ? { relevantPaths: init.memoryOptions.relevantPaths } : {}),
  });
  const thinking = resolveThinking(init.thinking, env, gatedSettings);
  // WP-07：权限规则两源合并（settings 合并序供静态规则——allow 受信任门控与 broker 构造期清洗双重把关；
  // init.rules=程序化注入通道优先）。门控剔除已在 trust.settings 完成（allow/env 不进 merged）。
  const settingsRules: Required<Ruleset> = {
    deny: settingsValue<string[]>(gatedSettings, "permissions.deny") ?? [],
    ask: settingsValue<string[]>(gatedSettings, "permissions.ask") ?? [],
    allow: settingsValue<string[]>(gatedSettings, "permissions.allow") ?? [],
  };
  const hasSettingsRules = settingsRules.deny.length > 0 || settingsRules.ask.length > 0 || settingsRules.allow.length > 0;
  const mergedRules: Partial<Ruleset> | undefined =
    init.rules || hasSettingsRules
      ? {
          ...settingsRules,
          ...(init.rules ?? {}),
        }
      : undefined;
  // WP-03：协调器配置（env 逃逸舱+settings；模型窗口来源=UNKNOWN_MODEL_ASSUMED/auto——窗口解析链 WP-03 原文，模型目录窗口接线随 WP-05 /context）
  const autocompact = createCompactionCoordinator(
    resolveAutocompactConfig({
      env,
      settings: {
        autocompactEnabled: settingsValue<boolean>(settings, "autocompact.enabled"),
        autocompactWindow: settingsValue<unknown>(settings, "autocompact.window"),
        autocompactPct: settingsValue<unknown>(settings, "autocompact.pct"),
      },
    }),
  );

  const providerDefault = settingsValue<string>(settings, "providers.default");
  let providerName = (init.providerName ?? env.STANDARD_CODE_PROVIDER ?? providerDefault ?? "anthropic").toLowerCase();
  let provider: ProviderAdapter;
  let catalog: readonly string[];
  if (init.provider) {
    provider = init.provider;
    providerName = init.providerName ?? providerName;
    catalog = init.catalog ?? [];
  } else {
    const built = buildProvider(providerName, env, gatedSettings, keychain);
    provider = built.provider;
    providerName = built.providerName;
    catalog = built.catalog;
  }
  catalog = init.catalog ?? catalog;
  const modelDefault = settingsValue<string>(settings, "model.default");
  const model = init.model ?? env.STANDARD_CODE_MODEL ?? modelDefault ?? catalog[0];
  if (!model) throw new Error("no model available: pass model/catalog or set STANDARD_CODE_MODEL or settings model.default");
  // M5-WP-03：沙箱句柄装配（-sdb/settings/env 开启位已由装配层解析确认；构造 lazy=零进程，
  // 首次 Bash/写盘才拉起 server——DoD① 缺省态与本分支整体缺席同物）。
  const sandboxHandle = init.sandbox
    ? createSandboxHandle({ tier: init.sandbox.tier, workspaceRoot: sessionCwd, ...(init.sandbox.binaryPath ? { binaryPath: init.sandbox.binaryPath } : {}) })
    : undefined;
  const session: Session = {
    id: "",
    provider,
    providerName,
    catalog,
    model,
    messages: [],
    tools: createStandardTools({ cwd: init.cwd ?? process.cwd(), ...(sandboxHandle ? { sandbox: sandboxHandle } : {}) }),
    cwd: init.cwd ?? process.cwd(),
    meter: new UsageMeter(),
    broker: createPermissionBroker({ ...(mergedRules ? { rules: mergedRules } : {}) }),
    exitRequested: false,
    activeAbort: null,
    settings,
    memory,
    thinking,
    autocompact,
    trust,
    ...(sandboxHandle ? { sandbox: sandboxHandle } : {}),
    i18n: createI18n("en"),
    env,
    additionalDirectories: [...(settingsValue<string[]>(gatedSettings, "additionalDirectories") ?? [])],
    ...(init.home !== undefined ? { home: init.home } : {}),
    // —— WP-11：/provider /reload /add-dir 会话操作面（MDL-010~013 下一 turn 生效；M1 环境重载语义）——
    taskRegistry: createTaskRegistry(),
    telemetry,
    // M4-WP-02：MCP 装配占位（真值在 session 构造后即位——见下方 bootstrap 块）。
    mcpConnections: [],
    mcpReady: Promise.resolve(),
    mcpRawServers: [],
    mcpGateStates: [],
    mcpServers: () => [],
    mcpRecord: async () => {},
    refreshMcp: async () => {},
    hooks: {
      gate: async () => ({ verdict: null, decisionReason: null, nonBlockingErrors: [], skippedReason: "bootstrap" }),
      fire: () => {},
      toolAdapter: () => ({
        preToolUse: async () => null,
        postToolUse: async () => {},
        postToolUseFailure: async () => {},
      }),
    },
    autoMemory: null,
    memoryDiscipline: "",
    autoMemoryListing: () => null,
    skills: {
      all: () => [],
      warnings: () => [],
      listing: () => null,
      active: () => null,
      toolFace: (base) => base,
      runByName: () => ({ text: "bootstrap", injected: null }),
    },
    plugins: {
      baseDir: () => pluginBaseDir,
      installed: () => loadInstalledPlugins(pluginBaseDir),
      agents: () => pluginAgentDefs,
      warnings: () => [...pluginDocs.warnings, ...pluginSkillWarnings, ...pluginAgentWarnings],
    },
    agents: {
      registry: () => agentsRegistry,
      names: () => agentsRegistry.names(),
      loadProjectAgents,
      state: () => ({ ...agentsState, stripped: [...agentsState.stripped], warnings: [...agentsState.warnings] }),
      prepareSpawn,
    },
    drainMcpNotifications: () => [],
    switchProvider(name: string) {
      const n = name.toLowerCase();
      const built = buildProvider(n, env, gatedSettings, keychain);
      session.provider = built.provider;
      session.providerName = built.providerName;
      session.catalog = init.catalog ?? built.catalog;
      if (!session.catalog.includes(session.model)) session.model = session.catalog[0]!;
    },
    reload() {
      // 设置重载（WP-01）：重新 loadSettings+门控+env 注入（粘滞 handle 延续）+原位替换
      const fresh = loadSettings({
        projectRoot: sessionCwd,
        ...(init.home !== undefined ? { home: init.home } : {}),
        ...(init.programData !== undefined ? { programData: init.programData } : {}),
        ...(init.platform !== undefined ? { platform: init.platform } : {}),
        ...(init.flagOverrides !== undefined ? { flagOverrides: init.flagOverrides } : {}),
      });
      const freshTrust = createTrustGate(sessionCwd, fresh, init.trusted ?? isTrusted(sessionCwd, readTrustStore(trustStoreFile)));
      applySettingsEnv(freshTrust.settings, env, settingsEnv);
      session.settings = fresh;
      session.trust = freshTrust;
      // 记忆重载（WP-02）：同参重载原位替换
      session.memory = loadMemory({
        cwd: sessionCwd,
        ...(init.home !== undefined ? { home: init.home } : {}),
        managedDir: path.dirname(managedSettingsPath(init.platform ?? process.platform, init.programData)),
        inProject: init.memoryOptions?.inProject ?? detectProjectWorkspace(sessionCwd),
        rulesEnabled: settingsValue<boolean>(freshTrust.settings, "memory.autoRead") ?? true,
        precedence: (settingsValue<MemoryPrecedence>(freshTrust.settings, "memory.precedence") ?? "claude-first"),
        ...(init.memoryOptions?.relevantPaths ? { relevantPaths: init.memoryOptions.relevantPaths } : {}),
      });
    },
    addAdditionalDirectory(dir: string) {
      // §8.3 additionalDirectories 属信任门控清单——未信任时拒绝（fail-closed，与共享层同规）
      if (!session.trust.trusted) throw new Error("add-dir requires workspace trust (accept the trust dialog first, §8.3)");
      session.additionalDirectories.push(path.resolve(dir));
    },
  };
  // —— M4-WP-02/03：MCP 装配（ADR-0040）——S-3 per-server 批准制（WP-03）：projectShared 层逐 server 过批准
  // 状态机，pending/rejected/disabled 不进合并（[CC] nxt `_440.js:154575-154589` 只收 approved 形状），低来源同名
  // 定义自然回落（Z1e `_440.js:154480-154492`）；批准/停用留痕=settings.local.json `mcpTrust`（platform 读写）。
  // 装配链串行（refreshMcp 与首装共用队列）；每次装配先 teardown（关旧连+清旧工具面）再按现行门控重连。
  session.mcpConnections = [];
  const mcpNotes: string[] = [];
  session.drainMcpNotifications = () => mcpNotes.splice(0, mcpNotes.length);
  const mcpToolNamesByServer = new Map<string, string[]>();
  const mcpProjectRoot = init.projectRoot ?? sessionCwd;
  async function refreshServerTools(conn: McpConnection): Promise<void> {
    if (!conn.client) return;
    const built = await buildMcpToolsForConnection(conn.client, {
      serverName: conn.name,
      transport: conn.config?.type ?? "stdio",
      serverTimeout: conn.config?.timeout,
      env,
      isMainLoop: true,
      registry: session.taskRegistry,
      notifications: mcpNotes,
      onToolsChanged: (serverName) => {
        const c = session.mcpConnections.find((x) => x.name === serverName);
        if (c) void refreshServerTools(c).catch(() => {}); // 刷新竞态=后写覆盖（[自定] 从简，list_changed 低频）
      },
    });
    const prev = new Set(mcpToolNamesByServer.get(conn.name) ?? []);
    if (prev.size > 0) {
      for (let i = session.tools.length - 1; i >= 0; i--) if (prev.has(session.tools[i]!.name)) session.tools.splice(i, 1);
    }
    session.tools.push(...built.tools);
    mcpToolNamesByServer.set(conn.name, built.tools.map((t) => t.name));
  }
  let mcpAssembly: Promise<void> = Promise.resolve();
  function runMcpAssembly(): Promise<void> {
    const run = mcpAssembly.then(async () => {
      const oldConns = session.mcpConnections;
      session.mcpConnections = [];
      for (const names of mcpToolNamesByServer.values()) {
        const set = names instanceof Set ? names : new Set(names);
        for (let i = session.tools.length - 1; i >= 0; i--) if (set.has(session.tools[i]!.name)) session.tools.splice(i, 1);
      }
      mcpToolNamesByServer.clear();
      await Promise.allSettled(oldConns.map((c) => c.close()));
      try {
        const docs = session.trust.settings.docs;
        const mcpDocs: Partial<Record<McpSourceName, Record<string, unknown> | null>> = {};
        for (const src of ["user", "projectShared", "projectLocal", "flag", "managed"] as const) {
          mcpDocs[src] = (docs[src] as Record<string, unknown> | null) ?? null;
        }
        if (pluginDocs.mcpDoc !== null) mcpDocs.plugin = pluginDocs.mcpDoc; // M4-WP-09：plugin 合并位（低→高在 projectLocal 之上）
        const gate = gateMcpServerDocs({
          docs: mcpDocs,
          trusted: session.trust.trusted,
          enableAllProjectMcpServers: settingsValue<boolean>(session.trust.settings, "enableAllProjectMcpServers") === true,
          records: readMcpTrust(mcpProjectRoot),
        });
        session.mcpGateStates = gate.states;
        session.mcpRawServers = loadMcpServerConfigs(mcpDocs, env).servers; // 门控前全集（/mcp list 消费）
        const loaded = loadMcpServerConfigs(gate.docs, env);
        const conns = await connectAll(loaded, {
          cwd: sessionCwd,
          sessionId: session.id || "standardcode-session",
          envBase: env,
        });
        session.mcpConnections = conns;
        for (const conn of conns) {
          if (conn.status === "connected") await refreshServerTools(conn).catch(() => {});
        }
      } catch {
        // 装配异常=零 MCP 工具（降级不阻塞会话；/mcp 可见面）
      }
    });
    mcpAssembly = run.catch(() => {});
    return run;
  }
  session.mcpReady = runMcpAssembly();
  session.refreshMcp = () => runMcpAssembly();
  // —— M4-WP-07：i18n（会话级 lang 快照；env > settings.language > en，非法值告警回退——ADR-0042）——
  session.i18n = createI18n(resolveLang(env, settingsValue<string>(session.trust.settings, "language")));
  configureI18n(session.i18n.lang); // 模块级 active 同步（R3：命令面/运行时 t() 与会话同语言）
  // —— M4-WP-04：hooks 引擎（§9.3 附注 13 事件；settings 五来源+disableAllHooks+信任门运行时判定 :262013）——
  // M4-WP-09：plugin hooks 源位（合并序最低=组末执行；仍受引擎信任门约束——两门都要，卡边界）。
  const hookDocs: Partial<Record<McpSourceName, Record<string, unknown> | null>> = { ...session.trust.settings.docs };
  if (pluginDocs.hooksDoc !== null) hookDocs.plugin = pluginDocs.hooksDoc;
  const hookEngine: HookEngine = createHookEngine(loadHookConfigs(hookDocs), {
    trusted: () => session.trust.trusted,
    cwd: sessionCwd,
    ...(session.id ? { sessionId: session.id } : {}),
  });
  /** ToolHooks 装配（WP-10 提取共用：父会话引擎与 agent 级引擎同形制——原内联闭包零行为变化）。
   * opts.notification=false=子代理适配器（WP-04 M5）：Notification 不在 tut 传播集（dig-04 §2.2 :62093），
   * 子代理权限请求不触发 piggyback（超出集不做 [自定]）。 */
  function makeToolHooks(engine: HookEngine, opts?: { notification?: boolean }): ToolHooks {
    return {
      preToolUse: async (name, input) => {
        const o = await engine.fire("PreToolUse", { query: { toolName: name }, payload: { tool_name: name, tool_input: input } });
        if (o.verdict === "deny") return { decision: "deny", reason: o.blockingError ?? o.decisionReason?.reason ?? "PreToolUse hook denied" };
        if (o.verdict === "ask") return { decision: "ask", reason: o.decisionReason?.reason };
        return null;
      },
      postToolUse: async (name, input, content) => {
        await engine.fire("PostToolUse", { query: { toolName: name }, payload: { tool_name: name, tool_input: input, tool_response: content } });
      },
      postToolUseFailure: async (name, input, error) => {
        await engine.fire("PostToolUseFailure", { query: { toolName: name }, payload: { tool_name: name, tool_input: input, error } });
      },
      permissionRequest: async (name, input) => {
        await engine.fire("PermissionRequest", { query: { toolName: name }, payload: { tool_name: name, tool_input: input } });
        // Notification 触发面：权限确认请求（[CC] Notification 语义对位；MCP 后台通知 drain 循环另有触发位）
        if (opts?.notification !== false) await engine.fire("Notification", { payload: { message: `StandardCode needs your permission to use ${name}` } });
      },
    };
  }
  /** WP-10 DoD⑤（ADR-0043 决策 6）+ WP-04（M5）传播接通：子代理工具链 hooks 执行面——
   * 合并引擎=全会话源集（settings 五来源+plugin，hookDocs 同一合并面）+确认后 def.hooks 经 agent 源位追加（最低位，
   * "agent 声明只追加于全会话源之后"）。disableAllHooks 总闸随源集 OR 形自动延伸（任一来源 true 即子代理引擎
   * 同轮全关——M4 WP-10 核验 O1 清偿：旁路面 fail-open→fail-closed）；信任门共用会话运行时判定。 */
  function agentHooksFor(def?: SubagentDefinition): ToolHooks {
    const docs: Partial<Record<HookSourceName, Record<string, unknown> | null>> = { ...hookDocs };
    if (def?.hooks !== undefined) docs.agent = { hooks: def.hooks };
    const engine = createHookEngine(loadHookConfigs(docs), {
      trusted: () => session.trust.trusted,
      cwd: sessionCwd,
      ...(session.id ? { sessionId: session.id } : {}),
    });
    return makeToolHooks(engine, { notification: false });
  }
  session.hooks = {
    gate: async (event, query, payload, stopHookActive) =>
      hookEngine.fire(event, { ...(query !== undefined ? { query } : {}), payload, ...(stopHookActive ? { stopHookActive: true } : {}) }),
    fire: (event, query, payload) => {
      void hookEngine.fire(event, { ...(query !== undefined ? { query } : {}), payload }).catch(() => {});
    },
    toolAdapter: () => makeToolHooks(hookEngine),
  };
  // —— M4-WP-06：自动记忆轨（§9.1 ②；memory.autoTrack [自定] 缺省开=MEM-042 同向；索引/互链+纪律段）——
  const autoTrackEnabled = settingsValue<boolean>(session.trust.settings, "memory.autoTrack") ?? true;
  const autoMemoryDir = projectMemoryDir(sessionCwd, init.home ? path.join(init.home, ".standardcode") : undefined);
  session.autoMemory = autoTrackEnabled ? loadAutoMemory(autoMemoryDir) : null;
  session.memoryDiscipline = autoTrackEnabled ? buildMemoryDisciplinePrompt() : "";
  let autoMemorySentHash = "";
  session.autoMemoryListing = () => {
    if (!session.autoMemory) return null;
    const text = renderAutoMemoryContext(session.autoMemory);
    if (text === null) return null;
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    if (String(h) === autoMemorySentHash) return null; // 增量：内容未变不重发
    autoMemorySentHash = String(h);
    return text;
  };

  // —— M4-WP-05：skills（DoD② 三源发现+SEC-070 信任门前置；Skill 工具注册进工具面；清单增量/激活收窄/usage 半衰期内存态 [自定]）——
  // M4-WP-09：plugin 源注入面（DoD② "plugin 层 WP-09 后生效"兑现；同名去重 rank=可调用版优先+user>project>plugin）。
  const loadedSkills = loadSkills({ ...(init.home !== undefined ? { home: init.home } : {}), projectRoot: sessionCwd, trusted: session.trust.trusted, pluginSkills });
  const skillUsage: Record<string, SkillUsageRecord> = {};
  const sentSkillNames = new Set<string>();
  const sentSkillHashes = new Set<string>();
  let activeSkillState: { name: string; allowedTools?: string[] } | null = null;
  const skillTool = createSkillTool({
    findSkill: (name) => {
      const s = loadedSkills.skills.find((x) => x.name === name);
      return s ? { name: s.name, description: s.description, allowedTools: s.allowedTools, disableModelInvocation: s.disableModelInvocation, contentHash: s.contentHash, body: s.body, dir: s.dir } : undefined;
    },
    projectDir: sessionCwd,
    get sessionId() {
      return session.id;
    },
    bumpUsage: (name) => {
      const u = skillUsage[name] ?? { count: 0, lastUsedAt: 0 };
      skillUsage[name] = { count: u.count + 1, lastUsedAt: Date.now() };
    },
    wasSent: (h) => sentSkillHashes.has(h),
    markSent: (h) => sentSkillHashes.add(h),
    activate: (a) => {
      activeSkillState = a;
    },
  });
  session.tools.push(skillTool);
  session.skills = {
    all: () => loadedSkills.skills,
    warnings: () => loadedSkills.warnings,
    listing: () => {
      const invocable = loadedSkills.skills.filter((s) => !s.disableModelInvocation); // 清单隐身双轨（:257572）
      if (invocable.length === 0) return null;
      const newOnes = invocable.filter((s) => !sentSkillNames.has(s.name));
      if (newOnes.length === 0) return null; // DoD⑧ 增量：无新增不发
      const built = buildSkillListing(
        invocable.map((s) => ({ name: s.name, description: s.description, ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}) })),
        { contextTokens: session.provider.capabilities(session.model).contextWindow, usage: skillUsage },
      );
      const lines = built.lines.filter((line) => {
        const body = line.startsWith("- ") ? line.slice(2) : line;
        const name = body.includes(": ") ? body.slice(0, body.indexOf(": ")) : body;
        return newOnes.some((n) => n.name === name);
      });
      for (const n of newOnes) sentSkillNames.add(n.name);
      return SKILL_LISTING_HEADER + lines.join("\n"); // :318109 头逐字
    },
    active: () => activeSkillState,
    toolFace: (base) => {
      const a = activeSkillState;
      if (!a?.allowedTools || a.allowedTools.length === 0) return base;
      const allow = new Set([...a.allowedTools, "Skill"]); // Skill 工具恒保留（切换/退出通道 [自定]）
      return base.filter((t) => allow.has(t.name));
    },
    runByName: (name, args) => {
      const s = loadedSkills.skills.find((x) => x.name === name);
      if (!s) throw new Error(`no skill named "${name}"（/skills 查看清单）`);
      skillUsage[name] = { count: (skillUsage[name]?.count ?? 0) + 1, lastUsedAt: Date.now() };
      activeSkillState = { name: s.name, ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}) }; // 用户点名同激活白名单 [自定]
      if (sentSkillHashes.has(s.contentHash)) return { text: `[skills] ${name}: ${SKILL_ALREADY_LOADED_NOTE}`, injected: null };
      sentSkillHashes.add(s.contentHash);
      return { text: session.i18n.t("repl.skills.invoked", { value: name }), injected: expandSkillBody(s.body, { skillDir: s.dir, projectDir: sessionCwd, sessionId: session.id, args }) };
    },
  };
  session.mcpServers = () => {
    const views: McpServerView[] = [];
    const active = new Set<string>();
    for (const c of session.mcpConnections) {
      const st = session.mcpGateStates.find((s) => s.name === c.name && s.origin === c.origin);
      views.push({
        name: c.name,
        origin: c.origin,
        transport: c.config?.type ?? "stdio",
        state: st?.state ?? "approved",
        status: c.status,
        ...(c.error !== undefined ? { error: c.error } : {}),
      });
      active.add(c.name);
    }
    for (const s of session.mcpRawServers) {
      if (active.has(s.name)) continue;
      const st = session.mcpGateStates.find((x) => x.name === s.name && x.origin === s.origin);
      views.push({ name: s.name, origin: s.origin, transport: s.config.type, state: st?.state ?? "pending" });
    }
    return views;
  };
  session.mcpRecord = async (action, name) => {
    const known = session.mcpRawServers.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!known) throw new Error(`no MCP server named "${name}"（/mcp list 查看清单）`);
    const base: McpTrustRecord = readMcpTrust(mcpProjectRoot)[name.toLowerCase()] ?? {};
    if (action === "approve" || action === "reject") {
      // S-3"来源持久记录"：从 raw 定义快照传输+命令或 URL（插值前——${VAR} 字面留痕，不落解析值）。
      const rec: McpTrustRecord = { ...base, decision: action === "approve" ? "approved" : "rejected", confirmedAt: new Date().toISOString() };
      // M4-WP-09：plugin 源 server 的 raw=manifest mcpServers 声明聚合件（同样插值前留痕口径）。
      const doc = known.origin === "plugin" ? pluginDocs.mcpDoc : (session.trust.settings.docs[known.origin] as Record<string, unknown> | null | undefined);
      const servers = doc?.mcpServers;
      const raw = (servers !== null && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>)[known.name] : undefined) as Record<string, unknown> | undefined;
      const t = parseTransportType(raw?.type);
      if ("kind" in t) {
        rec.transport = t.kind;
        if (t.kind === "stdio") {
          const cmd = typeof raw?.command === "string" ? raw.command : "";
          const args = Array.isArray(raw?.args) ? (raw.args as unknown[]).filter((a): a is string => typeof a === "string") : [];
          rec.command = [cmd, ...args].join(" ");
        } else if (typeof raw?.url === "string") {
          rec.url = raw.url;
        }
      }
      recordMcpTrust(mcpProjectRoot, name, rec);
    } else {
      recordMcpTrust(mcpProjectRoot, name, { ...base, disabled: action === "disable", confirmedAt: new Date().toISOString() });
    }
    await session.refreshMcp();
  };
  return session;
}

/** WP-11 /provider：按名重建 adapter（MDL-010~013 常规入口；缺 key/未知名抛错）。
 * SEC-030 密钥优先级链（WP-05 清偿）：keychain > 环境变量 > settings env 注入（明文面由 settings 疑似密钥告警覆盖）；
 * keychain 未命中/适配器不可用=fail-open 静默回落（keychain.ts 契约）。 */
function buildProvider(
  name: string,
  env: Record<string, string | undefined>,
  settings: LoadedSettings,
  keychain?: KeychainAdapter,
): { provider: ProviderAdapter; providerName: string; catalog: readonly string[] } {
  const fromKeychain = keychain?.getSecret(keychainAccountFor(name)) ?? null;
  const apiKey = fromKeychain ?? (name === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!apiKey) {
    const account = keychainAccountFor(name);
    throw new Error(
      `missing API key: set ${name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}（keychain service "standardcode" account "${account}" 优先，其次 env 或 settings 的 env.<KEY> 注入，键位见 ADR-0030/SEC-030）`,
    );
  }
  const baseUrl = env.STANDARD_CODE_BASE_URL ?? settingsValue<string>(settings, `providers.${name}.baseUrl`);
  const opts: ProviderOptions = { apiKey, ...(baseUrl ? { baseUrl } : {}) };
  if (name === "anthropic") {
    return { provider: new AnthropicAdapter(ANTHROPIC_ENTRIES, opts), providerName: name, catalog: Object.keys(ANTHROPIC_ENTRIES) };
  }
  if (name === "openai") {
    const models = parseCatalogEnv(env.STANDARD_CODE_MODELS) ?? settingsValue<string[]>(settings, "providers.openai.models") ?? null;
    if (!models) throw new Error("openai provider requires a model catalog: STANDARD_CODE_MODELS env or settings providers.openai.models（不内置 OpenAI 目录；键位见 ADR-0030）");
    const entries: Record<string, OpenAIModelEntry> = {};
    for (const m of models) entries[m] = { contextWindow: 128_000, maxOutputTokens: { default: 32_000, upper: 32_000 }, thinking: "none", input: ["text"] };
    // 线制键（ADR-0039）：wire_api=chat（缺省，M1/M2 行为）| responses（M3 Responses API）
    const wireApi = parseWireApi(env.STANDARD_CODE_WIRE_API ?? settingsValue<string>(settings, "providers.openai.wire_api"));
    if (wireApi === "responses") {
      return { provider: new ResponsesAdapter(entries, opts), providerName: name, catalog: models };
    }
    return { provider: new OpenAIChatAdapter(entries, opts), providerName: name, catalog: models };
  }
  throw new Error(`unknown provider: ${name}（可选 anthropic|openai）`);
}

function parseCatalogEnv(raw: string | undefined): string[] | null {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}
