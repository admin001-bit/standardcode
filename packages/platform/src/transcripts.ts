// 转录 JSONL schema（v2.8 §13 行 2：M1 设计、实现阻塞级——ADR-0028 定稿）与落盘/读回。
// 路径（§2 行 M2 原文）：~/.standardcode/projects/<encoded>/transcripts/
// <encoded> = 项目绝对路径编码（[自定]：路径分隔符与冒号 → '-'，保留大小写，非 [A-Za-z0-9._-] → hex）。
// 行格式：一事件一行 JSON（NDJSON），字段见 TranscriptRecord；schemaVersion 从 1 起。

import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LLMMessage, TokenUsage } from "@standardcode/providers";
import type { DoneReason } from "@standardcode/harness";

export const SCHEMA_VERSION = 1;

/** 一条转录记录 = 会话中的一个不可分割事件。 */
export interface TranscriptRecord {
  schemaVersion: 1;
  /** 单调递增（会话内），从 1 起——resume 时校验连续性。 */
  seq: number;
  ts: string; // ISO 8601
  kind: "user_message" | "assistant_message" | "interrupt" | "done" | "compact";
  /** kind=assistant_message/user_message 时在位（IR 形状原样落盘）。 */
  message?: LLMMessage;
  /** kind=interrupt：发生阶段。 */
  phase?: "stream" | "tool";
  /** kind=done：终态原因。 */
  reason?: DoneReason;
  /** kind=done：会话累计 usage（ADR-0027 四列）。 */
  usage?: TokenUsage;
  /** kind=compact（ADR-0038）：压缩前 token 估算。 */
  preTokens?: number;
  /** kind=compact：压缩后 token 估算。 */
  postTokens?: number;
  /** kind=compact：触发通道。 */
  mode?: "manual" | "auto";
  /** kind=compact：9 段摘要文本（重建截断语义的历史起点锚点）。 */
  summary?: string;
  /** kind=compact：压缩后保留的尾部消息数（newMessages−摘要自身；partial>0 时重建保留该尾部——ADR-0038 R1 修订）。 */
  keptCount?: number;
}

export function transcriptsDir(projectRoot: string, baseDir = path.join(homedir(), ".standardcode")): string {
  const encoded = encodeProjectPath(projectRoot);
  return path.join(baseDir, "projects", encoded, "transcripts");
}

/** WP-06：项目自动记忆目录（§9.1 ②：~/.standardcode/projects/<enc>/memory/——与 transcripts/同 enc 基座）。 */
export function projectMemoryDir(projectRoot: string, baseDir = path.join(homedir(), ".standardcode")): string {
  const encoded = encodeProjectPath(projectRoot);
  return path.join(baseDir, "projects", encoded, "memory");
}

export function encodeProjectPath(projectRoot: string): string {
  // [自定]：`/` `\` `:` → '-'（ADR-0028 决策 2）；其余非 [A-Za-z0-9._-] → x<hex>（无歧义、Windows 文件名合法）
  let out = "";
  for (const ch of projectRoot) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else out += "-"; // 分隔符（/ \ :）与其余非法字符同级折叠——合法字符集已排除歧义，hex 转义仅保底给将来需要可逆时启用
  }
  return out;
}

export class TranscriptWriter {
  private seq = 0;
  constructor(private readonly filePath: string) {}

  static async create(projectRoot: string, sessionId: string, baseDir?: string): Promise<TranscriptWriter> {
    const dir = transcriptsDir(projectRoot, baseDir);
    await mkdir(dir, { recursive: true });
    return new TranscriptWriter(path.join(dir, `${sessionId}.jsonl`));
  }

  async append(rec: Omit<TranscriptRecord, "schemaVersion" | "seq" | "ts">): Promise<TranscriptRecord> {
    this.seq++;
    const full: TranscriptRecord = {
      schemaVersion: SCHEMA_VERSION,
      seq: this.seq,
      ts: new Date().toISOString(),
      ...rec,
    };
    await appendFile(this.filePath, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  get file(): string {
    return this.filePath;
  }
}

/** 读回整段转录（逐行 JSON；坏行跳过并计数——崩溃尾行容忍，E2E③ resume 依赖）。 */
export interface ReadBackResult {
  records: TranscriptRecord[];
  skippedMalformed: number;
}

export async function readTranscript(filePath: string): Promise<ReadBackResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skippedMalformed: 0 };
    throw err;
  }
  const records: TranscriptRecord[] = [];
  let skippedMalformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as TranscriptRecord;
      if (rec.schemaVersion === SCHEMA_VERSION && typeof rec.seq === "number") records.push(rec);
      else skippedMalformed++;
    } catch {
      skippedMalformed++; // 半截行（进程崩溃最后一条写一半）
    }
  }
  return { records, skippedMalformed };
}

/** 从转录重建会话消息历史（E2E③"JSONL 可 resume"的程序化恢复；isMeta 注入不含于转录，恢复时无需剥离）。
 * compact 记录截断语义（ADR-0038）：遇 compact 截断——保留此前消息的尾部 keptCount 条（partial 语义），
 * 以摘要消息为起点接续；keptCount 缺省=全量清空（旧记录防御）。重建=压缩后活体终态。 */
export function rebuildMessages(records: TranscriptRecord[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const r of records) {
    if (r.kind === "compact") {
      const kept = r.keptCount ?? 0;
      if (kept > 0) out.splice(0, Math.max(0, out.length - kept));
      else out.length = 0;
      out.push({ role: "user", content: [{ type: "text", text: r.summary ?? "(compacted)" }] });
      continue;
    }
    if ((r.kind === "user_message" || r.kind === "assistant_message") && r.message) out.push(r.message);
  }
  return out;
}

/** 程序化 resume：读回+重建；返回与中断时等价的消息历史与终态信息。 */
export async function resumeFrom(filePath: string): Promise<{ messages: LLMMessage[]; lastReason?: DoneReason; skippedMalformed: number }> {
  const { records, skippedMalformed } = await readTranscript(filePath);
  const doneRecs = records.filter((r) => r.kind === "done");
  return {
    messages: rebuildMessages(records),
    lastReason: doneRecs.at(-1)?.reason,
    skippedMalformed,
  };
}

/** 覆盖式重建（测试/迁移用；正常运行只追加）。 */
export async function overwriteTranscript(filePath: string, records: TranscriptRecord[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}
