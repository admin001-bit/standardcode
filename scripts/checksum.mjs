// WP-07（ADR-0044 决策 4；SEC-040 checksum 半——签名半按 Q-7 复审=首版不签）：SHA-256 生成/校验路。
// 用法：node scripts/checksum.mjs gen <file> [<file>…]   → 在首个文件同目录写/更新 SHA256SUMS.txt
//       node scripts/checksum.mjs verify <dir|SHA256SUMS.txt> → 逐行核验，全部匹配 exit 0，否则 exit 1
// 格式：`<hex>  <filename>`（SHA256SUMS 风格；shasum -a 256 -c / certutil -hashfile 两用核验语义）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const mode = process.argv[2];
const targets = process.argv.slice(3);

if (mode === "gen") {
  if (targets.length === 0) {
    console.error("usage: checksum.mjs gen <file> [<file>…]");
    process.exit(1);
  }
  const outDir = resolve(dirname0(targets[0]));
  const lines = targets.map((t) => `${sha256File(resolve(t))}  ${basename0(t)}`);
  const out = join(outDir, "SHA256SUMS.txt");
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`[checksum] written ${out}`);
  for (const l of lines) console.log(`[checksum] ${l}`);
  process.exit(0);
}

if (mode === "verify") {
  if (targets.length !== 1) {
    console.error("usage: checksum.mjs verify <dir|SHA256SUMS.txt>");
    process.exit(1);
  }
  const t = resolve(targets[0]);
  const sumFile = statSync(t).isDirectory() ? join(t, "SHA256SUMS.txt") : t;
  if (!existsSync(sumFile)) {
    console.error(`[checksum] SHA256SUMS not found: ${sumFile}`);
    process.exit(1);
  }
  const base = resolve(dirname0(sumFile));
  let fail = 0;
  for (const line of readFileSync(sumFile, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trim());
    if (!m) continue;
    const f = join(base, m[2]);
    if (!existsSync(f)) {
      console.error(`[checksum] MISSING ${m[2]}`);
      fail++;
      continue;
    }
    const actual = sha256File(f);
    if (actual === m[1]) console.log(`[checksum] OK  ${m[2]}`);
    else {
      console.error(`[checksum] MISMATCH ${m[2]} (expected ${m[1]}, got ${actual})`);
      fail++;
    }
  }
  if (fail > 0) {
    console.error(`[checksum] verify FAILED (${fail} item(s))`);
    process.exit(1);
  }
  console.log("[checksum] verify PASSED");
  process.exit(0);
}

console.error("usage: checksum.mjs gen <file>… | verify <dir|SHA256SUMS.txt>");
process.exit(1);

function dirname0(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}
function basename0(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
