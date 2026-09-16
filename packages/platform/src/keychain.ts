// SEC-030/S-6 密钥存储优先级链（WP-05 清偿）：keychain > 环境变量 > settings 明文（警告，settings.ts 疑似密钥扫描）。
// 本模块=链首 keychain 读面适配器：macOS `security` / Linux `secret-tool` CLI；Windows Win32 CredRead
// 无原生面可依（Node 无内置凭据库；承 windows elevated 同族后续面）→ unavailable 恒 null（fail-open，
// 链自然回落 env）。spawnSync 1.5s 超时硬顶（secret-service 缺 dbus 时挂起风险）；任何失败=null 永不抛。
// [自定] 登记：service 名 "standardcode"、account 命名 `api-key:<provider>`、负缓存=适配器实例级（缺失不重试）、
// Windows 适配器缺位、查得空值/非零退出/超时一律 null。
import { spawnSync } from "node:child_process";

/** keychain service 名（本仓约定；外部写入用 OS 工具：`security add-generic-password -s standardcode -a api-key:anthropic -w <key>`）。 */
export const KEYCHAIN_SERVICE_NAME = "standardcode";

/** provider 名 → keychain account（本仓命名约定 [自定]）。 */
export function keychainAccountFor(provider: string): string {
  return `api-key:${provider}`;
}

export interface KeychainAdapter {
  /** 适配器平台名（诊断面："security" | "secret-tool" | "unavailable"）。 */
  readonly name: string;
  /** 读密钥；缺失/不可用/任何失败 = null（fail-open，永不抛）。 */
  getSecret(account: string): string | null;
}

interface SyncRunResult {
  status: number | null;
  stdout: string;
  spawnError: boolean;
}

export type SyncExec = (file: string, args: string[]) => SyncRunResult;

function defaultExec(file: string, args: string[]): SyncRunResult {
  try {
    const r = spawnSync(file, args, { timeout: 1500, encoding: "utf8", windowsHide: true });
    return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "", spawnError: r.error !== undefined };
  } catch {
    return { status: null, stdout: "", spawnError: true };
  }
}

/** 平台 keychain 读适配器（缺省 runner=spawnSync；测试注入 fake）。负缓存=适配器实例级
 *（同 account 首查缺失后实例内不再重试）[自定]；缺省适配器=模块级单例（进程内共享负缓存，
 * 会话装配重复走链零重复 spawn；测试注入的适配器各自独立实例不受影响）。 */
let defaultAdapter: KeychainAdapter | null = null;

/** 缺省适配器（单例）；显式传 platform/exec 时新建实例（测试/多平台面）。 */
export function createKeychainAdapter(platform: NodeJS.Platform = process.platform, exec?: SyncExec): KeychainAdapter {
  if (platform === process.platform && exec === undefined) {
    if (defaultAdapter === null) defaultAdapter = build(platform, defaultExec);
    return defaultAdapter;
  }
  return build(platform, exec ?? defaultExec);
}

function build(platform: NodeJS.Platform, exec: SyncExec): KeychainAdapter {
  const missCache = new Set<string>();
  const lookup = (adapter: string, cacheKey: string, file: string, args: string[]): string | null => {
    if (missCache.has(cacheKey)) return null;
    const r = exec(file, args);
    const value = !r.spawnError && r.status === 0 ? r.stdout.trim() : "";
    if (value === "") {
      missCache.add(cacheKey);
      return null;
    }
    return value;
  };
  if (platform === "darwin") {
    return {
      name: "security",
      getSecret(account) {
        return lookup("security", account, "security", ["find-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-a", account, "-w"]);
      },
    };
  }
  if (platform === "linux") {
    return {
      name: "secret-tool",
      getSecret(account) {
        return lookup("secret-tool", account, "secret-tool", ["lookup", "service", KEYCHAIN_SERVICE_NAME, "account", account]);
      },
    };
  }
  // win32/其他：Win32 CredRead 需原生面（Node 无内置凭据库）——unavailable 恒 null [自定]，链回落 env。
  return {
    name: "unavailable",
    getSecret() {
      return null;
    },
  };
}
