// WP-03 沙箱装配解析（EXE-011 行 427"沙箱默认不启用（ADR-002）；/sandbox 或 -sdb 显式开启；
// 开启时默认档 workspace-write"——/sandbox 斜杠命令=M7-WP-06 已注册（apps/cli/src/commands.ts 末位），
// 本文件仍为唯一读侧单源：命令面与启动装配共用 resolveSandboxSettings，不另立第二套判定）。
// 键位 [自定] 登记（附录 C 义务走结果页，WP-07 先例形制）：
//   启用 = env STANDARD_CODE_SANDBOX("1"/"0"，逃逸舱总闸凌驾一切) > cli -sdb 旗标 > settings sandbox.enabled > 缺省关；
//   档位 = env STANDARD_CODE_SANDBOX_TIER > settings sandbox.tier > "workspace-write"（EXE-011 默认档）；
//   二进制 = env STANDARD_CODE_SANDBOX_BIN > 探针（executor resolveSandboxBinary 内联形）。
// fail-closed 形：无效档值/非法 env 形=不启用+提示（不猜档回退——猜=旁路面）。
// danger-full-access 确认义务（行 256"显式确认后"，DoD③）：gateDangerTier 由装配方注入确认
// （TTY 对话框；非 TTY=拒绝=不启用沙箱，fail-closed 非降级）。
// settings 形参=装配点已解析值（settingsValue 读取在调用侧，本函数纯逻辑可单测）。
//
// M7-WP-06 增补（/sandbox 命令与用户开关 UI；不改本文件既有解析语义）：点路径键常量、
// 生效来源展示（sandboxActivationSource）、后端探针（probeSandboxBackend）。三者皆纯函数，
// 命令面（repl.ts）与测试共用；enabled/tier 恒由 resolveSandboxSettings 产出，此处不重判。

import { resolveSandboxBinary, SANDBOX_TIERS, type SandboxTier } from "@standardcode/capabilities";

/** settings 键点路径（WP-04 实测教训：本仓装配把嵌套对象展开为点路径叶子，对象值取不到——一律点路径标量键）。 */
export const SANDBOX_ENABLED_KEY = "sandbox.enabled";
export const SANDBOX_TIER_KEY = "sandbox.tier";

export interface SandboxAssembly {
  enabled: boolean;
  tier: SandboxTier;
  notice?: string;
}

function truthy(raw: string | undefined): boolean | undefined {
  const t = raw?.trim().toLowerCase();
  if (t === undefined || t === "") return undefined;
  if (/^(1|true|yes|on)$/.test(t)) return true;
  if (/^(0|false|no|off)$/.test(t)) return false;
  return undefined; // 非法形
}

export function resolveSandboxSettings(input: {
  cliFlag: boolean;
  env: Record<string, string | undefined>;
  settings: { enabled?: unknown; tier?: unknown };
}): SandboxAssembly {
  const envSwitch = truthy(input.env.STANDARD_CODE_SANDBOX);
  if (input.env.STANDARD_CODE_SANDBOX?.trim() && envSwitch === undefined) {
    return { enabled: false, tier: "workspace-write", notice: `[sandbox] STANDARD_CODE_SANDBOX 值非法（${input.env.STANDARD_CODE_SANDBOX}）——不启用（fail-closed）` };
  }
  const settingsEnabled = typeof input.settings.enabled === "boolean" ? input.settings.enabled : undefined;
  if (settingsEnabled === undefined && input.settings.enabled !== undefined && typeof input.settings.enabled !== "boolean") {
    return { enabled: false, tier: "workspace-write", notice: `[sandbox] settings sandbox.enabled 非布尔（${String(input.settings.enabled)}）——不启用（fail-closed）` };
  }
  const enabled = envSwitch ?? (input.cliFlag || settingsEnabled === true);
  if (!enabled) return { enabled: false, tier: "workspace-write" };
  const tierRaw = input.env.STANDARD_CODE_SANDBOX_TIER ?? (input.settings.tier !== undefined ? String(input.settings.tier) : undefined);
  if (tierRaw !== undefined && !(SANDBOX_TIERS as readonly string[]).includes(tierRaw)) {
    return { enabled: false, tier: "workspace-write", notice: `[sandbox] sandbox.tier 值非法（${tierRaw}）——不启用而非猜档（fail-closed）` };
  }
  return { enabled: true, tier: (tierRaw as SandboxTier | undefined) ?? "workspace-write" };
}

/** danger 档确认闸（DoD③ [自定] 确认形制登记：逐会话一次、明示档位名与全盘语义；拒绝=不启用）。 */
export async function gateDangerTier(assembly: SandboxAssembly, confirm: (tier: SandboxTier) => Promise<boolean>): Promise<SandboxAssembly> {
  if (!assembly.enabled || assembly.tier !== "danger-full-access") return assembly;
  const ok = await confirm(assembly.tier);
  if (!ok) {
    return { enabled: false, tier: assembly.tier, notice: "[sandbox] danger-full-access 未获显式确认——沙箱不启用（拒绝=不启用，非降档执行）" };
  }
  return assembly;
}

/** 生效来源（展示用；只判"哪一层先给出显式值"，不参与 enabled 判定）。 */
export type SandboxSource = "env" | "flag" | "settings" | "default";

/**
 * 生效来源判定（/sandbox 查看面的"来源"列）：env 逃逸舱 > -sdb 旗标 > settings > 缺省。
 * 注：只读"该层是否显式给了值"，**不重判 enabled**——enabled/tier 恒由 resolveSandboxSettings 产出
 * （单源不二判，WP-06 卡面铁律）。env 空串/全空白=未设置（与 resolveSandboxSettings 的 trim 口径一致）。
 */
export function sandboxActivationSource(input: {
  cliFlag: boolean;
  env: Record<string, string | undefined>;
  settings: { enabled?: unknown; tier?: unknown };
}): SandboxSource {
  if ((input.env.STANDARD_CODE_SANDBOX ?? "").trim() !== "") return "env";
  if (input.cliFlag) return "flag";
  if (input.settings.enabled !== undefined) return "settings";
  return "default";
}

/** 后端探针结果（DoD③ fail-closed 判据：ok=false 即拒开）。 */
export interface SandboxProbeResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/** 档位名校验（/sandbox tier 用；集合单源=SANDBOX_TIERS，命令面不自带枚举）。 */
export function isSandboxTier(raw: string): raw is SandboxTier {
  return (SANDBOX_TIERS as readonly string[]).includes(raw);
}

/**
 * 后端二进制探针（DoD③）：缺省走 M5 探针 `resolveSandboxBinary`（含 env STANDARD_CODE_SANDBOX_BIN），
 * 缺席=ok:false+原因。**只探不回退**：resolveSandboxBinary 自身缺位即抛 SandboxUnavailableError。
 * probe 形参=测试注入面（不依赖本机真实装没装 rust 臂）。
 */
export function probeSandboxBackend(probe?: () => string): SandboxProbeResult {
  try {
    return { ok: true, path: (probe ?? resolveSandboxBinary)() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
