// WP-11（M7）：卸载全通道注入面验证——`standardcode uninstall --purge` 五步全链（①程序体②PATH 还原
// ③残留校验④purge 确认⑤用户数据删除）×三平台差异点。判据自足：ADR-0044 决策 5/6＋附录 E 行 630
// （"卸载 standardcode uninstall --purge + 手动清理脚本"）。全离线注入（runner/pathRestorer/verifyGone/confirm/homeDir）。
// 覆盖面=既有 apps/cli/test/wp07-release-cli.test.ts **未覆盖**的分支：全链顺序、残留失败防半卸、PATH failed/skipped/坏 manifest、
// 三平台（程序体命令、PATH 项 scope、数据目录、清理脚本名）、purge 幂等。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NPM_PACKAGE_NAME } from "@standardcode/platform";
import {
  INSTALL_MANIFEST_FILE,
  runUninstall,
  type InstallManifestPathEntry,
  type PathRestoreResult,
  type UninstallIo,
} from "../src/uninstall.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-wp11-"));
  dirs.push(d);
  return d;
}
// 清理钩子显式放宽超时：全量并发跑时 rmSync（递归删临时目录）在负载下可超默认 10s（本机 spawnSync/IO 慢），
// 属环境时序面，与被测语义无关；单文件跑 ~10s 内完成。
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 60_000);

const repoRoot = join(import.meta.dirname ?? ".", "../../..");

/** 三平台形态表（程序体命令／PATH 项 scope／rc 文件名／清理脚本名+旗标）。 */
const PLATFORMS = [
  { platform: "win32" as const, npmCmd: "npm.cmd", scope: "win-user-registry" as const, rc: undefined, script: "scripts/cleanup.ps1", flag: "-PurgeHome" },
  { platform: "linux" as const, npmCmd: "npm", scope: "posix-rcfile" as const, rc: "/home/tester/.bashrc", script: "scripts/cleanup.sh", flag: "--purge-home" },
  { platform: "darwin" as const, npmCmd: "npm", scope: "posix-rcfile" as const, rc: "/Users/tester/.zshrc", script: "scripts/cleanup.sh", flag: "--purge-home" },
] as const;

/** 平台 rc 落点（还原器为注入桩，不落盘，故取形态常量即可）。 */
function rcOf(p: (typeof PLATFORMS)[number]): string {
  return p.rc ?? "";
}

function pathEntry(p: (typeof PLATFORMS)[number]): InstallManifestPathEntry {
  return p.scope === "win-user-registry"
    ? { value: "GLOBAL_NPM_BIN", scope: "win-user-registry" }
    : { value: "/npm-global/bin", scope: "posix-rcfile", file: rcOf(p) };
}

interface ChainOpts {
  platform: NodeJS.Platform;
  entries?: InstallManifestPathEntry[];
  /** manifest 原始文本；缺省=由 entries 序列化；null=不写 manifest 文件。 */
  manifest?: string | null;
  restorerResult?: PathRestoreResult;
  gone?: boolean;
  confirm?: boolean;
}

/** 全链注入装配：out=输出行、order=调用序、seen=各步捕获。 */
function chainIo(o: ChainOpts) {
  const out: string[] = [];
  const order: string[] = [];
  const seen: { cmd?: string; args?: readonly string[]; entries?: InstallManifestPathEntry[]; confirmQ?: string } = {};
  const homeDir = tmp();
  const dataDir = join(homeDir, ".standardcode");
  mkdirSync(dataDir, { recursive: true });
  if (o.manifest === null) void 0;
  else writeFileSync(join(dataDir, INSTALL_MANIFEST_FILE), o.manifest ?? JSON.stringify({ pathEntries: o.entries ?? [] }));
  const io: UninstallIo = {
    write: (l: string) => void out.push(l),
    homeDir,
    platform: o.platform,
    runner: (cmd, args) => {
      order.push("runner");
      seen.cmd = cmd;
      seen.args = args;
      return Promise.resolve({ status: 0 });
    },
    pathRestorer: (entries) => {
      order.push("restorer");
      seen.entries = [...entries];
      return Promise.resolve(o.restorerResult ?? { removed: entries.map((e) => e.value), failed: [], skipped: [] });
    },
    verifyGone: () => {
      order.push("verifyGone");
      return Promise.resolve({ gone: o.gone ?? true, detail: o.gone === false ? "still installed at 0.1.0" : "npm ls exited 1" });
    },
    confirm: (q: string) => {
      order.push("confirm");
      seen.confirmQ = q;
      return Promise.resolve(o.confirm ?? true);
    },
  };
  return { out, io, order, seen, dataDir, homeDir };
}

describe("DoD② 卸载 --purge 全链（五步顺序；注入面）", () => {
  it("全链贯通：runner→restorer→verifyGone→confirm→删除，exit 0+关键输出行+数据目录消失", async () => {
    const p = PLATFORMS[1]!; // linux
    const { out, io, order, seen, dataDir } = chainIo({ platform: p.platform, entries: [pathEntry(p)] });
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(0);
    expect(order).toEqual(["runner", "restorer", "verifyGone", "confirm"]);
    const text = out.join("\n");
    expect(text).toContain("global package removed"); // ①
    expect(text).toContain("PATH entry removed: /npm-global/bin"); // ②
    expect(text).toContain("residue check: package gone ✓"); // ③
    expect(seen.confirmQ).toContain(dataDir); // ④ 确认文案点名数据目录
    expect(text).toContain(`purged ${dataDir} ✓`); // ⑤
    expect(existsSync(dataDir)).toBe(false);
    expect(text).toContain("[uninstall] done");
  });
  it("残留校验失败（程序体仍在）→exit 1+purge 不执行（confirm 零调用、数据目录保留）——防半卸态", async () => {
    const p = PLATFORMS[0]!; // win32
    const { out, io, order, dataDir } = chainIo({ platform: p.platform, entries: [pathEntry(p)], gone: false });
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(1);
    expect(order).toEqual(["runner", "restorer", "verifyGone"]); // confirm 未达
    expect(out.join("\n")).toContain("residue check FAILED");
    expect(out.join("\n")).toContain(`npm rm -g ${NPM_PACKAGE_NAME}`);
    expect(existsSync(dataDir)).toBe(true);
  });
  it("--purge 幂等：数据目录已缺席→rmSync(force) 不抛，exit 0", async () => {
    const home = tmp(); // 不建 .standardcode
    const out: string[] = [];
    const io: UninstallIo = {
      write: (l) => void out.push(l),
      homeDir: home,
      platform: "linux",
      runner: () => Promise.resolve({ status: 0 }),
      verifyGone: () => Promise.resolve({ gone: true, detail: "x" }),
      confirm: () => Promise.resolve(true),
    };
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("purged");
    expect(out.join("\n")).toContain("done");
  });
});

describe("DoD② PATH 清偿分支（既有未覆盖三态）", () => {
  it("还原失败项→报告 FAILED 行但 exit 仍 0（还原失败不阻断卸载，仅报告+指向清理脚本）", async () => {
    const p = PLATFORMS[0]!;
    const { out, io } = chainIo({
      platform: p.platform,
      entries: [pathEntry(p)],
      restorerResult: { removed: [], failed: [{ value: "GLOBAL_NPM_BIN", reason: "HKCU Path not readable" }], skipped: [] },
    });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("PATH entry restore FAILED: GLOBAL_NPM_BIN");
    expect(text).toContain("cleanup script");
    expect(text).toContain("done");
  });
  it("条目已不在 PATH（幂等）→报告 skip 行+exit 0", async () => {
    const p = PLATFORMS[1]!;
    const { out, io } = chainIo({
      platform: p.platform,
      entries: [pathEntry(p)],
      restorerResult: { removed: [], failed: [], skipped: ["/npm-global/bin"] },
    });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("PATH entry not present (skip): /npm-global/bin");
  });
  it("坏 manifest（非法 JSON）→视为无 PATH 项，不抛+exit 0（还原器零调用）", async () => {
    const { out, io, order } = chainIo({ platform: "linux", manifest: "{ not json" });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("no PATH entries recorded");
    expect(order).toEqual(["runner", "verifyGone"]); // 空条目=不调还原器
  });
});

describe("DoD② 三平台差异点（程序体命令／PATH 项 scope／数据目录／清理脚本名）", () => {
  for (const p of PLATFORMS) {
    it(`${p.platform}：程序体命令=${p.npmCmd}、args 恒 rm -g ${NPM_PACKAGE_NAME}、数据目录=<home>/.standardcode`, async () => {
      const { io, seen, dataDir, homeDir } = chainIo({ platform: p.platform, entries: [pathEntry(p)] });
      const code = await runUninstall(["--purge"], io);
      expect(code).toBe(0);
      expect(seen.cmd).toBe(p.npmCmd);
      expect(seen.args).toEqual(["rm", "-g", NPM_PACKAGE_NAME]);
      expect(basename(dataDir)).toBe(".standardcode");
      expect(dataDir.startsWith(homeDir)).toBe(true);
    });
    it(`${p.platform}：manifest PATH 项 scope=${p.scope}（${p.scope === "posix-rcfile" ? `带 rc 落点 file=${p.rc}` : "无 file（注册表路）"}）逐项传入还原器`, async () => {
      const { io, seen } = chainIo({ platform: p.platform, entries: [pathEntry(p)] });
      const code = await runUninstall([], io);
      expect(code).toBe(0);
      expect(seen.entries).toEqual([pathEntry(p)]);
      expect(seen.entries![0]!.scope).toBe(p.scope);
      if (p.scope === "posix-rcfile") expect(seen.entries![0]!.file).toBe(p.rc);
      else expect(seen.entries![0]!.file).toBeUndefined();
    });
    it(`${p.platform}：手动清理脚本=${p.script}，旗标=${p.flag} 在位且包名与 NPM_PACKAGE_NAME 同字（防漂移）`, () => {
      const src = readFileSync(join(repoRoot, p.script), "utf8");
      expect(src).toContain(p.flag);
      expect(src).toContain(NPM_PACKAGE_NAME);
      expect(src).not.toContain("@standardcode/cli"); // ADR-0044 决策 10 改判前旧名
    });
  }
  it("默认（不带 --purge）三平台均不触 confirm、数据目录保留", async () => {
    for (const p of PLATFORMS) {
      const { io, order, dataDir } = chainIo({ platform: p.platform, entries: [pathEntry(p)] });
      const code = await runUninstall([], io);
      expect(code).toBe(0);
      expect(order).not.toContain("confirm");
      expect(existsSync(dataDir)).toBe(true);
    }
  });
});

