// M8 后修复回归（2026-09-28，F2）：收尾退出 Windows 竞态。
// 现象（真 0.1.2 产物 × 真端点实测，3/3 复现）：坏 key + 非 TTY 管道 → 错误路径打印后**立即**
// process.exit，libuv 关闭在建句柄时触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// src\win\async.c:76`（rc=127）。修复＝bin 统一走 finalizeExit（设 exitCode + 释放 stdin + 自然排空；
// 2s unref 兜底）。触发条件实测（探测留档 .work/f2-exit-race.md）：**仅真远端 HTTPS**（真实 401 回全）
// 可复现；本地 HTTP/HTTPS 桩（keepalive／destroy／slow 各形）均不复现 ⇒ 端到端判别针不可离线化。
// 本文件三层：
//   ① 契约面（in-process，注入钩子）：finalizeExit = 设码 / 必 destroy stdin / 不同步 exit / 兜底 unref 可触发；
//   ② 路由面（真 bin + **桩 bundle**）：bin 必须经 finalizeExit 收尾、不得退回 process.exit——本层是判别针
//      （变异回 process.exit 必红）；
//   ③ 端到端冒烟（真 bin + 现构 bundle + 本地 401 桩）：守「干净退出 rc=0、无断言串」不变量
//      （含 bin 控制流穿透类回归——初版修复曾穿透到 usage+exit(1)，即被本层捕获）。
//   ④ opt-in 真端点实测（STANDARD_CODE_F2_LIVE=1）：对真 HTTPS 端点（坏 key→401）跑真复现路径。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeExit } from "../src/main.ts";

const CLI_DIR = resolve(fileURLToPath(new URL("..", import.meta.url))); // apps/cli
const MARKER = "SC_F2_MARKER";

/** 临时包布局：真 bin + package.json（+ 可选自定 dist）。零触仓内 dist。 */
function makePkg(stubBundle?: string): string {
  const pkgDir = mkdtempSync(join(tmpdir(), "sc-f2-pkg-"));
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  copyFileSync(join(CLI_DIR, "bin", "standardcode.js"), join(pkgDir, "bin", "standardcode.js"));
  copyFileSync(join(CLI_DIR, "package.json"), join(pkgDir, "package.json"));
  if (stubBundle !== undefined) writeFileSync(join(pkgDir, "dist", "standardcode.mjs"), stubBundle);
  return pkgDir;
}

function runBin(pkgDir: string, env: Record<string, string>, input = "你好\n") {
  return new Promise<{ code: number | null; out: string }>((r) => {
    const child = spawn(process.execPath, [join(pkgDir, "bin", "standardcode.js")], {
      cwd: pkgDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; });
    child.stderr.on("data", (d: string) => { out += d; });
    child.stdin.end(input);
    child.on("exit", (code) => r({ code, out }));
  });
}

/** 临时 home（settings 指向给定 baseUrl；坏 key 走 401 错误路径）。 */
function makeHome(baseUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), "sc-f2-home-"));
  mkdirSync(join(home, ".standardcode"), { recursive: true });
  writeFileSync(
    join(home, ".standardcode", "settings.json"),
    JSON.stringify({
      providers: { default: "openai", openai: { baseUrl, models: ["test-model"] } },
      model: { default: "test-model" },
    }),
  );
  return home;
}

describe("finalizeExit（F2 契约面）", () => {
  it("设码 + 销毁 stdin + 不同步 exit；2s 兜底已 unref 且触发时按码退出", () => {
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    let unrefed = false;
    finalizeExit(7, {
      stdin: { destroy: () => { calls.push("destroy"); } },
      setExitCode: (c) => { calls.push(`exitCode:${c}`); },
      schedule: (fn, ms) => { scheduled = fn; calls.push(`schedule:${ms}`); return { unref: () => { unrefed = true; } }; },
      exit: (c) => { calls.push(`exit:${c}`); },
    });
    expect(calls).toEqual(["exitCode:7", "destroy", "schedule:2000"]); // 顺序=先设码再释放，且**无**同步 exit
    expect(unrefed).toBe(true);
    scheduled?.();
    expect(calls).toContain("exit:7");
  });

  it("stdin.destroy 抛错不冒泡（自然排空路径仍成立）", () => {
    const calls: string[] = [];
    expect(() =>
      finalizeExit(1, {
        stdin: { destroy: () => { throw new Error("already closed"); } },
        setExitCode: (c) => { calls.push(`exitCode:${c}`); },
        schedule: () => ({ unref: () => {} }),
        exit: () => { calls.push("exit"); },
      }),
    ).not.toThrow();
    expect(calls).toEqual(["exitCode:1"]);
  });
});

describe("bin 收尾路由（F2 判别针：桩 bundle 记录收尾 API）", () => {
  const stub = [
    'import { writeFileSync } from "node:fs";',
    "const rec = (o) => writeFileSync(process.env." + MARKER + ", JSON.stringify(o));",
    "export async function main() { rec({ main: true }); }",
    "export function finalizeExit(code) { rec({ main: true, finalizeExit: code }); process.exitCode = code; }",
    "export async function runUninstallCli() { rec({ uninstall: true }); return 0; }",
    "",
  ].join("\n");

  it("正常 REPL 路径必须经 finalizeExit 收尾（退回 process.exit 本针必红）", async () => {
    const pkg = makePkg(stub);
    const markerFile = join(pkg, "marker.json");
    try {
      const r = await runBin(pkg, { [MARKER]: markerFile });
      expect(r.code).toBe(0);
      const rec = JSON.parse(readFileSync(markerFile, "utf8")) as { main?: boolean; finalizeExit?: number };
      expect(rec.main).toBe(true);
      expect(rec.finalizeExit).toBe(0); // 变异回 process.exit ⇒ 无此字段（红）
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }, 60_000);

  it("未知参数：usage + exit 1（else 分支不回穿 main 路径）", async () => {
    const pkg = makePkg(stub);
    const markerFile = join(pkg, "marker.json");
    try {
      const child = spawn(process.execPath, [join(pkg, "bin", "standardcode.js"), "--bogus"], {
        env: { ...process.env, [MARKER]: markerFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => { out += d; });
      const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
      expect(code).toBe(1);
      expect(out).toContain("usage: standardcode");
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("端到端冒烟（F2 不变量：真 bin + 现构 bundle + 本地 401 桩 → 干净退出）", () => {
  let pkgDir: string;
  beforeAll(async () => {
    pkgDir = makePkg();
    // 现场构建 bundle（发布同款 esbuild 参数；写 tmp 不碰仓内 dist，防并发写竞态）
    const { build } = await import("esbuild");
    await build({
      entryPoints: [join(CLI_DIR, "src", "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: join(pkgDir, "dist", "standardcode.mjs"),
      legalComments: "none",
      logLevel: "silent",
    });
  }, 120_000);

  afterAll(() => {
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("错误路径干净退出：rc=0、无 Assertion failed、不回穿 usage", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const home = makeHome(`http://127.0.0.1:${port}`);
    try {
      const r = await runBin(pkgDir, { OPENAI_API_KEY: "sk-invalid-test", HOME: home, USERPROFILE: home });
      expect(r.out).not.toContain("Assertion failed");
      expect(r.out).not.toContain("usage: standardcode"); // 控制流穿透回归（初版修复曾撞）
      expect(r.code, `child output:\n${r.out}`).toBe(0); // 修复前 Windows 实态＝rc=127（libuv 断言崩）
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

// ④ opt-in：真远端 HTTPS 才复现该竞态（见文件头）——本地/CI 缺省跳过，维护者手动跑：
//   STANDARD_CODE_F2_LIVE=1 node node_modules/vitest/vitest.mjs run apps/cli/test/bin-exit-f2.test.ts
describe.skipIf(!process.env.STANDARD_CODE_F2_LIVE)("F2 真端点复现（opt-in）", () => {
  it("坏 key × 真 HTTPS 端点：不得出现 libuv 断言（rc≠127）", async () => {
    const pkgDir = makePkg();
    try {
      const { build } = await import("esbuild");
      await build({
        entryPoints: [join(CLI_DIR, "src", "main.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node18",
        outfile: join(pkgDir, "dist", "standardcode.mjs"),
        legalComments: "none",
        logLevel: "silent",
      });
      const home = makeHome("https://api.deepseek.com");
      try {
        const r = await runBin(pkgDir, { OPENAI_API_KEY: "sk-invalid-test", HOME: home, USERPROFILE: home });
        expect(r.out).not.toContain("Assertion failed");
        expect(r.code).not.toBe(127);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
    }
  }, 120_000);
});
