// WP-07（ADR-0044 决策 5）：`standardcode uninstall [--purge]`——CLI 子命令（非斜杠，命令全集 30 断言不触）。
// 默认=程序体（npm rm -g，ADR-0045 决策 5 卸载原子性同面：失败即中止后续步）+PATH 项清偿（安装脚本
// 写 PATH 前确认并留痕 install-manifest，本处逐项还原）；--purge=连 ~/.standardcode 用户数据——确认提示后
// 执行、非 TTY 无确认通道=拒绝（fail-closed）、程序体卸载失败=purge 不执行（防半卸态）。残留断言逐步输出。
// 全形状 [自定]（ADR-0044；[CC]/Codex 安装器锚零）。注入面（runner/confirm/manifest/restorer/fs 根）=全离线可测。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NPM_PACKAGE_NAME, runNpmUninstall, verifyInstalledVersion, type NpmRunner } from "@standardcode/platform";

/** 安装脚本 PATH 留痕文件（ADR-0044 决策 5；位于 ~/.standardcode/ 内——purge 随目录同删）。 */
export const INSTALL_MANIFEST_FILE = "install-manifest.json";

export type PathEntryScope = "win-user-registry" | "posix-rcfile";

export interface InstallManifestPathEntry {
  /** 写入 PATH 的确切条目值（如 npm 全局 bin 目录）。 */
  value: string;
  scope: PathEntryScope;
  /** posix-rcfile 落点文件绝对路径（win-user-registry 无需）。 */
  file?: string;
}

export interface InstallManifest {
  pathEntries?: InstallManifestPathEntry[];
}

/** 参数解析（未知旗标拒绝 fail-closed；[自定] 最小面）。 */
export function parseUninstallArgs(argv: readonly string[]): { purge: boolean } | { error: string } {
  let purge = false;
  for (const a of argv) {
    if (a === "--purge") purge = true;
    else return { error: `unknown argument: ${a}` };
  }
  return { purge };
}

function readManifest(manifestPath: string): InstallManifest {
  try {
    if (!existsSync(manifestPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed !== null && typeof parsed === "object") return parsed as InstallManifest;
    return {};
  } catch {
    return {}; // 坏 manifest=视为无 PATH 项（不阻断卸载主流程；告警由调用方输出）
  }
}

/** PATH 还原结果（逐项成败，永不抛——还原失败不回滚程序体卸载，仅报告）。 */
export interface PathRestoreResult {
  removed: string[];
  failed: { value: string; reason: string }[];
  skipped: string[]; // 条目已不在 PATH（幂等）
}

/** 缺省还原器：win=HKCU\Environment Path reg 读写；posix=rc 文件行删除。测试经 io.pathRestorer 注入桩。 */
export function defaultPathRestorer(entries: readonly InstallManifestPathEntry[]): Promise<PathRestoreResult> {
  const result: PathRestoreResult = { removed: [], failed: [], skipped: [] };
  const tasks = entries.map(async (e) => {
    try {
      if (e.scope === "win-user-registry") {
        const { spawnSync } = await import("node:child_process");
        const q = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true });
        const out = `${q.stdout ?? ""}`;
        const m = /Path\s+REG(?:_EXPAND_)?SZ\s+(.*)/i.exec(out);
        if (!m) {
          result.failed.push({ value: e.value, reason: "HKCU Path not readable" });
          return;
        }
        const parts = m[1]!.split(";");
        const keep = parts.filter((p) => p.trim() !== "" && p.trim().toLowerCase() !== e.value.trim().toLowerCase());
        if (keep.length === parts.filter((p) => p.trim() !== "").length) {
          result.skipped.push(e.value);
          return;
        }
        const w = spawnSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", keep.join(";"), "/f"], { encoding: "utf8", windowsHide: true });
        if (w.status === 0) result.removed.push(e.value);
        else result.failed.push({ value: e.value, reason: `reg add exited ${w.status}` });
        return;
      }
      // posix-rcfile：精确行删除（写条目时为整行 export；此处按行包含 value 匹配）
      if (e.file === undefined || !existsSync(e.file)) {
        result.skipped.push(e.value);
        return;
      }
      const lines = readFileSync(e.file, "utf8").split("\n");
      const kept = lines.filter((l) => !l.includes(e.value));
      if (kept.length === lines.length) {
        result.skipped.push(e.value);
        return;
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(e.file, kept.join("\n"), "utf8");
      result.removed.push(e.value);
    } catch (err) {
      result.failed.push({ value: e.value, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return Promise.all(tasks).then(() => result);
}

export interface UninstallIo {
  isTTY?: boolean;
  /** --purge 确认通道（TTY 装配；缺席=非交互，purge 拒绝 fail-closed）。 */
  confirm?(question: string): Promise<boolean>;
  write?(line: string): void;
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runner?: NpmRunner;
  /** PATH 还原注入（测试桩；缺省=defaultPathRestorer）。 */
  pathRestorer?(entries: readonly InstallManifestPathEntry[]): Promise<PathRestoreResult>;
  /** 用户数据目录覆写（测试隔离；缺省 ~/.standardcode）。 */
  dataDir?: string;
  /** 程序体残留断言注入（缺省=verifyInstalledVersion 期望失败）。 */
  verifyGone?: () => Promise<{ gone: boolean; detail: string }>;
  /** M8-WP-11：目录删除注入面（缺省=fs.rmSync recursive/force；测试夹具注入抛错者以判 D-1 错误路径）。 */
  removeDir?(dir: string): void;
}

function reportRestore(r: PathRestoreResult, write: (l: string) => void): void {
  for (const v of r.removed) write(`[uninstall] PATH entry removed: ${v}`);
  for (const v of r.skipped) write(`[uninstall] PATH entry not present (skip): ${v}`);
  for (const f of r.failed) write(`[uninstall] PATH entry restore FAILED: ${f.value} (${f.reason}) — see cleanup script`);
}

/** 卸载主流程。返回进程退出码（0=成功；1=失败，终态均带明确引导）。 */
export async function runUninstall(argv: readonly string[], io: UninstallIo = {}): Promise<number> {
  const write = io.write ?? ((l: string) => process.stdout.write(`${l}\n`));
  const parsed = parseUninstallArgs(argv);
  if ("error" in parsed) {
    write(`[uninstall] ${parsed.error}`);
    write("usage: standardcode uninstall [--purge]");
    return 1;
  }

  // ① 程序体（npm rm -g；失败即中止——ADR-0045 决策 5 卸载原子性）
  write(`[uninstall] removing global package (${NPM_PACKAGE_NAME}) …`);
  const rm = await runNpmUninstall({ runner: io.runner, env: io.env, platform: io.platform });
  if (rm.status !== 0) {
    write(`[uninstall] remove FAILED: ${rm.error ?? rm.stderrTail ?? `npm exited ${rm.status}`}`);
    write(`[uninstall] action: 关闭正在运行的 standardcode 实例后重试，或手动执行 npm rm -g ${NPM_PACKAGE_NAME}`);
    return 1;
  }
  write("[uninstall] global package removed");

  // ② PATH 项清偿（安装留痕 manifest；无/坏=提示跳过）
  const home = io.homeDir ?? homedir();
  const dataDir = io.dataDir ?? join(home, ".standardcode");
  const manifestPath = join(dataDir, INSTALL_MANIFEST_FILE);
  const manifest = readManifest(manifestPath);
  const entries = manifest.pathEntries ?? [];
  if (entries.length === 0) {
    write("[uninstall] no PATH entries recorded in install manifest (skip)");
  } else {
    const restore = io.pathRestorer ?? defaultPathRestorer;
    reportRestore(await restore(entries), write);
  }

  // ③ 残留断言（程序体离场；npm ls 对缺席包 exit≠0）
  const gone = io.verifyGone
    ? await io.verifyGone()
    : await (async () => {
        const v = await verifyInstalledVersion({ runner: io.runner, env: io.env, platform: io.platform });
        return v.ok ? { gone: false, detail: `still installed at ${v.version}` } : { gone: true, detail: v.reason };
      })();
  write(gone.gone ? "[uninstall] residue check: package gone ✓" : `[uninstall] residue check FAILED: ${gone.detail}`);
  if (!gone.gone) {
    write(`[uninstall] action: 手动执行 npm rm -g ${NPM_PACKAGE_NAME} 后重试`);
    return 1;
  }

  // ④ --purge（确认提示后；fail-closed：非交互拒绝/用户拒绝中止/程序体失败不达此路）
  if (parsed.purge) {
    if (io.confirm === undefined) {
      write("[uninstall] --purge requires interactive confirmation (non-TTY = refused, fail-closed)");
      write("[uninstall] action: 在终端交互运行 standardcode uninstall --purge，或使用 scripts/cleanup.* 手动清理");
      return 1;
    }
    const ok = await io.confirm(`--purge 将删除用户数据目录 ${dataDir}（会话/凭据/信任留痕），不可恢复。继续?`);
    if (!ok) {
      write("[uninstall] purge aborted by user");
      return 1;
    }
    const remove = io.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
    try {
      remove(dataDir);
    } catch (err) {
      // M8-WP-11（D-1）：删除抛错（如 Windows 目录被占 → EPERM）须走同一 FAILED 文案＋rc=1，
      // 不裸抛（原实现只覆盖"rmSync 不抛但目录仍在"的窄形，抛出路径会绕过文案）。
      const reason = err instanceof Error ? err.message : String(err);
      write(`[uninstall] purge FAILED: ${dataDir} — ${reason}；手动删除或使用 scripts/cleanup.*`);
      return 1;
    }
    if (existsSync(dataDir)) {
      write(`[uninstall] purge FAILED: ${dataDir} still present — 手动删除或使用 scripts/cleanup.*`);
      return 1;
    }
    write(`[uninstall] purged ${dataDir} ✓`);
  }

  write("[uninstall] done");
  return 0;
}

/**
 * 默认 TTY 确认工厂（M8-WP-11；抽为可注入名以便判据直测——消除"扫描型断言"的判别力边界）。
 * y/N 语义：`^y(es)?$`（大小写不敏感、trim）＝是；其余（含空行）＝否；
 * **D-V1′**：`close`（stdin 纯 EOF／终端关闭）与 `question` 竞速 resolve("")＝否（不悬挂 → 走 aborted＋rc=1）。
 */
export function createTtyConfirm(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): (question: string) => Promise<boolean> {
  return async (question) => {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input, output });
    try {
      const raw = await new Promise<string>((resolve) => {
        let settled = false;
        const done = (value: string): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        rl.question(`${question} [y/N] `, done);
        rl.once("close", () => done("")); // EOF／流关闭＝未确认（fail-closed 方向）
      });
      return /^y(es)?$/i.test(raw.trim());
    } finally {
      rl.close();
    }
  };
}

/**
 * M8-WP-11（D-V1）：**CLI 入口**（bin 消费）——TTY 下装配交互确认通道（readline y/N），
 * 非 TTY 不装配（沿用 purge 段 fail-closed 拒绝，语义零改）。`runUninstall` 本体保持纯注入面。
 */
export async function runUninstallCli(argv: readonly string[], overrides: Partial<UninstallIo> = {}): Promise<number> {
  const isTTY = overrides.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const io: UninstallIo = { ...overrides, isTTY };
  if (isTTY && io.confirm === undefined) {
    io.confirm = createTtyConfirm(process.stdin, process.stdout);
  }
  return runUninstall(argv, io);
}
