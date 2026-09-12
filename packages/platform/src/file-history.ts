// WP-09（M2）：file-history 快照（v2.8 §10 EXE-030/040/041 原文：每次工具写盘前快照入 file-history/，_788.js）
// + /rewind N 回滚 + 索引（schemaVersion，ENG-080）。
// 快照触发=每次工具写盘前（Write/Edit/改写类 Bash——Bash 目标以重定向启发式解析，[自定]，ADR-0032）。
// 布局：~/.standardcode/projects/<encoded>/file-history/<snapId>/ 存原文件树 + index.jsonl 逐行登记。
// 快照内容=写盘前全文件内容（EXE-040 依赖"快照入 file-history/"）；被 rewind 撤销的快照标记（不物理删除）。
// M3 WP-08：checkpoint 写入持锁（SessionLock.acquireIn 复用——同项目多会话的 seq 单调与索引追加互斥；
// 锁持有期=单次快照写（mkdir+存档+append 索引），冲突抛错→工具 error tool_result，ADR-0032 决策 5 同口径）。

import { mkdir, readFile, writeFile, appendFile, readdir, rename, access, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { encodeProjectPath, transcriptsDir } from "./transcripts.ts";
import { SessionLock } from "./session-store.ts";

export const FILE_HISTORY_SCHEMA_VERSION = 1;
/** file-history 目录级写锁文件名（SessionLock.acquireIn 复用位）。 */
export const FILE_HISTORY_LOCK_FILE = "file-history.lock";

export interface SnapshotRecord {
  schemaVersion: 1;
  /** 单调递增（项目内），从 1 起——/rewind N 的 N。 */
  seq: number;
  ts: string;
  tool: "Write" | "Edit" | "Bash";
  /** 被快照的绝对路径。 */
  filePath: string;
  /** 快照存档文件名（snap 目录内）。 */
  storedAs: string;
  /** 快照前文件是否存在（不存在=新建场景，rewind=删除该文件）。 */
  existed: boolean;
  /** 引发快照的会话（可空）。 */
  sessionId?: string;
}

export interface FileHistoryStore {
  dir: string;
  indexFile: string;
  /** 当前最大 seq（0=无快照）。 */
  maxSeq(): number;
  records(): Promise<SnapshotRecord[]>;
  /** 写盘前快照：读取现有内容入档（不存在=登记 existed=false）。返回 seq。 */
  snapshot(tool: SnapshotRecord["tool"], filePath: string, sessionId?: string): Promise<number>;
  /** /rewind N：撤销 seq≥N 的全部快照（恢复到第 N 次写盘前状态，EXE-040；见实现注释），返回撤销条数。 */
  rewindTo(seq: number): Promise<{ undone: number; files: string[] }>;
}

export function fileHistoryDir(projectRoot: string, baseDir = path.join(homedir(), ".standardcode")): string {
  const encoded = encodeProjectPath(projectRoot);
  return path.join(baseDir, "projects", encoded, "file-history");
}

export async function createFileHistoryStore(projectRoot: string, baseDir?: string): Promise<FileHistoryStoreImpl> {
  return FileHistoryStoreImpl.create(projectRoot, baseDir);
}

export class FileHistoryStoreImpl implements FileHistoryStore {
  private seq = 0;
  private constructor(
    readonly dir: string,
    readonly indexFile: string,
  ) {}

  static async create(projectRoot: string, baseDir = path.join(homedir(), ".standardcode")): Promise<FileHistoryStoreImpl> {
    const dir = fileHistoryDir(projectRoot, baseDir);
    await mkdir(dir, { recursive: true });
    const indexFile = path.join(dir, "index.jsonl");
    const store = new FileHistoryStoreImpl(dir, indexFile);
    // 已有索引恢复 seq（崩溃后继续单调）
    store.seq = maxSeqFromIndex(await readFile(indexFile, "utf8").catch(() => ""));
    return store;
  }

  maxSeq(): number {
    return this.seq;
  }

  async records(): Promise<SnapshotRecord[]> {
    const out: SnapshotRecord[] = [];
    try {
      const text = await readFile(this.indexFile, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as SnapshotRecord;
          if (rec.schemaVersion === FILE_HISTORY_SCHEMA_VERSION) out.push(rec);
        } catch {
          /* 坏行容忍 */
        }
      }
    } catch {
      /* 无索引 */
    }
    return out;
  }

  async snapshot(tool: SnapshotRecord["tool"], filePath: string, sessionId?: string): Promise<number> {
    // checkpoint 写入持锁（WP-08 DoD④）：锁内重读索引 maxSeq（跨会话/跨进程 seq 单调）→ 存档 → 追加索引。
    const lock = await SessionLock.acquireIn(this.dir, FILE_HISTORY_LOCK_FILE);
    try {
      this.seq = Math.max(this.seq, maxSeqFromIndex(await readFile(this.indexFile, "utf8").catch(() => "")));
      this.seq++;
      const snapId = `snap-${String(this.seq).padStart(6, "0")}`;
      await mkdir(path.join(this.dir, snapId), { recursive: true });
      const storedAs = `${snapId}/${encodeURIComponent(filePath).replace(/[%]/g, "_")}`;
      let existed = true;
      try {
        const content = await readFile(filePath);
        await writeFile(path.join(this.dir, storedAs), content);
      } catch (err) {
        // 仅 ENOENT=写盘前不存在（新建场景）；其他读失败（如 EACCES）按快照失败上抛
        // →工具调用合成 error tool_result（ADR-0032 决策 5：无快照宁可拒绝执行，防 rewind 误删）
        if ((err as NodeJS.ErrnoException).code === "ENOENT") existed = false;
        else throw err;
      }
      const rec: SnapshotRecord = {
        schemaVersion: FILE_HISTORY_SCHEMA_VERSION,
        seq: this.seq,
        ts: new Date().toISOString(),
        tool,
        filePath,
        storedAs,
        existed,
        ...(sessionId ? { sessionId } : {}),
      };
      await appendFile(this.indexFile, JSON.stringify(rec) + "\n", "utf8");
      return this.seq;
    } finally {
      await lock.release().catch(() => {});
    }
  }

  async rewindTo(targetSeq: number): Promise<{ undone: number; files: string[] }> {
    // 语义（EXE-040 "/rewind N"）：撤销 seq≥N 的全部快照（后进先出），即恢复到**第 N 次写盘前**的项目状态。
    // 【勘误 2026-09-08】初版边界取 seq>N 使 /rewind maxSeq（撤销最近一步）必然 no-op（V 复现缺陷）——
    // 快照 N 的存档内容恰是"第 N 次写盘前"的该文件状态，故 N 本身必须包含在撤销集内。
    // 索引只追加不改写（历史保留）。
    const records = (await this.records()).filter((r) => r.seq >= targetSeq).reverse(); // 后进先出
    const undoneFiles: string[] = [];
    for (const rec of records) {
      const snapPath = path.join(this.dir, rec.storedAs);
      let content: Buffer | null = null;
      try {
        content = await readFile(snapPath);
      } catch {
        content = null;
      }
      if (content !== null) {
        await mkdir(path.dirname(rec.filePath), { recursive: true });
        await writeFile(rec.filePath, content);
      } else if (!rec.existed) {
        // 快照前不存在=快照期间新建 → rewind 删除
        await rmForce(rec.filePath);
      } else {
        // existed=true 但存档缺失（快照目录损坏）：跳过不动作，保守
        continue;
      }
      undoneFiles.push(rec.filePath);
    }
    return { undone: undoneFiles.length, files: undoneFiles };
  }
}

/** 索引文本 → 最大 seq（坏行容忍，同 transcripts 口径；无索引=0）。 */
function maxSeqFromIndex(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SnapshotRecord;
      if (rec.schemaVersion === FILE_HISTORY_SCHEMA_VERSION && typeof rec.seq === "number" && rec.seq > max) max = rec.seq;
    } catch {
      /* 坏行容忍 */
    }
  }
  return max;
}

async function rmForce(p: string): Promise<void> {
  try {
    await access(p);
    const { unlink } = await import("node:fs/promises");
    await unlink(p);
  } catch {
    /* 已不存在 */
  }
}

// —— Bash 改写目标启发式（[自定]，ADR-0032）——

/**
 * 从 Bash 命令提取可能的写盘目标（保守白名单形状）：
 * `> file` `>> file` `tee file` `tee -a file` `install src dst` `mv src dst` `cp src dst`（dst 为写目标）。
 * 未匹配 → 无快照（Bash 写盘面广，启发式外漏登记偏差——护栏+权限仍独立生效）。
 */
export function bashWriteTargets(command: string): string[] {
  const targets = new Set<string>();
  const redirect = /(?:^|[\s;|&])(?:>>?|<<?)\s*("([^"]+)"|'([^']+)'|([^\s<>|&;]+))/g;
  for (const m of command.matchAll(redirect)) {
    const t = m[2] ?? m[3] ?? m[4];
    // 排除输入重定向（< 与 <<）：它们不写盘
    if (t && !m[0].includes("<")) targets.add(t);
  }
  for (const m of command.matchAll(/\btee\s+(?:-a\s+)?("([^"]+)"|'([^']+)'|([^\s|&;]+))/g)) {
    const t = m[2] ?? m[3] ?? m[4];
    if (t) targets.add(t);
  }
  for (const m of command.matchAll(/\b(?:mv|cp|install)\s+(?:-\S+\s+)*("([^"]+)"|'([^']+)'|[^\s]+)\s+("([^"]+)"|'([^']+)'|[^\s>]+)\s*$/g)) {
    const dst = m[4] ?? m[5] ?? m[6];
    if (dst && !dst.startsWith("-")) targets.add(dst);
  }
  return [...targets];
}
