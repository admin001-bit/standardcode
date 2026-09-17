// WP-08（M4）：/update 自动更新检查——ENG-041 落地（v2.8 §10 行 431；§8.2 M4 增 /update）。
// 通道=附录 E（行 630）npm registry（`@standardcode-oss/cli` 全平台首选；GitHub Releases/二进制通道=M5 边界）。
// 检查/提示形状无 [CC] 一手锚→全 [自定]（卡参考资料栏预登记；mini 决策走结果页偏差登记，B-06 判定
// 不构成未覆盖级：机制主干在 spec 文字）。更新原子性=M5 设计（§13 行 534），本模块不含原子回滚面。
// 纯函数+注入面（fetchImpl/runner，仿 mcp/transport.ts 形制）：测试全离线零网络（卡交付物"网络注入面"）。
import { spawn } from "node:child_process";
import { stripEnvBaseline } from "./env-baseline.ts";

/** 附录 E 包名（npm `@standardcode-oss/cli`）。 */
export const NPM_PACKAGE_NAME = "@standardcode-oss/cli";

/** DoD③ 检查超时上限 [自定]：10s（网络闪断快速降级；AbortSignal.timeout 内部 unref 计时器——不吊事件循环）。 */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** registry 缺省 URL（scoped 包名 percent-encode；测试可覆写 registryUrl）。 */
export const DEFAULT_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE_NAME)}/latest`;

/** 附录 C（行 616）env 键：未设置=缺省关（DoD④）；"1" 启用（其余值=关，取严方向 [自定]）。 */
export const AUTO_UPDATE_ENV_KEY = "STANDARD_CODE_AUTO_UPDATE";

export type UpdateCheckResult = { ok: true; latest: string } | { ok: false; reason: string };

/**
 * DoD①②③：查 npm registry 最新版本。任何失败（非 2xx/坏体/超时/异常）=结构化 ok:false 不抛——
 * auto 路静默降级、手动路转三件套（ADR-0034）由调用方裁决。
 */
export async function checkRegistryLatest(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; registryUrl?: string } = {},
): Promise<UpdateCheckResult> {
  const url = opts.registryUrl ?? DEFAULT_REGISTRY_LATEST_URL;
  const timeoutMs = opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: `registry responded HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, reason: `registry response is not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const version =
      body !== null && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
        ? (body as { version: string }).version
        : null;
    if (version === null || version.trim() === "") return { ok: false, reason: "registry response has no string version field" };
    return { ok: true, latest: version };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 三段数值简式比对 [自定]（dev 场景无 prerelease 判据需求）：提取数字段前 3 位，缺位补 0。返回 -1/0/1（a<b / a=b / a>b）。 */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string): number[] => {
    const nums = (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    while (nums.length < 3) nums.push(0);
    return nums;
  };
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i]! > y[i]!) return 1;
    if (x[i]! < y[i]!) return -1;
  }
  return 0;
}

/** 安装命令全硬编码（零用户输入→无注入面 [自定]；DoD① 命令字面）。 */
export const NPM_INSTALL_ARGS = ["i", "-g", `${NPM_PACKAGE_NAME}@latest`] as const;

export interface NpmRunResult {
  status: number | null;
  error?: string;
  stderrTail?: string;
  /** WP-07（ADR-0045 层二）：stdout 捕获（npm ls --json 校验路消费；additive，既有消费者零影响）。 */
  stdout?: string;
}

/** npm 子进程注入面（测试桩；缺省真 spawn shell 分型见 defaultNpmRunner）。 */
export type NpmRunner = (cmd: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<NpmRunResult>;

/** win32 → npm.cmd（npm 为 .cmd shim；Node≥18.20 裸 spawn .cmd 需 shell:true——args 全硬编码零注入面 [自定]）。 */
export function npmCliCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

const STDERR_TAIL_CHARS = 400; // 三件套 {value} 只带上尾，防爆行 [自定]
const STDOUT_CAPTURE_CHARS = 65_536; // npm ls --json 小体积；防极端爆内存 [自定]

function tailStderr(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (t === "") return undefined;
  return t.length > STDERR_TAIL_CHARS ? `…${t.slice(-STDERR_TAIL_CHARS)}` : t;
}

/** 缺省 runner：非 win32 shell:false；win32 shell:true+npm.cmd（windowsHide 对位 stdio spawn 先例）。stdout 捕获（WP-07 校验路）。 */
export const defaultNpmRunner: NpmRunner = (cmd, args, env) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_TAIL_CHARS * 4) stderr += d.toString();
    });
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < STDOUT_CAPTURE_CHARS) stdout += d.toString();
    });
    child.on("error", (err) => resolve({ status: null, error: err instanceof Error ? err.message : String(err) }));
    child.on("close", (code) => resolve({ status: code, stderrTail: tailStderr(stderr), stdout: stdout.trim() === "" ? undefined : stdout }));
  });

/** DoD①：执行全局安装。env 过 SEC-080 基线剥离（与 git clone 共享同面——env-baseline.ts）。 */
export async function runNpmUpdate(
  opts: { runner?: NpmRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<NpmRunResult> {
  const runner = opts.runner ?? defaultNpmRunner;
  const source = opts.env ?? process.env;
  return runner(npmCliCommand(opts.platform), NPM_INSTALL_ARGS, stripEnvBaseline(source));
}

// —— WP-07（ADR-0045 更新原子性；§13 行 534 清偿）：层一锁错重试 · 层二装后校验 · 层三明确引导 ——

/** Windows 文件锁族失败签名（层一判定；[自定] 名单=Node/npm 常见占用错误码）。 */
export const LOCK_ERROR_SIGNATURES: readonly string[] = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"];

/** 层一重试参数 [自定]：npm 每轮完整事务、重试间零状态残留；2 次×1.5s=占用释放的常态窗口。 */
export const ATOMIC_MAX_RETRIES = 2;
export const ATOMIC_RETRY_DELAY_MS = 1_500;

/** 成功当且仅当 status=0 且 verified=true；其余一切终态带 guidance（无半装态判据，ADR-0045 决策 1）。 */
export interface AtomicUpdateResult {
  ok: boolean;
  attempts: number;
  status: number | null;
  error?: string;
  stderrTail?: string;
  /** 层二解析结果（校验失败时缺席）。 */
  installedVersion?: string;
  verified?: boolean;
  /** 层三明确引导（失败终态必带；三件套 ADR-0034 同族）。 */
  guidance?: string;
}

function isLockError(r: NpmRunResult): boolean {
  const hay = `${r.error ?? ""} ${r.stderrTail ?? ""}`;
  return LOCK_ERROR_SIGNATURES.some((s) => hay.includes(s));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && t !== null && "unref" in t) (t as { unref?(): void }).unref?.();
  });
}

function updateGuidance(reason: string): string {
  return `update failed: ${reason}; why: ${
    reason.includes("post-verify") ? "安装命令成功但装后校验未过（可能半装态或运行中实例占用）" : "npm 更新命令失败（文件锁占用且重试未恢复，或非锁类错误不重试）"
  }; action: 关闭正在运行的 standardcode 实例后重试，或手动执行 npm i -g ${NPM_PACKAGE_NAME}@latest`;
}

/** 层二：全局实装版本查询（`npm ls -g @standardcode-oss/cli --json`；任何失败结构化不抛）。 */
export async function verifyInstalledVersion(
  opts: { runner?: NpmRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  const runner = opts.runner ?? defaultNpmRunner;
  const args = ["ls", "-g", NPM_PACKAGE_NAME, "--json"] as const;
  const r = await runner(npmCliCommand(opts.platform), args, stripEnvBaseline(opts.env ?? process.env));
  if (r.status !== 0) return { ok: false, reason: `npm ls exited ${r.status}${r.stderrTail ? `: ${r.stderrTail}` : ""}` };
  try {
    const parsed = JSON.parse(r.stdout ?? "") as { dependencies?: Record<string, { version?: unknown }> };
    const entry = parsed.dependencies?.[NPM_PACKAGE_NAME];
    const v = entry !== undefined && typeof entry.version === "string" ? entry.version : null;
    if (v === null) return { ok: false, reason: `npm ls output has no version entry for ${NPM_PACKAGE_NAME}` };
    return { ok: true, version: v };
  } catch (err) {
    return { ok: false, reason: `npm ls output is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** ADR-0045：原子更新执行（重试→校验→引导）。expectedVersion 缺省=不比对（仅校验实装存在性）。 */
export async function runNpmUpdateAtomic(
  opts: {
    runner?: NpmRunner;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    expectedVersion?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AtomicUpdateResult> {
  const maxRetries = opts.maxRetries ?? ATOMIC_MAX_RETRIES;
  const sleep = opts.sleep ?? delay;
  const total = 1 + Math.max(0, maxRetries);
  let attempts = 0;
  let last: NpmRunResult = { status: null };
  while (attempts < total) {
    attempts++;
    last = await runNpmUpdate(opts);
    if (last.status === 0) break;
    const lock = isLockError(last);
    if (!lock || attempts >= total) {
      const reason = last.error ?? last.stderrTail ?? `npm exited ${last.status}`;
      return { ok: false, attempts, status: last.status, error: last.error, stderrTail: last.stderrTail, guidance: updateGuidance(lock ? `post-retries: ${reason}` : reason) };
    }
    await sleep(opts.retryDelayMs ?? ATOMIC_RETRY_DELAY_MS);
  }
  const v = await verifyInstalledVersion(opts);
  if (!v.ok) {
    return { ok: false, attempts, status: last.status, error: last.error, stderrTail: last.stderrTail, guidance: updateGuidance(`post-verify: ${v.reason}`) };
  }
  if (opts.expectedVersion !== undefined && v.version !== opts.expectedVersion) {
    return {
      ok: false,
      attempts,
      status: last.status,
      installedVersion: v.version,
      guidance: updateGuidance(`post-verify: installed ${v.version} but expected ${opts.expectedVersion}`),
    };
  }
  return { ok: true, attempts, status: last.status, installedVersion: v.version, verified: true };
}

// —— WP-07（ADR-0044 决策 5）：uninstall 程序体卸载 runner（命令全硬编码零注入面 [自定]）——

export const NPM_UNINSTALL_ARGS = ["rm", "-g", NPM_PACKAGE_NAME] as const;

/** uninstall 默认步①：全局包移除。env 过 SEC-080 基线剥离（同 runNpmUpdate 面）。 */
export async function runNpmUninstall(
  opts: { runner?: NpmRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<NpmRunResult> {
  const runner = opts.runner ?? defaultNpmRunner;
  const source = opts.env ?? process.env;
  return runner(npmCliCommand(opts.platform), NPM_UNINSTALL_ARGS, stripEnvBaseline(source));
}
