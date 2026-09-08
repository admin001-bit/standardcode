// WP-09 rework（ADR-0032 决策 1 勘误：用户裁决 2026-09-08 改自实现 diff，推翻"git 复用"代选）：
// 行级 LCS diff + unified 输出。语义=会话文件变更面（file-history 快照基线 vs 当前内容）——
// 不依赖系统 git，任何目录可用（裁决动因）。与 [CC] /diff（git 工作树 diff）语义不同=§12.5 差异登记。

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileHistoryStore, SnapshotRecord } from "./file-history.ts";

const pathJoin = path.join;

export const DIFF_MAX_LINES = 5000; // 单侧行数上限（防 O(n²) DP 爆炸；超出截断登记）

export type DiffOp = "ctx" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** LCS 行级 diff（DP；对角剔除公共前后缀降低规模）。 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  // 公共前后缀削减
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: "ctx", text: a[i]! });

  if (midA.length === 0 || midB.length === 0) {
    for (const t of midA) out.push({ op: "del", text: t });
    for (const t of midB) out.push({ op: "add", text: t });
  } else if (midA.length > DIFF_MAX_LINES || midB.length > DIFF_MAX_LINES) {
    // 超限：不跑 DP，整段以 del/add 呈现（截断语义，登记于输出尾）
    for (const t of midA) out.push({ op: "del", text: t });
    for (const t of midB) out.push({ op: "add", text: t });
  } else {
    // LCS DP
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: "ctx", text: midA[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push({ op: "del", text: midA[i]! });
        i++;
      } else {
        out.push({ op: "add", text: midB[j]! });
        j++;
      }
    }
    while (i < n) {
      out.push({ op: "del", text: midA[i]! });
      i++;
    }
    while (j < m) {
      out.push({ op: "add", text: midB[j]! });
      j++;
    }
  }
  for (let k = endA; k < a.length; k++) out.push({ op: "ctx", text: a[k]! });
  return out;
}

/** unified 输出（context=3 hunk 合并）；无差异 → 空串。 */
export function unifiedDiff(aPath: string, aText: string, bPath: string, bText: string, context = 3): string {
  if (aText === bText) return "";
  const a = aText.split("\n");
  const b = bText.split("\n");
  // 尾部空行归一（split 尾产生 ""）
  if (a.length > 1 && a[a.length - 1] === "") a.pop();
  if (b.length > 1 && b[b.length - 1] === "") b.pop();
  const lines = diffLines(a, b);
  if (lines.every((l) => l.op === "ctx")) return "";

  const header = `--- a/${aPath}\n+++ b/${bPath}`;
  // hunk 切分：ctx 游程 ±context
  const hunks: DiffLine[][] = [];
  let cur: DiffLine[] = [];
  let ctxRun = 0;
  for (const l of lines) {
    if (l.op === "ctx") {
      ctxRun++;
      cur.push(l);
      if (ctxRun > context * 2) {
        // 超过 2×context 的纯 ctx = hunk 分界（保留 context 行给两侧 hunk）
        const tail = cur.slice(-context);
        hunks.push(cur);
        cur = [...tail];
        ctxRun = context;
      }
    } else {
      ctxRun = 0;
      cur.push(l);
    }
  }
  // 尾部裁剪：末 hunk 的尾随 ctx 保留至多 context 行
  if (cur.length > 0) {
    let trailing = 0;
    for (let k = cur.length - 1; k >= 0 && cur[k]!.op === "ctx"; k--) trailing++;
    if (trailing > context) {
      const head = cur.slice(0, cur.length - trailing);
      const trimmed = cur.slice(cur.length - context);
      if (head.some((l) => l.op !== "ctx")) hunks.push(head);
      cur = trimmed;
    }
  }
  if (cur.some((l) => l.op !== "ctx")) hunks.push(cur);

  const parts: string[] = [header];
  let aLine = 1;
  let bLine = 1;
  for (const hunk of hunks) {
    const aStart = aLine;
    const bStart = bLine;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (const l of hunk) {
      if (l.op === "ctx") {
        aCount++;
        bCount++;
        body.push(` ${l.text}`);
        aLine++;
        bLine++;
      } else if (l.op === "del") {
        aCount++;
        body.push(`-${l.text}`);
        aLine++;
      } else {
        bCount++;
        body.push(`+${l.text}`);
        bLine++;
      }
    }
    // 空 hunk（全 ctx）跳过
    if (aCount === 0 && bCount === 0) continue;
    parts.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    parts.push(...body);
  }
  return parts.join("\n");
}

/** /diff 数据面：会话文件变更面（基线=每文件首快照存档内容或"不存在"，对比当前内容）。 */
export interface SessionDiffResult {
  output: string;
  /** 出现差异的文件数。 */
  changed: number;
  /** 扫过的文件数（含无差异）。 */
  scanned: number;
  /** 无法建基线被跳过的文件（存档缺失）。 */
  skipped: string[];
}

export async function sessionDiff(store: FileHistoryStore, opts: { readFile?: typeof readFile } = {}): Promise<SessionDiffResult> {
  const doRead = opts.readFile ?? readFile;
  const records = await store.records();
  const byFile = new Map<string, SnapshotRecord[]>();
  for (const r of records) {
    const list = byFile.get(r.filePath) ?? [];
    list.push(r);
    byFile.set(r.filePath, list);
  }
  const chunks: string[] = [];
  let changed = 0;
  let skipped = 0;
  const skippedFiles: string[] = [];
  for (const [filePath, list] of byFile) {
    const first = list[0]!;
    let baseText: string | null;
    if (!first.existed) {
      baseText = ""; // 会话起点不存在=新建文件 → 基线空
    } else {
      try {
        baseText = (await doRead(pathJoin(store.dir, first.storedAs))).toString("utf8");
      } catch {
        skippedFiles.push(filePath);
        skipped++;
        continue; // 存档缺失（快照损坏）→ 跳过不猜
      }
    }
    let currentText: string | null;
    try {
      currentText = (await doRead(filePath)).toString("utf8");
    } catch {
      currentText = ""; // 当前不存在=已删除 → 对比空
    }
    const d = unifiedDiff(filePath, baseText, filePath, currentText);
    if (d !== "") {
      changed++;
      chunks.push(d);
    }
  }
  return { output: chunks.join("\n"), changed, scanned: byFile.size - skipped, skipped: skippedFiles };
}
