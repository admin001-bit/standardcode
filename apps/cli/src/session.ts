// 会话状态与 L5 装配（v2.8 §5.1 L0 消费 L1/L5；§8.3 EXE-001 权限四模式）。
// M2 WP-01：M1"env 直读"偏差清偿——启动装配经 platform/settings 五来源合并（§7.7）；
// STANDARD_CODE_* env 为保留逃逸舱（MDL-010~013），优先级 env > settings > 默认（ADR-0030）。
// 模型目录为内置最小集（WP-01 边界：不做模型目录全集），数值取 v2.8 MDL-001 注记
//（claude-sonnet-4-6=32000/128000、claude-opus-5=64000/128000，_695.js 实测），
// maxOutputTokens.upper 缺证取=default，thinking/input 能力位 [自定]。
import { AnthropicAdapter, OpenAIChatAdapter, ResponsesAdapter, parseWireApi, type AnthropicModelEntry, type LLMMessage, type OpenAIModelEntry, type ProviderAdapter, type ProviderOptions } from "@standardcode/providers";
import { UsageMeter } from "@standardcode/context";
import { createStandardTools, type StandardTool } from "@standardcode/capabilities";
import { createPermissionBroker, type PermissionBroker, type Ruleset } from "@standardcode/harness";
import { applySettingsEnv, loadSettings, managedSettingsPath, settingsValue, type LoadedSettings, type SettingsEnvHandle } from "@standardcode/platform";
import { createTrustGate, isTrusted, readTrustStore, type TrustGateResult } from "@standardcode/platform";
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
