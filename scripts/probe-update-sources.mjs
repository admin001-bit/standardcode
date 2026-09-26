#!/usr/bin/env node
// M8-WP-06（ADR-0053）交付物：更新双源**只读**真实探测（GET only，零外发；M7 遗留 #13「Releases 成功路无真实样本」闭合工具）。
// 用法：node scripts/probe-update-sources.mjs   （Node ≥ 24：TS 直导＝type stripping；单源实现零复制）
// 输出：逐源一行 JSON（{source,ok,latest|reason}）＋汇总行。
// 退出码：0=两源均 ok；1=任一源失败（fail-closed，不静默）。
import { checkGitHubLatest, checkRegistryLatest } from "../packages/platform/src/updater.ts";

const results = [];
results.push({ source: "npm", ...(await checkRegistryLatest()) });
results.push({ source: "github", ...(await checkGitHubLatest()) });

for (const r of results) {
  console.log(JSON.stringify(r.ok ? { source: r.source, ok: true, latest: r.latest } : { source: r.source, ok: false, reason: r.reason }));
}
const allOk = results.every((r) => r.ok);
console.log(
  `probe: ${allOk ? "PASS" : "FAIL"} (` +
    results.map((r) => `${r.source}=${r.ok ? r.latest : "ERR"}`).join(", ") +
    ")",
);
process.exit(allOk ? 0 : 1);
