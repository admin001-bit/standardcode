// WP-08（M2）：会话索引（/resume 数据源，UI-030）+ 多开并发写加锁（§13 行 9 处置）+ S-10 转录敏感面对策。
// S-10（§11 原文）：转录文件权限收紧（用户目录 0600 语义；Windows 用户目录 ACL 已隔离，chmod best-effort
// 登记偏差）；密钥值写入前替换脱敏；清理提示归 /doctor（WP-11）。
// 加锁（[自定] 设计，ADR-0031）：同项目 transcript 写互斥=O_EXCL 锁文件 + PID + mtime 陈旧判定（30s）——
// 简单可靠、无原生依赖；checkpoint 加锁同构（M3 WP-08 清偿：file-history 写入经 SessionLock.acquireIn 复用同机制）。
// 磁盘满降级（§13 行 10 统一矩阵的落盘路径切片）：ENOSPC/EDQUOT → 写失败不抛、降级内存缓冲+告警一次，
// 会话继续（transcript 缺口登记于 writer.degraded）。

import { open, mkdir, readdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readTranscript, transcriptsDir, SCHEMA_VERSION } from "./transcripts.ts";

// —— S-10 脱敏 ——

/** 密钥形状（写入前替换；保守白名单形状，防误伤普通文本）。 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic 形
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, // Bearer 头
];

export const SECRET_PLACEHOLDER = "[REDACTED]";

/** 密钥值写入前替换脱敏（S-10）；幂等（占位符不再命中形状）。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rx of SECRET_PATTERNS) out = out.replace(rx, SECRET_PLACEHOLDER);
  return out;
}

// —— S-10 权限收紧 ——

/** 转录文件 0600 语义（POSIX chmod；Windows 用户目录 ACL 已隔离，chmod 为 no-op——登记偏差）。 */
export async function tightenFilePermissions(filePath: string): Promise<boolean> {
  try {
    await chmod(filePath, 0o600);
    return true;
  } catch {
    return false; // Windows chmod 仅支持只读位，失败即 no-op（不视为错误）
  }
}

// —— 磁盘满降级 ——

function isDiskFull(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

// —— 多开加锁（ADR-0031）——

export const LOCK_STALE_MS = 30_000;

export class SessionLock {
  private locked = false;
  private constructor(readonly lockPath: string) {}

  /** 获取同项目会话写锁（互斥；已持锁抛错）。锁文件=transcripts 目录下 <sessionId>.lock。 */
  static async acquire(projectRoot: string, sessionId: string, baseDir = path.join(homedir(), ".standardcode")): Promise<SessionLock> {
    return SessionLock.acquireIn(transcriptsDir(projectRoot, baseDir), `${sessionId}.lock`);
  }

  /**
   * 通用目录级互斥锁（同 ADR-0031 机制：O_EXCL + PID + mtime 陈旧判定 30s）。
   * 复用方：file-history checkpoint 写入（SEC-080 卡边界"SessionLock 复用"——M2 WP-08 头注"checkpoint
   * 加锁同构，file-history 归 WP-09 后接入"的 M3 清偿位，锁文件=file-history 目录下 file-history.lock）。
   */
  static async acquireIn(dir: string, lockFile: string): Promise<SessionLock> {
    await mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, lockFile);
    const handle = await open(lockPath, "wx").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") {
        return null; // 已被持有（陈旧判定走下方抢占路径）
      }
      throw err;
    });
    if (!handle) {
      // 检查陈旧：超时则抢占重写
      const raw = (await readFile(lockPath, "utf8").catch(() => "")).trim();
      const m = /^pid=(\d+)\nts=(\d+)$/.exec(raw);
      const stale = m !== null && Date.now() - Number(m[2]) > LOCK_STALE_MS;
      const selfPid = m !== null && Number(m[1]) === process.pid;
      if (stale && !selfPid) {
        await unlink(lockPath).catch(() => {});
        const h2 = await open(lockPath, "wx").catch(() => null);
        if (h2) {
          await h2.write(`pid=${process.pid}\nts=${Date.now()}\n`, null, "utf8");
          await h2.close();
          return new SessionLock(lockPath).markLocked();
        }
      }
      throw new Error(`session lock held: ${lockPath}（同写面互斥，§13 行 9；${stale ? "陈旧锁清理失败" : "另一持有者"}）`);
    }
    await handle.write(`pid=${process.pid}\nts=${Date.now()}\n`, null, "utf8");
    await handle.close();
    return new SessionLock(lockPath).markLocked();
  }

  private markLocked(): this {
    this.locked = true;
    return this;
  }

  /** 释放（幂等）。 */
  async release(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await unlink(this.lockPath).catch(() => {});
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

// —— 会话索引（/resume 数据源）——

export interface SessionIndexEntry {
  sessionId: string;
  filePath: string;
  /** 首条 user_message 文本前 80 字符（标题，/resume 预览）。 */
  title: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** user+assistant 消息数（轮次近似）。 */
  messageCount: number;
  lastReason: string | null;
}

/**
 * 枚举同项目全部转录（/resume 列表；坏文件跳过计数）。
 * 标题优先级：rename sidecar（<sessionId>.meta.json，WP-10 /rename 写入）> 首条 user 前 80 字。
 */
export async function listSessions(projectRoot: string, baseDir = path.join(homedir(), ".standardcode")): Promise<{ sessions: SessionIndexEntry[]; skippedMalformed: number }> {
  const dir = transcriptsDir(projectRoot, baseDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { sessions: [], skippedMalformed: 0 }; // 目录不存在=无会话
  }
  const sessions: SessionIndexEntry[] = [];
  let skippedMalformed = 0;
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    const filePath = path.join(dir, name);
    const { records, skippedMalformed: bad } = await readTranscript(filePath);
    skippedMalformed += bad;
    const msgs = records.filter((r) => r.kind === "user_message" || r.kind === "assistant_message");
    if (records.length === 0) continue;
    const firstUser = records.find((r) => r.kind === "user_message");
    const titleText = firstUser?.message?.content.find((b) => b.type === "text");
    const doneRecs = records.filter((r) => r.kind === "done");
    const sessionId = name.slice(0, -".jsonl".length);
    let title = (titleText && titleText.type === "text" ? titleText.text : "").slice(0, 80);
    const sidecar = path.join(dir, `${sessionId}.meta.json`);
    try {
      const meta = JSON.parse(await readFile(sidecar, "utf8")) as { title?: unknown };
      if (typeof meta.title === "string" && meta.title.trim() !== "") title = meta.title.trim();
    } catch {
      // 无 sidecar=用推导标题（常态）
    }
    sessions.push({
      sessionId,
      filePath,
      title,
      startedAt: records[0]!.ts,
      lastActivityAt: records[records.length - 1]!.ts,
      messageCount: msgs.length,
      lastReason: doneRecs.at(-1)?.reason ?? null,
    });
  }
  return { sessions, skippedMalformed };
}

/** WP-10 /rename：标题写 sidecar（append-only 转录不改写；sidecar 覆盖式=标题唯一权威）。 */
export async function renameSessionTitle(projectRoot: string, sessionId: string, title: string, baseDir = path.join(homedir(), ".standardcode")): Promise<void> {
  const dir = transcriptsDir(projectRoot, baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sessionId}.meta.json`), JSON.stringify({ title: title.trim() }) + "\n", "utf8");
}

// —— 脱敏写入器（TranscriptWriter 组合层）——

import { TranscriptWriter, type TranscriptRecord } from "./transcripts.ts";

/**
 * S-10+磁盘满降级包装：写入前脱敏（message 文本与 tool_result 内容）；ENOSPC/EDQUOT 降级
 * 内存缓冲+degraded 登记（会话继续，缺口可由 /doctor 提示）。
 */
export class ResilientTranscriptWriter {
  private inner: TranscriptWriter | null;
  private memoryBuffer: TranscriptRecord[] = [];
  /** 磁盘满后=true（此后记录只进内存缓冲）。 */
  degraded = false;
  degradeReason: string | null = null;

  private constructor(inner: TranscriptWriter | null) {
    this.inner = inner;
  }

  static async create(projectRoot: string, sessionId: string, baseDir?: string, opts: { redact?: boolean; tighten?: boolean } = {}): Promise<ResilientTranscriptWriter> {
    const inner = await TranscriptWriter.create(projectRoot, sessionId, baseDir);
    if (opts.tighten ?? true) await tightenFilePermissions(inner.file);
    return new ResilientTranscriptWriter(inner);
  }

  async append(rec: Omit<TranscriptRecord, "schemaVersion" | "seq" | "ts">): Promise<TranscriptRecord> {
    const redacted = opts_redact(rec);
    if (this.degraded || !this.inner) {
      const full: TranscriptRecord = {
        schemaVersion: SCHEMA_VERSION,
        seq: this.memoryBuffer.length + 1, // 近似 seq（降级期无法读回真实 writer seq；恢复以内容为准）
        ts: new Date().toISOString(),
        ...redacted,
      };
      this.memoryBuffer.push(full);
      return full;
    }
    try {
      return await this.inner.append(redacted);
    } catch (err) {
      if (isDiskFull(err)) {
        this.degraded = true;
        this.degradeReason = `disk full: ${(err as NodeJS.ErrnoException).code}`;
        return this.append(redacted); // 重入内存缓冲分支
      }
      throw err;
    }
  }

  /** 降级期内存缓冲（观测/测试）。 */
  get buffered(): readonly TranscriptRecord[] {
    return this.memoryBuffer;
  }

  get file(): string | null {
    return this.inner?.file ?? null;
  }
}

/** 对 message 文本与 tool_result 内容做 S-10 脱敏（其余字段无自由文本）。 */
function opts_redact(rec: Omit<TranscriptRecord, "schemaVersion" | "seq" | "ts">): Omit<TranscriptRecord, "schemaVersion" | "seq" | "ts"> {
  if (!rec.message) return rec;
  const message = {
    ...rec.message,
    content: rec.message.content.map((b) => {
      if (b.type === "text") return { ...b, text: redactSecrets(b.text) };
      if (b.type === "tool_result") return { ...b, content: redactSecrets(b.content) };
      return b;
    }),
  };
  return { ...rec, message };
}
