// WP-09 rework（ADR-0032 决策 1 勘误：用户裁决 2026-09-08 改自实现 diff，推翻"git 复用"代选）：
// 行级 LCS diff + unified 输出。语义=会话文件变更面（file-history 快照基线 vs 当前内容）——
// 不依赖系统 git，任何目录可用（裁决动因）。与 [CC] /diff（git 工作树 diff）语义不同=§12.5 差异登记。
// 【勘误 2026-09-08 第二轮 V 复验】初版 unifiedDiff hunk 组装在 ctx 游程 >2×context 时损坏
//（伪 hunk/重叠/行号越界）——重写：diffLines 行携带绝对行号，hunk 按"变更点分组+前缀计数"发射
//（aStart/aCount/bStart/bCount 由 aBefore/bBefore 前缀计数推得，无全局游标递推）。
// 与 git 输出的保真差异：无 "\ No newline at end of file" 标记（§12.5 登记）。

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileHistoryStore, SnapshotRecord } from "./file-history.ts";

export const DIFF_MAX_LINES = 5000; // 单侧行数上限（防 O(n²) DP 爆炸；超出截断登记）

export type DiffOp = "ctx" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 原文件绝对行号（0 基；del/ctx 在位）。 */
  aIdx?: number;
  /** 新文件绝对行号（0 基；add/ctx 在位）。 */
  bIdx?: number;
}

/** LCS 行级 diff（DP；公共前后缀削减；行号绝对 0 基）。 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
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
  for (let i = 0; i < start; i++) out.push({ op: "ctx", text: a[i]!, aIdx: i, bIdx: i });

  const pushDel = (t: string, idx: number) => out.push({ op: "del", text: t, aIdx: idx });
  const pushAdd = (t: string, idx: number) => out.push({ op: "add", text: t, bIdx: idx });

  if (midA.length === 0 || midB.length === 0) {
    for (let i = 0; i < midA.length; i++) pushDel(midA[i]!, start + i);
    for (let j = 0; j < midB.length; j++) pushAdd(midB[j]!, start + j);
  } else if (midA.length > DIFF_MAX_LINES || midB.length > DIFF_MAX_LINES) {
    // 超限：不跑 DP，整段以 del/add 呈现（截断语义）
    for (let i = 0; i < midA.length; i++) pushDel(midA[i]!, start + i);
    for (let j = 0; j < midB.length; j++) pushAdd(midB[j]!, start + j);
  } else {
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
        out.push({ op: "ctx", text: midA[i]!, aIdx: start + i, bIdx: start + j });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        pushDel(midA[i]!, start + i);
        i++;
      } else {
        pushAdd(midB[j]!, start + j);
        j++;
      }
    }
    while (i < n) {
      pushDel(midA[i]!, start + i);
      i++;
    }
    while (j < m) {
      pushAdd(midB[j]!, start + j);
      j++;
    }
  }
  const bShift = a.length - b.length;
  for (let k = endA; k < a.length; k++) out.push({ op: "ctx", text: a[k]!, aIdx: k, bIdx: k - bShift });
  return out;
}

interface Hunk {
  aStart: number; // 0 基
  aCount: number;
  bStart: number;
  bCount: number;
  lines: DiffLine[];
}

/**
 * hunk 分组（规范算法，V 第二轮退回返工）：以 lines 序号定位变更点，ctx 游程 >2×context 切分；
 * 每 hunk 边界=变更区 ±context（clamp 到数组界）。行号经 aBefore/bBefore 前缀计数推得。
 */
function groupHunks(lines: DiffLine[], context: number): Array<{ start: number; end: number }> {
  const isChange = (l: DiffLine): boolean => l.op !== "ctx";
  const groups: Array<{ start: number; end: number }> = [];
  const n = lines.length;
  let curStart = -1;
  let curEnd = -1; // 独占
  let lastChangeIdx = -1;
  for (let i = 0; i < n; i++) {
    if (!isChange(lines[i]!)) continue;
    if (curStart === -1) {
      curStart = Math.max(0, i - context);
      curEnd = i + 1;
    } else if (i - lastChangeIdx > context * 2 + 1) {
      groups.push({ start: curStart, end: Math.min(n, curEnd + context) });
      curStart = Math.max(0, i - context);
      curEnd = i + 1;
    } else {
      curEnd = i + 1;
    }
    lastChangeIdx = i;
  }
  if (curStart !== -1) groups.push({ start: curStart, end: Math.min(n, curEnd + context) });
  return groups;
}

/** unified 输出（context=3）；无差异 → 空串。行号语义对齐 git（count=0 时 start 不 +1）。 */
export function unifiedDiff(aPath: string, aText: string, bPath: string, bText: string, context = 3): string {
  if (aText === bText) return "";
  const a = aText.split("\n");
  const b = bText.split("\n");
  if (a.length > 1 && a[a.length - 1] === "") a.pop();
  if (b.length > 1 && b[b.length - 1] === "") b.pop();
  const lines = diffLines(a, b);
  if (lines.every((l) => l.op === "ctx")) return "";

  // 前缀计数：aBefore[i]=lines[0..i) 中带 aIdx 的行数（=该点之前的 a 行总数）
  const aBefore: number[] = new Array(lines.length + 1);
  const bBefore: number[] = new Array(lines.length + 1);
  aBefore[0] = 0;
  bBefore[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    aBefore[i + 1] = aBefore[i]! + (lines[i]!.aIdx !== undefined ? 1 : 0);
    bBefore[i + 1] = bBefore[i]! + (lines[i]!.bIdx !== undefined ? 1 : 0);
  }

  const parts: string[] = [`--- a/${aPath}`, `+++ b/${bPath}`];
  for (const g of groupHunks(lines, context)) {
    const aCount = aBefore[g.end]! - aBefore[g.start]!;
    const bCount = bBefore[g.end]! - bBefore[g.start]!;
    const aHead = aCount > 0 ? aBefore[g.start]! + 1 : aBefore[g.start]!;
    const bHead = bCount > 0 ? bBefore[g.start]! + 1 : bBefore[g.start]!;
    parts.push(`@@ -${aHead},${aCount} +${bHead},${bCount} @@`);
    for (let i = g.start; i < g.end; i++) {
      const l = lines[i]!;
      parts.push(`${l.op === "ctx" ? " " : l.op === "del" ? "-" : "+"}${l.text}`);
    }
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
  /** 无法建基线被跳过的文件（存档缺失/读失败非 ENOENT）。 */
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
  const skippedFiles: string[] = [];
  let scanned = 0;
  for (const [filePath, list] of byFile) {
    const first = list[0]!;
    let baseText: string | null;
    if (!first.existed) {
      baseText = ""; // 会话起点不存在=新建文件 → 基线空
    } else {
      try {
        baseText = (await doRead(path.join(store.dir, first.storedAs))).toString("utf8");
      } catch {
        skippedFiles.push(filePath);
        continue; // 存档缺失（快照损坏）→ 跳过不猜
      }
    }
    let currentText: string;
    try {
      currentText = (await doRead(filePath)).toString("utf8");
    } catch (err) {
      // 仅 ENOENT=已删除（按空对比）；其余错误跳过不猜（V 观察③口径对齐）
      if ((err as NodeJS.ErrnoException).code === "ENOENT") currentText = "";
      else {
        skippedFiles.push(filePath);
        continue;
      }
    }
    scanned++;
    const d = unifiedDiff(filePath, baseText, filePath, currentText);
    if (d !== "") {
      changed++;
      chunks.push(d);
    }
  }
  return { output: chunks.join("\n"), changed, scanned, skipped: skippedFiles };
}
