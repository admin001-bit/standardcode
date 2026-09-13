// 会话状态与 L5 装配（v2.8 §5.1 L0 消费 L1/L5；§8.3 EXE-001 权限四模式）。
// M2 WP-01：M1"env 直读"偏差清偿——启动装配经 platform/settings 五来源合并（§7.7）；
// STANDARD_CODE_* env 为保留逃逸舱（MDL-010~013），优先级 env > settings > 默认（ADR-0030）。
// 模型目录为内置最小集（WP-01 边界：不做模型目录全集），数值取 v2.8 MDL-001 注记
//（claude-sonnet-4-6=32000/128000、claude-opus-5=64000/128000，_695.js 实测），
// maxOutputTokens.upper 缺证取=default，thinking/input 能力位 [自定]。
import { AnthropicAdapter, OpenAIChatAdapter, ResponsesAdapter, parseWireApi, type AnthropicModelEntry, type LLMMessage, type OpenAIModelEntry, type ProviderAdapter, type ProviderOptions } from "@standardcode/providers";
import { UsageMeter } from "@standardcode/context";
import { buildMcpToolsForConnection, connectAll, createHookEngine, createSkillTool, createStandardTools, expandSkillBody, gateMcpServerDocs, loadHookConfigs, loadMcpServerConfigs, loadSkills, parseTransportType, SKILL_ALREADY_LOADED_NOTE, SKILL_LISTING_HEADER, buildSkillListing, type HookEngine, type HookEventName, type HookEventOutcome, type LoadedSkill, type McpApprovalState, type McpConnection, type McpServerEntry, type McpSourceName, type SkillUsageRecord, type StandardTool } from "@standardcode/capabilities";
import { createPermissionBroker, createTaskRegistry, type PermissionBroker, type Ruleset, type TaskRegistry, type ToolHooks } from "@standardcode/harness";
import { applySettingsEnv, loadSettings, managedSettingsPath, settingsValue, type LoadedSettings, type SettingsEnvHandle } from "@standardcode/platform";
import { createTrustGate, isTrusted, readMcpTrust, readTrustStore, recordMcpTrust, type McpTrustRecord, type TrustGateResult } from "@standardcode/platform";
import { createCompactionCoordinator, detectProjectWorkspace, loadMemory, resolveAutocompactConfig, type CompactionCoordinator, type LoadedMemory, type MemoryPrecedence, type ThinkingSetting } from "@standardcode/context";
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
  /** 任务注册表（M3 WP-04；/subtask 走 spawn 与 WP-05 /tasks 面板的共享实例）。 */
  taskRegistry: TaskRegistry;
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
  /** 记忆加载覆写（测试/特殊装配）：inProject 缺省=MEM-043 检测（cwd 祖先链有 .git/.standardcode）。 */
  memoryOptions?: { inProject?: boolean; relevantPaths?: string[] };
  /** 扩展思维直接注入（测试/装配）；缺省走 env/settings 解析（resolveThinking）。 */
  thinking?: ThinkingSetting;
  /** 信任覆写（测试/装配）：缺省按 trust store 判定（WP-07）。 */
  trusted?: boolean;
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
    const built = buildProvider(providerName, env, gatedSettings);
    provider = built.provider;
    providerName = built.providerName;
    catalog = built.catalog;
  }
  catalog = init.catalog ?? catalog;
  const modelDefault = settingsValue<string>(settings, "model.default");
  const model = init.model ?? env.STANDARD_CODE_MODEL ?? modelDefault ?? catalog[0];
  if (!model) throw new Error("no model available: pass model/catalog or set STANDARD_CODE_MODEL or settings model.default");
  const session: Session = {
    id: "",
    provider,
    providerName,
    catalog,
    model,
    messages: [],
    tools: createStandardTools({ cwd: init.cwd ?? process.cwd() }),
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
    env,
    additionalDirectories: [...(settingsValue<string[]>(gatedSettings, "additionalDirectories") ?? [])],
    ...(init.home !== undefined ? { home: init.home } : {}),
    // —— WP-11：/provider /reload /add-dir 会话操作面（MDL-010~013 下一 turn 生效；M1 环境重载语义）——
    taskRegistry: createTaskRegistry(),
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
    skills: {
      all: () => [],
      warnings: () => [],
      listing: () => null,
      active: () => null,
      toolFace: (base) => base,
      runByName: () => ({ text: "bootstrap", injected: null }),
    },
    drainMcpNotifications: () => [],
    switchProvider(name: string) {
      const n = name.toLowerCase();
      const built = buildProvider(n, env, gatedSettings);
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
        for (const src of ["user", "projectShared", "projectLocal", "flag", "managed"] as McpSourceName[]) {
          mcpDocs[src] = (docs[src] as Record<string, unknown> | null) ?? null;
        }
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
  // —— M4-WP-04：hooks 引擎（§9.3 附注 13 事件；settings 五来源+disableAllHooks+信任门运行时判定 :262013）——
  const hookEngine: HookEngine = createHookEngine(loadHookConfigs(session.trust.settings.docs), {
    trusted: () => session.trust.trusted,
    cwd: sessionCwd,
    ...(session.id ? { sessionId: session.id } : {}),
  });
  session.hooks = {
    gate: async (event, query, payload, stopHookActive) =>
      hookEngine.fire(event, { ...(query !== undefined ? { query } : {}), payload, ...(stopHookActive ? { stopHookActive: true } : {}) }),
    fire: (event, query, payload) => {
      void hookEngine.fire(event, { ...(query !== undefined ? { query } : {}), payload }).catch(() => {});
    },
    toolAdapter: () => ({
      preToolUse: async (name, input) => {
        const o = await hookEngine.fire("PreToolUse", { query: { toolName: name }, payload: { tool_name: name, tool_input: input } });
        if (o.verdict === "deny") return { decision: "deny", reason: o.blockingError ?? o.decisionReason?.reason ?? "PreToolUse hook denied" };
        if (o.verdict === "ask") return { decision: "ask", reason: o.decisionReason?.reason };
        return null;
      },
      postToolUse: async (name, input, content) => {
        await hookEngine.fire("PostToolUse", { query: { toolName: name }, payload: { tool_name: name, tool_input: input, tool_response: content } });
      },
      postToolUseFailure: async (name, input, error) => {
        await hookEngine.fire("PostToolUseFailure", { query: { toolName: name }, payload: { tool_name: name, tool_input: input, error } });
      },
      permissionRequest: async (name, input) => {
        await hookEngine.fire("PermissionRequest", { query: { toolName: name }, payload: { tool_name: name, tool_input: input } });
        // Notification 触发面：权限确认请求（[CC] Notification 语义对位；MCP 后台通知 drain 循环另有触发位）
        await hookEngine.fire("Notification", { payload: { message: `StandardCode needs your permission to use ${name}` } });
      },
    }),
  };
  // —— M4-WP-05：skills（DoD② 三源发现+SEC-070 信任门前置；Skill 工具注册进工具面；清单增量/激活收窄/usage 半衰期内存态 [自定]）——
  const loadedSkills = loadSkills({ ...(init.home !== undefined ? { home: init.home } : {}), projectRoot: sessionCwd, trusted: session.trust.trusted });
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
      return { text: `[skills] invoked ${name}（内容已注入会话）`, injected: expandSkillBody(s.body, { skillDir: s.dir, projectDir: sessionCwd, sessionId: session.id, args }) };
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
      const doc = session.trust.settings.docs[known.origin] as Record<string, unknown> | null | undefined;
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

/** WP-11 /provider：按名重建 adapter（MDL-010~013 常规入口；缺 key/未知名抛错）。 */
function buildProvider(
  name: string,
  env: Record<string, string | undefined>,
  settings: LoadedSettings,
): { provider: ProviderAdapter; providerName: string; catalog: readonly string[] } {
  const apiKey = name === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      `missing API key: set ${name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}（env 或 settings 的 env.<KEY> 注入，键位见 ADR-0030）`,
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
