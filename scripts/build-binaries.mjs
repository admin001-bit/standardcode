// WP-09（ADR-0047 决策 1–4）：**独立二进制构建**——Bun compile 单文件产物 + checksum。
// 步骤：①重建 esbuild bundle（`scripts/build-cli.mjs`，避免陈旧 dist 假证）②解析仓内 bun（devDependency
// 平台包直取，免 install script=ENG-071 禁豁免制）③逐目标 `bun build --compile`（`--define __SC_VERSION__`
// 烘焙版本；见 apps/cli/src/version.ts 头注）④复用 `scripts/checksum.mjs gen` 产 SHA256SUMS.txt。
// 用法：
//   node scripts/build-binaries.mjs                      # 三平台目标（交叉编译；首次需联网下载目标运行时）
//   node scripts/build-binaries.mjs --targets win-x64,linux-x64
//   node scripts/build-binaries.mjs --native             # 仅本机目标（CI 臂用，零交叉下载）
//   node scripts/build-binaries.mjs --native --verify    # 追加 version 门（仅本机产物可执行）
//   node scripts/build-binaries.mjs --print-native       # 只打印本机产物路径（CI 冷启动步取路径用）
// 产物：apps/cli/dist/bin/standardcode-<os>-<arch>[.exe] + SHA256SUMS.txt
// 边界（ADR-0047 决策 6）：Rust 沙箱臂（-sdb）不内嵌；**不外发**（发布动作逐项用户明示，BLK-02=①）；
// 不签名（Q-7）。DoD① 核销口径=决策 5（Win 本机 / Linux WSL2 实跑 / macOS 由 CI runner 实跑）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BIN = join(ROOT, "apps", "cli", "dist", "bin");
const ENTRY = join(ROOT, "apps", "cli", "bin", "standardcode.binary.mjs");

/** 三平台目标三元组（卡 DoD① 的"三平台"=win-x64 / linux-x64 / darwin-arm64）。 */
export const TARGETS = Object.freeze([
  { id: "win-x64", bunTarget: "bun-windows-x64", artifact: "standardcode-windows-x64.exe" },
  { id: "linux-x64", bunTarget: "bun-linux-x64", artifact: "standardcode-linux-x64" },
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", artifact: "standardcode-darwin-arm64" },
]);

/** 宿主平台→目标 id（CI 各 runner 只做本机臂；macOS=x64 runner 不在三目标内，故显式报错而非猜测）。 */
export function nativeTargetId(platform = process.platform) {
  return { win32: "win-x64", linux: "linux-x64", darwin: "darwin-arm64" }[platform];
}

export function findTarget(id) {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(`[build-binaries] 未知目标 "${id}"（可选：${TARGETS.map((x) => x.id).join(", ")}）`);
  return t;
}

export function artifactPath(target) {
  return join(DIST_BIN, target.artifact);
}

/** apps/cli/package.json 版本（=打包进产物的常量；ADR-0044 决策 3 发布版本同源）。 */
export function binaryVersion() {
  return JSON.parse(readFileSync(join(ROOT, "apps", "cli", "package.json"), "utf8")).version;
}

/**
 * 解析仓内 bun 可执行体：devDependency `bun` 的**平台包**（@oven/bun-<plat>-<arch>）内真实二进制。
 * 刻意不经 node_modules/.bin/bun（其 install script 被 pnpm 按 ENG-071 显式禁用=false，为 450B 报错桩）。
 */
export function resolveBunBinary(root = ROOT) {
  const pkgJson = join(root, "node_modules", "bun", "package.json");
  if (!existsSync(pkgJson)) {
    throw new Error("[build-binaries] 仓内 bun 缺位：请先 `pnpm install`（bun 为 devDependency，ADR-0047 决策 3）");
  }
  const bunDir = dirname(realpathSync.native(pkgJson));
  const plat = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "x64", arm64: "aarch64" }[process.arch];
  const pkg = `@oven/bun-${plat}-${arch}`;
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const req = createRequire(join(bunDir, "package.json"));
  try {
    return req.resolve(`${pkg}/bin/${exe}`);
  } catch {
    throw new Error(`[build-binaries] bun 平台包解析失败（${pkg}）——pnpm install 未含该平台包（optionalDependencies）`);
  }
}

/** 编译参数（纯函数，导出供测试判别——"版本烘焙"硬要求所在：无 --define 则二进制内 CLI_VERSION 走读盘必 ENOENT）。 */
export function compileArgs(target, version, entry = ENTRY, out = artifactPath(target)) {
  return [
    "build",
    "--compile",
    entry,
    `--target=${target.bunTarget}`,
    "--define",
    `__SC_VERSION__="${version}"`,
    "--outfile",
    out,
  ];
}

/** 单目标编译（导出供测试用；spawn 失败/产物缺位=抛错，不静默）。 */
export function compileTarget(target, { bun, version, quiet = false } = {}) {
  mkdirSync(DIST_BIN, { recursive: true });
  const out = artifactPath(target);
  const r = spawnSync(bun, compileArgs(target, version, ENTRY, out), { cwd: ROOT, stdio: quiet ? "pipe" : "inherit" });
  if (r.status !== 0) {
    throw new Error(`[build-binaries] 编译失败（${target.bunTarget}）exit=${r.status}`);
  }
  if (!existsSync(out)) throw new Error(`[build-binaries] 产物缺位：${out}`);
  return out;
}

/** version 门（只对可在本机执行的产物跑；其余=SKIP 并如实报出）。 */
export function verifyArtifact(target, version) {
  if (target.id !== nativeTargetId()) {
    return {
      status: "skip",
      reason: `非本机目标（本机=${nativeTargetId()}）不可直接执行——ADR-0047 决策 5 核销口径：Windows 本机 / Linux WSL2 实跑 / macOS 由 CI runner 实跑`,
    };
  }
  const r = spawnSync(artifactPath(target), ["--version"], { encoding: "utf8" });
  const expected = `standardcode ${version}`;
  const got = (r.stdout ?? "").trim();
  if (r.status !== 0 || got !== expected) {
    throw new Error(`[build-binaries] version 门未过（${target.id}）：exit=${r.status} stdout=${JSON.stringify(got)} 期望=${JSON.stringify(expected)}`);
  }
  return { status: "pass", output: got };
}

function usage(code = 1) {
  console.error("usage: build-binaries.mjs [--targets a,b,c] [--native] [--no-bundle] [--verify] [--print-native]");
  process.exitCode = code;
}

function main(argv) {
  const has = (f) => argv.includes(f);
  const valOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const native = has("--native");
  const listArg = valOf("--targets");
  if (native && listArg) {
    console.error("[build-binaries] --native 与 --targets 互斥");
    return usage();
  }
  const ids = native ? [nativeTargetId()] : listArg ? listArg.split(",").map((s) => s.trim()).filter(Boolean) : TARGETS.map((t) => t.id);
  if (ids.some((id) => !id)) return usage();
  const selected = ids.map(findTarget);

  if (has("--print-native")) {
    const id = nativeTargetId();
    if (!id) {
      console.error(`[build-binaries] 本机平台不在三目标内（platform=${process.platform}）——须显式 --targets`);
      process.exitCode = 1;
      return;
    }
    console.log(artifactPath(findTarget(id)));
    return;
  }

  const version = binaryVersion();
  const bun = resolveBunBinary();

  if (!has("--no-bundle")) {
    const b = spawnSync(process.execPath, [join(ROOT, "scripts", "build-cli.mjs")], { cwd: ROOT, stdio: "inherit" });
    if (b.status !== 0) {
      console.error("[build-binaries] build-cli 失败——拒绝以陈旧 bundle 出产物");
      process.exitCode = 1;
      return;
    }
  }

  const produced = [];
  for (const t of selected) {
    const out = compileTarget(t, { bun, version });
    const bytes = readFileSync(out).length;
    console.log(`[build-binaries] ${t.id} → ${out}（${(bytes / 1048576).toFixed(1)} MiB，版本 ${version}）`);
    produced.push(out);
  }

  // checksum（ADR-0044 决策 4 形状；同目录 SHA256SUMS.txt）
  const c = spawnSync(process.execPath, [join(ROOT, "scripts", "checksum.mjs"), "gen", ...produced], { cwd: ROOT, stdio: "inherit" });
  if (c.status !== 0) {
    console.error("[build-binaries] checksum gen 失败");
    process.exitCode = 1;
    return;
  }

  if (has("--verify")) {
    for (const t of selected) {
      const r = verifyArtifact(t, version);
      console.log(`[build-binaries] verify ${t.id}: ${r.status}${r.reason ? " — " + r.reason : " — " + r.output}`);
    }
  }
  console.log(`[build-binaries] done（${produced.length} 目标；产物目录 ${DIST_BIN}）`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
