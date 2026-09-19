// WP-09（ADR-0047）独立二进制+checksum：构建面/入口面/校验面/随包面判别用例。
// 覆盖：①三平台目标三元组与产物命名 ②仓内 bun 解析与版本钉（devDependency 口径）③version 单源
// 双形（缺省读盘 + `--define __SC_VERSION__` 非缺省形）④二进制入口路由（node 直跑，三态）
// ⑤checksum 双向（真文件 PASS／篡改必红）⑥DoD③ bin 随包（tarball 内 bin 消费 dist bundle、零生命周期脚本）。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build as esbuild } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.ts";

/** 极简 tgz 解包（ustar；npm pack 产物形态）——不依赖外部 tar（本机 GNU tar 对 Windows 盘符路径不友好）。 */
function extractTgz(tgz: string, dest: string): string[] {
  const buf = gunzipSync(readFileSync(tgz));
  const names: string[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString("utf8").replace(/\0[\s\S]*$/, "");
    if (!name) break;
    const size = parseInt(buf.subarray(off + 124, off + 136).toString("utf8").replace(/\0[\s\S]*$/, "").trim() || "0", 8);
    const type = buf.subarray(off + 156, off + 157).toString("utf8");
    const target = join(dest, name);
    if (type === "5" || name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf.subarray(off + 512, off + 512 + size));
    }
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_PKG = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8")) as { version: string };
const ROOT_PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };

type BuildScript = {
  TARGETS: readonly { id: string; bunTarget: string; artifact: string }[];
  findTarget(id: string): { id: string; bunTarget: string; artifact: string };
  resolveBunBinary(root?: string): string;
  nativeTargetId(platform?: string): string | undefined;
  artifactPath(t: { artifact: string }): string;
  compileArgs(t: { bunTarget: string }, version: string, entry: string, out: string): string[];
  binaryVersion(): string;
};

let S: BuildScript;
const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "wp09-"));
  tmpDirs.push(d);
  return d;
};

beforeAll(async () => {
  // scripts/ 下 .mjs 不以 tsc 面暴露类型：经 URL 动态导入（vitest/Node 原生 ESM 解析）。
  S = (await import(/* @vite-ignore */ new URL("../../../scripts/build-binaries.mjs", import.meta.url).href)) as BuildScript;
}, 60_000);

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("WP-09 目标三元组与产物命名（DoD①）", () => {
  it("三平台目标恰为 win-x64/linux-x64/darwin-arm64（全集相等，非逐项）", () => {
    expect(S.TARGETS.map((t) => t.id)).toEqual(["win-x64", "linux-x64", "darwin-arm64"]);
    expect(S.TARGETS.map((t) => t.bunTarget).sort()).toEqual(["bun-darwin-arm64", "bun-linux-x64", "bun-windows-x64"]);
  });

  it("产物命名：windows=*.exe、linux/darwin=无扩展名", () => {
    const byId = Object.fromEntries(S.TARGETS.map((t) => [t.id, t.artifact]));
    expect(byId["win-x64"]).toBe("standardcode-windows-x64.exe");
    expect(byId["linux-x64"]).toBe("standardcode-linux-x64");
    expect(byId["darwin-arm64"]).toBe("standardcode-darwin-arm64");
    expect(S.artifactPath(S.findTarget("linux-x64")).endsWith(join("dist", "bin", "standardcode-linux-x64"))).toBe(true);
  });

  it("未知目标=抛错（fail-closed，不静默回落默认集）", () => {
    expect(() => S.findTarget("freebsd-x64")).toThrow(/未知目标/);
  });

  it("compileArgs 必含 --define __SC_VERSION__（版本烘焙是硬要求，非可选）", () => {
    const args = S.compileArgs(S.findTarget("linux-x64"), "1.2.3", join(ROOT, "e.mjs"), join(ROOT, "o"));
    expect(args).toContain("--compile");
    expect(args).toContain("--target=bun-linux-x64");
    expect(args).toContain("--define");
    expect(args).toContain('__SC_VERSION__="1.2.3"');
  });
});

describe("WP-09 仓内 bun 解析与版本钉（ADR-0047 决策 3）", () => {
  it("resolveBunBinary 指向真实可执行体且版本=devDependency 钉值", () => {
    const bin = S.resolveBunBinary(ROOT);
    expect(readdirSync(join(ROOT, "node_modules", "bun")).length).toBeGreaterThan(0);
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(ROOT_PKG.devDependencies["bun"]);
  });
});

describe("WP-09 version 单源双形（缺省读盘 + define 非缺省形）", () => {
  it("缺省形：CLI_VERSION = apps/cli/package.json 版本", () => {
    expect(CLI_VERSION).toBe(CLI_PKG.version);
  });

  it("非缺省形：注入 __SC_VERSION__ 时以注入值胜出（不走读盘）", async () => {
    const out = join(tmp(), "version-define.mjs");
    await esbuild({
      entryPoints: [join(ROOT, "apps/cli/src/version.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: out,
      define: { __SC_VERSION__: '"9.9.9-test"' },
      logLevel: "silent",
    });
    const mod = (await import(/* @vite-ignore */ out)) as { CLI_VERSION: string };
    expect(mod.CLI_VERSION).toBe("9.9.9-test");
  });
});

describe("WP-09 二进制入口路由（bin/standardcode.binary.mjs；node 直跑三态）", () => {
  const entry = () => join(ROOT, "apps", "cli", "bin", "standardcode.binary.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [entry(), ...args], { encoding: "utf8" });

  beforeAll(() => {
    // 入口静态 import dist bundle → 先按发布同款构建（避免陈旧 dist 假证）。
    const b = spawnSync(process.execPath, [join(ROOT, "scripts", "build-cli.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(b.status).toBe(0);
  }, 120_000);

  it("--version / -v：输出 `standardcode <版本>`，exit 0", () => {
    for (const flag of ["--version", "-v"]) {
      const r = run([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(`standardcode ${CLI_PKG.version}`);
    }
  });

  it("未知参数：usage 两行 + exit 1（与 npm 形制 shim 同形）", () => {
    const r = run(["--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`standardcode ${CLI_PKG.version}`);
    expect(r.stdout).toContain("usage: standardcode");
  });
});

describe("WP-09 checksum 双向（DoD②：逐平台可验证 + 篡改必红）", () => {
  const sums = () => join(ROOT, "scripts", "checksum.mjs");

  it("gen→verify 真文件 PASS；篡改一字节必 FAIL（exit 1）", () => {
    const dir = tmp();
    const a = join(dir, "standardcode-linux-x64");
    const b = join(dir, "standardcode-darwin-arm64");
    writeFileSync(a, "artifact-a-bytes");
    writeFileSync(b, "artifact-b-bytes");

    const gen = spawnSync(process.execPath, [sums(), "gen", a, b], { encoding: "utf8" });
    expect(gen.status).toBe(0);
    const sumsFile = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    expect(sumsFile.split("\n").filter((l) => l.trim()).length).toBe(2);
    expect(sumsFile).toMatch(/^[0-9a-f]{64} {2}standardcode-linux-x64$/m);

    const ok = spawnSync(process.execPath, [sums(), "verify", dir], { encoding: "utf8" });
    expect(ok.status).toBe(0);

    writeFileSync(a, "artifact-a-bytes!");
    const bad = spawnSync(process.execPath, [sums(), "verify", dir], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("MISMATCH");
  });
});

describe("WP-09 冷启动门 --bin 分支（ADR-0047 决策 5；单一阈值源）", () => {
  const cs = () => join(ROOT, "apps", "cli", "scripts", "cold-start.mjs");

  it("--bin 指向的产物被真正采用：输出不含 standardcode ⇒ 门红（判别分支非形制摆设）", () => {
    // 用 node 自身充当"二进制"：其 --version 输出 vX.Y.Z（不含 standardcode）——若实现忽略 --bin 回落 node shim，
    // 本用例会因 shim 正常输出而 PASS，故该断言对 --bin 分支具有判别力。
    const r = spawnSync(process.execPath, [cs(), "--bin", process.execPath], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未正常输出");
  });

  it("--bin 缺参数 ⇒ 用法错误 exit 1（不静默回落默认目标）", () => {
    const r = spawnSync(process.execPath, [cs(), "--bin"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage: cold-start.mjs");
  });
});

describe("WP-09 DoD③ bin 随包复核（tarball 内 bin 消费 dist bundle）", () => {
  it("pack → 解包 → 打包内 bin 可加载 dist bundle；staged manifest 零生命周期脚本", () => {
    const startMs = Date.now();
    const pack = spawnSync(process.execPath, [join(ROOT, "scripts", "pack-release.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(pack.status).toBe(0);

    // D-2 判别：打包产物名须与 SHA256SUMS 行同源、且为 scoped 名派生（旧名断言在干净树下必误报缺位）
    const dist = join(ROOT, "apps", "cli", "dist");
    const tarballName = `standardcode-oss-cli-${CLI_PKG.version}.tgz`;
    const sumsText = readFileSync(join(dist, "SHA256SUMS.txt"), "utf8");
    expect(sumsText).toMatch(new RegExp(`^[0-9a-f]{64} {2}${tarballName.replace(/\./g, "\\.")}$`, "m"));
    const tarball = join(dist, tarballName);
    expect(statSync(tarball).mtimeMs).toBeGreaterThanOrEqual(startMs - 1000); // 新鲜产出（防历史残件 masking）
    expect(spawnSync(process.execPath, [join(ROOT, "scripts", "checksum.mjs"), "verify", dist], { encoding: "utf8" }).status).toBe(0);
    const dir = tmp();
    const names = extractTgz(tarball, dir);
    expect(names.map((n) => n.replace(/^package\//, "")).sort()).toEqual(["bin/standardcode.js", "dist/standardcode.mjs", "package.json"]);

    const files = readdirSync(join(dir, "package")).sort();
    expect(files).toEqual(["bin", "dist", "package.json"]);

    const staged = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(staged.name).toBe("@standardcode-oss/cli");
    for (const k of ["preinstall", "install", "postinstall", "prepublish", "prepare", "prepack", "postpack", "prepublishOnly"]) {
      expect(k in staged).toBe(false);
    }
    expect(staged.dependencies ?? undefined).toBeUndefined();

    // bin 随包可运行：未知参数走 dist bundle 装载路（tarball 内无 src，dist 缺位即必失败）
    const r = spawnSync(process.execPath, [join(dir, "package", "bin", "standardcode.js"), "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("usage: standardcode");
  }, 180_000);
});
