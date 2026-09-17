// WP-07（ADR-0044 决策 3/4 + SEC-040 checksum 半）：发布打包——staged manifest + npm pack + SHA-256 checksums。
// 仓内 apps/cli/package.json 保持开发形制（workspace deps 供 typecheck/测试）；发布 manifest 于 staging 目录
// 生成：无 dependencies、无任何生命周期脚本（postinstall 零提权=附录 E 供应链约束，审计断言见测试）。
// 用法：node scripts/pack-release.mjs [--version x.y.z]（缺省=apps/cli 现版本）
// 产物：apps/cli/dist/standardcode-cli-<ver>.tgz + apps/cli/dist/SHA256SUMS.txt
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(ROOT, "apps", "cli");
const DIST = join(CLI_DIR, "dist");
const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall", "prepublish", "prepare", "prepublishOnly", "prepack", "postpack"];

const argVersionIdx = process.argv.indexOf("--version");
const version = argVersionIdx >= 0 ? process.argv[argVersionIdx + 1] : undefined;
if (argVersionIdx >= 0 && (!version || !/^\d+\.\d+\.\d+/.test(version))) {
  console.error("[pack-release] --version 需为 x.y.z 形");
  process.exit(1);
}

// ① bundle（确保 dist 产物为当前源码）
const build = spawnSync(process.execPath, ["scripts/build-cli.mjs"], { stdio: "inherit", cwd: ROOT });
if (build.status !== 0) {
  console.error("[pack-release] build-cli failed");
  process.exit(1);
}

// ② staged manifest（仓内 manifest 不为发布改写；dependencies 移除=bundle 自足）
const srcPkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
const outVersion = version ?? srcPkg.version;
const staged = {
  name: srcPkg.name,
  version: outVersion,
  description: "StandardCode — open-source CLI coding agent (generic multi-protocol).",
  license: "Apache-2.0",
  type: "module",
  bin: { standardcode: "bin/standardcode.js" },
  engines: { node: ">=18" },
  repository: { type: "git", url: "git+https://github.com/admin001-bit/standardcode.git" },
  publishConfig: { access: "public" },
  files: ["bin/", "dist/"],
};
// DoD⑤ 审计（构建期硬断言）：发布 manifest 零生命周期脚本（postinstall 零提权供应链约束）
for (const k of LIFECYCLE_SCRIPT_KEYS) {
  if (k in staged) {
    console.error(`[pack-release] audit FAILED: staged manifest has lifecycle script key "${k}"`);
    process.exit(1);
  }
}
if (staged.name !== "@standardcode/cli") {
  console.error("[pack-release] audit FAILED: package name mismatch (附录 E 行 630)");
  process.exit(1);
}

// ③ staging 布局：package.json + bin/ + dist/
const stage = join(DIST, "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "dist"), { recursive: true });
writeFileSync(join(stage, "package.json"), JSON.stringify(staged, null, 2) + "\n");
cpSync(join(CLI_DIR, "bin", "standardcode.js"), join(stage, "bin", "standardcode.js"));
cpSync(join(CLI_DIR, "dist", "standardcode.mjs"), join(stage, "dist", "standardcode.mjs"));

// ④ npm pack（staging 内；tarball 落 dist/）
const pack = spawnSync("npm", ["pack", "--pack-destination", DIST], { stdio: "inherit", cwd: stage, shell: process.platform === "win32" });
if (pack.status !== 0) {
  console.error("[pack-release] npm pack failed");
  process.exit(1);
}
const tarball = join(DIST, `standardcode-cli-${outVersion}.tgz`);
if (!existsSync(tarball)) {
  console.error(`[pack-release] expected tarball missing: ${tarball}`);
  process.exit(1);
}

// ⑤ SHA-256 checksums（SEC-040 checksum 半；SHA256SUMS 风格）
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const bundleSum = sha256(join(stage, "dist", "standardcode.mjs"));
const tarballSum = sha256(tarball);
writeFileSync(
  join(DIST, "SHA256SUMS.txt"),
  `${bundleSum}  standardcode.mjs\n${tarballSum}  standardcode-cli-${outVersion}.tgz\n`,
);

// ⑥ 收尾：staging 目录清删（tarball 与 SHA256SUMS 留 dist/）
rmSync(stage, { recursive: true, force: true });
console.log(`[pack-release] tarball: ${tarball}`);
console.log(`[pack-release] checksums: ${join(DIST, "SHA256SUMS.txt")}`);
console.log("[pack-release] NOTE: npm publish = 外发动作（BLK-02 口径）——须用户逐项明示授权后方可执行");
