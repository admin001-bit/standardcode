// WP-04 R-G 修复（2026-09-09 V 退回）：压缩模板 Golden 采集（v2.8 §12.2 CTX-100 纪律——"每加一段跑 Golden 对比"）。
// 口径 [自定]：快照=压缩 prompt 模板稳定面（full/partial 两变体全文+9 段名序+partial 段名）；
//   请求前缀=会话历史（动态内容）不采——模板是"加段"纪律的作用面，前缀共享结构由 compact-summarizer 测试钉住。
// 用法：node evals/golden/capture-compact.mjs > evals/golden/baselines/compact-claude-sonnet-4-6.json
// 对比：node evals/golden/compare.mjs <candidate.json> evals/golden/baselines/compact-claude-sonnet-4-6.json
// 模板无路径/时间戳，deepSanitize 复用主采集器规则（防未来模板引入路径时基线跨机不可比）。
import { homedir, tmpdir } from "node:os";
import { COMPACT_SECTIONS, PARTIAL_SECTION_8, PARTIAL_SECTION_9, buildCompactPrompt } from "../../packages/context/src/compact/summarizer.ts";

const rules = [];
for (const [label, value] of [
  ["<home>", homedir()],
  ["<tmp>", tmpdir()],
  ["<cwd>", process.cwd()],
]) {
  if (value && value !== "/") rules.push([value, label]);
}
function sanitize(text) {
  let s = text;
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

const snapshot = {
  schema: "standardcode-golden-compact-snapshot@1",
  model: "claude-sonnet-4-6",
  sections: [...COMPACT_SECTIONS],
  partialSections: [PARTIAL_SECTION_8, PARTIAL_SECTION_9],
  variants: {
    full: buildCompactPrompt(),
    partial: buildCompactPrompt({ partial: true }),
  },
};

process.stdout.write(JSON.stringify(deepSanitize(snapshot), null, 2) + "\n");
