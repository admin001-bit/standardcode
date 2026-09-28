// F20/F21（2026-09-29 真机实测）修复回归（本轮 sandbox 真臂深挖发现；原编号 F-B/F-C）：
//   F20 仓形制探针用 `new URL(import.meta.url).pathname`（percent-encoded）→ 非 ASCII 安装路径下探针恒空
//       （真机：中文路径探针位放好 exe 仍报"二进制未找到"；env BIN 形不受影响）。
//   F21 沙箱臂复用了直通臂的 cmd 引号包装（`"<命令>"`，直通臂靠 Node verbatim+/s 剥引号成立），
//       经 wire 交 Rust 侧再引号化 → cmd 报"不是内部或外部命令"，命令零落盘（danger 直通臂 A/B 铁证）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execBash, moduleDirFromUrl, resolveSandboxBinary, SandboxUnavailableError, type SandboxHandle, type SandboxRunResult } from "@standardcode/executor";

function fakeHandle(rec: Array<{ program: string; args: string[] }>): SandboxHandle {
  return {
    tier: "workspace-write",
    policy: () => ({ fs: { kind: "restricted", writable_roots: [], carveouts: [], metadata: { protected_names: [], read_only_subpaths: [] } }, net: "denied" }),
    run: async (e): Promise<SandboxRunResult> => {
      rec.push({ program: e.program, args: e.args });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    writeViaSandbox: async () => {},
    livePid: () => 1,
    root: () => process.cwd(),
    setRoot: () => {},
    shutdown: () => {},
    close: async () => {},
  };
}

describe("F20：探针路径的 URL 解码", () => {
  it("moduleDirFromUrl 还原 percent-encoded 非 ASCII（修复前 pathname 形恒为 %XX）", () => {
    // 中文安装路径真机形（%E8%AF%95%E9%AA%8C＝"试验"）
    const dir = moduleDirFromUrl("file:///D:/%E8%AF%95%E9%AA%8C/x/prefix/node_modules/p/dist/a.mjs");
    expect(dir).toContain("试验");
    expect(dir).not.toContain("%E8");
    expect(dir.endsWith(path.join("dist"))).toBe(true);
  });

  it("对照：ASCII 路径两形同值（解码不改变常规情形）", () => {
    // 平台无关断言（CI linux/macos gate 曾判红：fileURLToPath 在 POSIX 保前导 "/"，直接与
    // `path.join("D:/…")` 比较会平台分裂——此处只断"末尾段与无百分号"）。
    const dir = moduleDirFromUrl("file:///D:/plain/x/dist/a.mjs").replaceAll("\\", "/");
    expect(dir).toMatch(/\/?D:\/plain\/x\/dist$/);
    expect(dir).not.toContain("%");
  });

  it("显式路径缺位仍 fail-closed（不回退探针；B-12 语义不回归）", () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), "sc-f20-")), "nope.exe");
    try {
      expect(() => resolveSandboxBinary(missing)).toThrow(SandboxUnavailableError);
    } finally {
      rmSync(path.dirname(missing), { recursive: true, force: true });
    }
  });
});

describe("F21：沙箱臂命令入参为裸命令（不带 cmd 引号包装）", () => {
  it("execBash 经句柄：末位实参 === 原命令（win32 下修复前为 `\"<命令>\"`）", async () => {
    const rec: Array<{ program: string; args: string[] }> = [];
    const cmd = "echo AB-A> ab_a.txt";
    const out = await execBash({ command: cmd }, { cwd: process.cwd(), env: {}, sandbox: fakeHandle(rec) });
    expect(out.trim()).toBe("ok");
    const last = rec.at(-1)!;
    expect(last.args.at(-1)).toBe(cmd); // 修复前（win32）＝`"echo AB-A> ab_a.txt"`（预包引号 → Rust 侧再引号化）
    // 平台无关：只断 shell 前缀段（POSIX 臂为 ["-c", cmd] 两元素——CI linux/macos gate 曾判红：
    // 原 slice(0,3) 恒取满 3 段与 ["-c"] 比较而平台分裂）。
    const prefix = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
    expect(last.args.slice(0, prefix.length)).toEqual(prefix);
  });
});
