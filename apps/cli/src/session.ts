// 会话状态与 L5 装配（v2.8 §5.1 L0 消费 L1/L5；§8.3 EXE-001 权限四模式）。
// [自定] M1 无配置系统（§7.7 属 M2）：provider/模型目录由 env 直读或注入；模型目录为内置最小集
//（WP-01 边界：不做模型目录全集），数值取 v2.8 MDL-001 注记（claude-sonnet-4-6=32000/128000、claude-opus-5=64000/128000，_695.js 实测），
// maxOutputTokens.upper 缺证取=default，thinking/input 能力位 [自定]。
import { AnthropicAdapter, OpenAIChatAdapter, type AnthropicModelEntry, type LLMMessage, type OpenAIModelEntry, type ProviderAdapter, type ProviderOptions } from "@standardcode/providers";
import { UsageMeter } from "@standardcode/context";
import { createStandardTools, type StandardTool } from "@standardcode/capabilities";

// EXE-001：Manual↔default、Plan↔plan、Accept Edits↔acceptEdits、Auto↔bypassPermissions；
// 循环切换序 default → acceptEdits → plan → bypassPermissions → default（首版四模式，auto 档 M5+ MAY）。
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "Manual",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "Auto",
};

export interface Session {
  provider: ProviderAdapter;
  providerName: string;
  /** /model 可切目录（WP-01 adapter 模型目录投影）。 */
  catalog: readonly string[];
  model: string;
  messages: LLMMessage[];
  tools: StandardTool[];
  cwd: string;
  meter: UsageMeter;
  permissionMode: PermissionMode;
  exitRequested: boolean;
  /** 进行中 turn 的中断控制器（Ctrl+C → abort；§8.4 中断不变量的 L0 触发点）。 */
  activeAbort: AbortController | null;
}

export interface SessionInit {
  /** 直接注入 ProviderAdapter（测试/自定义装配）。 */
  provider?: ProviderAdapter;
  providerName?: string;
  catalog?: readonly string[];
  model?: string;
  cwd?: string;
  /** env 直读时的替身（测试）。 */
  env?: NodeJS.ProcessEnv;
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
  const env = init.env ?? process.env;
  let providerName = (init.providerName ?? env.STANDARD_CODE_PROVIDER ?? "anthropic").toLowerCase();
  let provider: ProviderAdapter;
  let catalog: readonly string[];
  if (init.provider) {
    provider = init.provider;
    providerName = init.providerName ?? providerName;
    catalog = init.catalog ?? [];
  } else {
    const apiKey = providerName === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        `missing API key: set ${providerName === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}（M1 env 直读，配置文件系统属 M2 §7.7）`,
      );
    }
    const opts: ProviderOptions = { apiKey, ...(env.STANDARD_CODE_BASE_URL ? { baseUrl: env.STANDARD_CODE_BASE_URL } : {}) };
    if (providerName === "anthropic") {
      provider = new AnthropicAdapter(ANTHROPIC_ENTRIES, opts);
      catalog = init.catalog ?? Object.keys(ANTHROPIC_ENTRIES);
    } else if (providerName === "openai") {
      const models = parseCatalogEnv(env.STANDARD_CODE_MODELS);
      if (!models) throw new Error("openai provider requires STANDARD_CODE_MODELS (comma-separated model names)——M1 不内置 OpenAI 模型目录（WP-01 边界：不做模型目录全集）");
      const entries: Record<string, OpenAIModelEntry> = {};
      for (const m of models) entries[m] = { contextWindow: 128_000, maxOutputTokens: { default: 32_000, upper: 32_000 }, thinking: "none", input: ["text"] };
      provider = new OpenAIChatAdapter(entries, opts);
      catalog = models;
    } else {
      throw new Error(`unknown provider: ${providerName}（可选 anthropic|openai）`);
    }
  }
  catalog = init.catalog ?? catalog;
  const model = init.model ?? env.STANDARD_CODE_MODEL ?? catalog[0];
  if (!model) throw new Error("no model available: pass model/catalog or set STANDARD_CODE_MODEL");
  return {
    provider,
    providerName,
    catalog,
    model,
    messages: [],
    tools: createStandardTools({ cwd: init.cwd ?? process.cwd() }),
    cwd: init.cwd ?? process.cwd(),
    meter: new UsageMeter(),
    permissionMode: "default",
    exitRequested: false,
    activeAbort: null,
  };
}

function parseCatalogEnv(raw: string | undefined): string[] | null {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}
