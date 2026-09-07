// WP-10 Golden 对比（DP-2 可回归前提；CTX-100 每加一段跑 Golden 对比）。
// 用法：node evals/golden/compare.mjs <candidate.json> [baseline.json]
//   显式路径相对调用方 cwd；缺省 baseline=evals/golden/baselines/claude-sonnet-4-6.json。
// 输出：逐字段 diff 报告（segments/system/messages/tools）；退出码 0=一致、1=有差异、2=用法错（CI 可用）。
// 对比在脱敏域进行：双方内容均先过脱敏规则（跨机可比，不因本地路径差异误报）。
import { homedir, tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rules = [];
for (const [label, value] of [["<home>", homedir()], ["<tmp>", tmpdir()], ["<cwd>", process.cwd()]]) {
  if (value && value !== "/") rules.push([value, label]);
}
function sanitize(text) {
  let s = String(text);
  for (const [from, to] of rules) s = s.split(from).join(to);
  s = s.replace(/[A-Za-z]:\\[^\s"']*/g, "<path>");
  s = s.replace(/\/(?:home|Users)\/[^\s"'/]+/g, "<home>");
  return s;
}
function deepSanitize(v) {
  if (typeof v === "string") return sanitize(v);
  if (Array.isArray(v)) return v.map(deepSanitize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSanitize(x)]));
  return v;
}

function load(absPath) {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

const candidateArg = process.argv[2];
const baselineArg = process.argv[3];
if (!candidateArg) {
  console.error("usage: node evals/golden/compare.mjs <candidate.json> [baseline.json]");
  process.exit(2);
}
const goldenRoot = fileURLToPath(new URL(".", import.meta.url));
const candidatePath = isAbsolute(candidateArg) ? candidateArg : resolve(candidateArg);
const baselinePath = baselineArg ? (isAbsolute(baselineArg) ? baselineArg : resolve(baselineArg)) : resolve(goldenRoot, "baselines", "claude-sonnet-4-6.json");
const a = deepSanitize(load(baselinePath));
const b = deepSanitize(load(candidatePath));

function diffPath(x, y, path, out) {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  if (x === undefined || y === undefined || typeof x !== typeof y || x === null || y === null || Array.isArray(x) !== Array.isArray(y) || typeof x !== "object") {
    out.push({ path, baseline: x, candidate: y });
    return;
  }
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) diffPath(x[k], y[k], `${path}.${k}`, out);
}

const diffs = [];
diffPath(a, b, "$", diffs);
if (diffs.length === 0) {
  console.log(`[golden] MATCH: ${candidatePath} == ${baselinePath}`);
  process.exit(0);
}
console.log(`[golden] DIFF: ${diffs.length} field(s) changed vs ${baselinePath}`);
for (const d of diffs.slice(0, 20)) {
  console.log(`--- ${d.path}`);
  console.log(`  baseline : ${JSON.stringify(d.baseline)?.slice(0, 200)}`);
  console.log(`  candidate: ${JSON.stringify(d.candidate)?.slice(0, 200)}`);
}
if (diffs.length > 20) console.log(`... (+${diffs.length - 20} more)`);
console.log(`[golden] 按段归类：${[...new Set(diffs.map((d) => d.path.split(".")[1] ?? d.path))].join(", ")}`);
process.exit(1);
