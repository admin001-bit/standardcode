// F9（2026-09-29 真机实测）修复回归：`-sdb` 的 bin→main 路由。
// 背景：bin 原只放行 `--version` / `uninstall` / 无参；`-sdb` 落 else → 打印 usage 且 rc=1，
// 而 usage 字符串自身即宣称 `[-sdb]`，main() 的 sandboxCliFlag 分支在生产路径永不触达（死代码）。
// 桩法：复制真实 bin + 桩 dist bundle（记录 main 收到的 argv），不构建真产物。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
let pkgDir = "";

beforeAll(() => {
  pkgDir = mkdtempSync(join(tmpdir(), "sc-f9-"));
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  cpSync(join(CLI_DIR, "bin", "standardcode.js"), join(pkgDir, "bin", "standardcode.js"));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "f9-stub", version: "0.0.0", type: "module" }), "utf8");
  writeFileSync(
    join(pkgDir, "dist", "standardcode.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      "export async function main(argv = []) { writeFileSync(process.env.F9_MAIN_OUT, JSON.stringify(argv)); }",
      "export function finalizeExit(code) { process.exitCode = code; }",
      "export async function runUninstallCli() { return 0; }",
    ].join("\n"),
    "utf8",
  );
});
afterAll(() => {
  rmSync(pkgDir, { recursive: true, force: true });
});

function runBin(argv: string[]): { code: number; out: string; mainArgs: string[] | null } {
  const outFile = join(pkgDir, `main-args-${argv.join("_") || "none"}.json`);
  const r = spawnSync(process.execPath, [join(pkgDir, "bin", "standardcode.js"), ...argv], {
    encoding: "utf8",
    env: { ...process.env, F9_MAIN_OUT: outFile },
  });
  let mainArgs: string[] | null = null;
  try {
    mainArgs = JSON.parse(readFileSync(outFile, "utf8")) as string[];
  } catch {
    mainArgs = null;
  }
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, mainArgs };
}

describe("-sdb 路由（F9 修复）", () => {
  it("`-sdb` 转发到 main([\"-sdb\"])，不落 usage 分支", () => {
    const r = runBin(["-sdb"]);
    expect(r.mainArgs, `out=${r.out}`).toEqual(["-sdb"]); // 修复前：main 从未被调用（落 else usage rc=1）
    expect(r.out).not.toContain("usage: standardcode");
    expect(r.code).toBe(0);
  });

  it("无参仍进 main([])（旧形不回归）", () => {
    const r = runBin([]);
    expect(r.mainArgs).toEqual([]);
    expect(r.out).not.toContain("usage: standardcode");
  });

  it("未知旗标仍 fail-closed：usage + rc=1，且不进 main", () => {
    const r = runBin(["--bogus"]);
    expect(r.mainArgs).toBeNull();
    expect(r.out).toContain("usage: standardcode");
    expect(r.code).toBe(1);
  });

  it("`-sdb` 带多余参数：bin 放行、由 main 的参数守卫拒绝（main 收到原样 argv）", () => {
    const r = runBin(["-sdb", "extra"]);
    expect(r.mainArgs).toEqual(["-sdb", "extra"]);
  });
});
