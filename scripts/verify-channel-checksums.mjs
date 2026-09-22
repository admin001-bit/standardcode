// WP-10（M7）DoD③ 自证：四通道清单/脚本中引用的 sha256 与 WP-09 产物 SHA256SUMS.txt **逐条相等**。
// 用法：node scripts/verify-channel-checksums.mjs
// 退出码：0=全等；1=任一不符/缺位（fail-closed，不静默）。
// 依据：M7-1-board §WP-10 DoD③「checksum 与 WP-09 产物一致」；附录 E 行 630。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUMS = join(ROOT, "apps", "cli", "dist", "bin", "SHA256SUMS.txt");
const EXPECTED_ARTIFACTS = ["standardcode-windows-x64.exe", "standardcode-linux-x64", "standardcode-darwin-arm64"];

// 四通道「引用点」表：文件 → 该文件内引用的产物 + 抽取该 sha 的正则（恰 1 捕获组）。
const REFS = [
  { ch: "winget", file: "packaging/winget/StandardCode.StandardCode.installer.yaml", artifact: "standardcode-windows-x64.exe", re: /InstallerSha256:\s*([0-9a-f]{64})/ },
  { ch: "homebrew", file: "packaging/homebrew/standardcode.rb", artifact: "standardcode-darwin-arm64", re: /sha256\s+"([0-9a-f]{64})"/ },
  { ch: "linux/direct", file: "packaging/linux/install.sh", artifact: "standardcode-linux-x64", re: /SHA256_LINUX_X64="([0-9a-f]{64})"/ },
  { ch: "linux/deb", file: "packaging/linux/build-deb.sh", artifact: "standardcode-linux-x64", re: /SHA256_LINUX_X64="([0-9a-f]{64})"/ },
  { ch: "linux/rpm", file: "packaging/linux/build-rpm.sh", artifact: "standardcode-linux-x64", re: /SHA256_LINUX_X64="([0-9a-f]{64})"/ },
  { ch: "direct-download", file: "packaging/direct-download/README.md", artifact: "standardcode-windows-x64.exe", re: /standardcode-windows-x64\.exe[^\n]*`([0-9a-f]{64})`/ },
  { ch: "direct-download", file: "packaging/direct-download/README.md", artifact: "standardcode-linux-x64", re: /standardcode-linux-x64`[^\n]*`([0-9a-f]{64})`/ },
  { ch: "direct-download", file: "packaging/direct-download/README.md", artifact: "standardcode-darwin-arm64", re: /standardcode-darwin-arm64`[^\n]*`([0-9a-f]{64})`/ },
];

let fail = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); fail++; };

if (!existsSync(SUMS)) {
  console.error(`[channels] SHA256SUMS.txt 缺位: ${SUMS}`);
  console.error("[channels] 先跑：node scripts/build-binaries.mjs（WP-09 产物）");
  process.exit(1);
}

// ① 解析 SUMS（真值源）
const sums = new Map();
for (const line of readFileSync(SUMS, "utf8").split("\n")) {
  const m = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1]);
}
console.log(`[channels] 真值源 ${SUMS}（${sums.size} 条）`);
for (const a of EXPECTED_ARTIFACTS) {
  if (!sums.has(a)) bad(`SHA256SUMS.txt 缺 ${a}`);
}

// ② 产物字节与 SUMS 一致（防 SUMS 陈旧）
for (const a of EXPECTED_ARTIFACTS) {
  const p = join(ROOT, "apps", "cli", "dist", "bin", a);
  if (!existsSync(p)) { bad(`产物缺位 ${a}`); continue; }
  const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
  if (actual === sums.get(a)) console.log(`  ✓ artifact ${a} 字节 == SUMS`);
  else bad(`artifact ${a} 字节 != SUMS（SUMS=${sums.get(a)} 实际=${actual}）`);
}

// ③ 通道引用点逐条相等
for (const r of REFS) {
  const p = join(ROOT, r.file);
  if (!existsSync(p)) { bad(`[${r.ch}] 文件缺位 ${r.file}`); continue; }
  const m = r.re.exec(readFileSync(p, "utf8"));
  if (!m) { bad(`[${r.ch}] ${r.file} 未匹配到 ${r.artifact} 的 sha256`); continue; }
  const want = sums.get(r.artifact);
  if (m[1] === want) console.log(`  ✓ [${r.ch}] ${r.file} → ${r.artifact} 相等`);
  else bad(`[${r.ch}] ${r.file} sha 不等（文件=${m[1]} SUMS=${want}）`);
}

// ④ 版本坐标一致（URL vX.Y.Z / PackageVersion / Version 三处同源）
const ver = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8")).version;
const verRefs = [
  { ch: "winget", file: "packaging/winget/StandardCode.StandardCode.yaml", re: /PackageVersion:\s*(\S+)/ },
  { ch: "winget", file: "packaging/winget/StandardCode.StandardCode.installer.yaml", re: /releases\/download\/v([0-9][^\s/]*)\// },
  { ch: "homebrew", file: "packaging/homebrew/standardcode.rb", re: /version\s+"([^"]+)"/ },
  { ch: "linux", file: "packaging/linux/install.sh", re: /DEFAULT_VERSION="([^"]+)"/ },
];
for (const r of verRefs) {
  const p = join(ROOT, r.file);
  if (!existsSync(p)) { bad(`[${r.ch}] 文件缺位 ${r.file}`); continue; }
  const m = r.re.exec(readFileSync(p, "utf8"));
  if (!m) { bad(`[${r.ch}] ${r.file} 未匹配到版本坐标`); continue; }
  if (m[1] === ver) console.log(`  ✓ [${r.ch}] ${r.file} 版本=${ver}`);
  else bad(`[${r.ch}] ${r.file} 版本不等（文件=${m[1]} package.json=${ver}）`);
}

if (fail > 0) { console.error(`[channels] FAILED（${fail} 项）`); process.exit(1); }
console.log("[channels] PASSED：四通道 sha256 与 WP-09 SHA256SUMS.txt 逐条相等，版本坐标同源");
