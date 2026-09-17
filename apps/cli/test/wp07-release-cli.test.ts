// WP-07（M5）CLI 侧测试：uninstall 子命令（ADR-0044 决策 5）+包形制审计（DoD⑤ postinstall 零提权）。
// 判据自足：板 WP-07 DoD④⑤；全离线（runner/confirm/fs 根注入；临时目录隔离）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPathRestorer, parseUninstallArgs, runUninstall, type InstallManifestPathEntry } from "../src/uninstall.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-wp07-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OK_RUNNER = () => Promise.resolve({ status: 0 });
const GONE = () => Promise.resolve({ gone: true, detail: "npm ls exited 1" });

function stubIo(over: Partial<Parameters<typeof runUninstall>[1]> = {}) {
  const out: string[] = [];
  const io = { write: (l: string) => void out.push(l), ...over } as Parameters<typeof runUninstall>[1];
  return { out, io };
}

describe("参数解析（fail-closed 最小面 [自定]）", () => {
  it("无参={purge:false}；--purge={purge:true}；未知旗标拒绝", () => {
    expect(parseUninstallArgs([])).toEqual({ purge: false });
    expect(parseUninstallArgs(["--purge"])).toEqual({ purge: true });
    expect(parseUninstallArgs(["--yes"])).toEqual({ error: "unknown argument: --yes" });
    expect(parseUninstallArgs(["--purge", "--yes"])).toEqual({ error: "unknown argument: --yes" });
  });
});

describe("DoD④ 默认卸载（程序体+PATH 清偿+残留断言）", () => {
  it("程序体移除成功+无 manifest→exit 0+残留断言通过行", async () => {
    const home = tmp();
    const { out, io } = stubIo({ homeDir: home, runner: OK_RUNNER, verifyGone: GONE });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("global package removed");
    expect(out.join("\n")).toContain("no PATH entries recorded");
    expect(out.join("\n")).toContain("residue check: package gone ✓");
  });
  it("程序体移除失败→exit 1+引导行+PATH/purge 均不执行（ADR-0045 决策 5 卸载原子性）", async () => {
    const home = tmp();
    const dataDir = join(home, ".standardcode");
    mkdirSync(dataDir, { recursive: true });
    let lsCalls = 0;
    const { out, io } = stubIo({
      homeDir: home,
      runner: () => Promise.resolve({ status: 1, stderrTail: "npm error EBUSY" }),
      verifyGone: () => {
        lsCalls++;
        return Promise.resolve({ gone: true, detail: "x" });
      },
    });
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("remove FAILED");
    expect(out.join("\n")).toContain("npm rm -g @standardcode/cli");
    expect(lsCalls).toBe(0); // 校验与 purge 均未达
    expect(existsSync(dataDir)).toBe(true); // purge 未执行（防半卸态）
  });
  it("PATH manifest 留痕还原（posix-rcfile 行删除）+坏行报告", async () => {
    const home = tmp();
    const dataDir = join(home, ".standardcode");
    mkdirSync(dataDir, { recursive: true });
    const rc = join(home, ".bashrc");
    writeFileSync(rc, "export PATH=\"/npm/global/bin:$PATH\"\necho keep\n");
    writeFileSync(join(dataDir, "install-manifest.json"), JSON.stringify({ pathEntries: [{ value: "/npm/global/bin", scope: "posix-rcfile", file: rc }] }));
    const entries: InstallManifestPathEntry[] = [];
    const { out, io } = stubIo({
      homeDir: home,
      runner: OK_RUNNER,
      verifyGone: GONE,
      pathRestorer: (es) => {
        entries.push(...es);
        return defaultPathRestorer(es);
      },
    });
    const code = await runUninstall([], io);
    expect(code).toBe(0);
    expect(entries).toHaveLength(1);
    expect(out.join("\n")).toContain("PATH entry removed: /npm/global/bin");
    expect(readFileSync(rc, "utf8")).toBe("echo keep\n"); // 精确行删除
  });
});

describe("DoD④ --purge（确认提示后；fail-closed）", () => {
  it("非 TTY（无 confirm 通道）→拒绝 exit 1+数据目录保留", async () => {
    const home = tmp();
    const dataDir = join(home, ".standardcode");
    mkdirSync(dataDir, { recursive: true });
    const { out, io } = stubIo({ homeDir: home, runner: OK_RUNNER, verifyGone: GONE });
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("fail-closed");
    expect(existsSync(dataDir)).toBe(true);
  });
  it("确认 yes→目录删除+残留断言；确认 no→aborted+目录保留", async () => {
    const home = tmp();
    const mk = () => {
      const dataDir = join(home, ".standardcode");
      mkdirSync(dataDir, { recursive: true });
      return dataDir;
    };
    const dataDir1 = mk();
    const { out, io } = stubIo({ homeDir: home, runner: OK_RUNNER, verifyGone: GONE, confirm: async () => true });
    const code = await runUninstall(["--purge"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`purged ${dataDir1} ✓`);
    expect(existsSync(dataDir1)).toBe(false);

    const dataDir2 = mk();
    const { out: out2, io: io2 } = stubIo({ homeDir: home, runner: OK_RUNNER, verifyGone: GONE, confirm: async () => false });
    const code2 = await runUninstall(["--purge"], io2);
    expect(code2).toBe(1);
    expect(out2.join("\n")).toContain("purge aborted by user");
    expect(existsSync(dataDir2)).toBe(true);
  });
});

describe("DoD⑤ 包形制审计（postinstall 零提权=附录 E 供应链约束）", () => {
  const repoRoot = join(import.meta.dirname ?? ".", "../../..");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")) as { scripts?: Record<string, string>; name: string; publishConfig?: { access?: string }; engines?: { node?: string } };
  it("apps/cli manifest 零生命周期脚本字段", () => {
    for (const k of ["preinstall", "install", "postinstall", "prepublish", "prepare", "prepublishOnly", "prepack", "postpack"]) {
      expect(pkg.scripts?.[k]).toBeUndefined();
    }
  });
  it("发布形制字段：name=附录 E 包名+public access+engines>=18+bin 在位", () => {
    expect(pkg.name).toBe("@standardcode/cli");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.engines?.node).toBe(">=18");
    expect(existsSync(join(repoRoot, "apps/cli/bin/standardcode.js"))).toBe(true);
  });
  it("仓内 root package.json 保持 private（防误发整仓）", () => {
    const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { private?: boolean };
    expect(root.private).toBe(true);
  });
  it("checksum 路真跑：gen→SHA256SUMS 落盘→verify 通过→篡改即 fail", () => {
    const dir = tmp();
    const f = join(dir, "artifact.bin");
    writeFileSync(f, "payload-0.1.0");
    execFileSync(process.execPath, [join(repoRoot, "scripts/checksum.mjs"), "gen", f], { stdio: "pipe" });
    expect(existsSync(join(dir, "SHA256SUMS.txt"))).toBe(true);
    execFileSync(process.execPath, [join(repoRoot, "scripts/checksum.mjs"), "verify", dir], { stdio: "pipe" });
    writeFileSync(f, "payload-tampered");
    let failed = false;
    try {
      execFileSync(process.execPath, [join(repoRoot, "scripts/checksum.mjs"), "verify", dir], { stdio: "pipe" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
