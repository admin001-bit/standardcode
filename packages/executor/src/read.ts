// L4 Read 原语：UTF-8 文本读取，cat -n 行号格式（[CC] dig-03 §2：默认 2000 行）。
// 超长单行截断与 10MB 体积护栏为 [自定]（M1 无 30K 截断落盘——E2E② 属 M2）。
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ExecError, type ExecEnv } from "./env.ts";

export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LINE_CHARS = 2000;
export const READ_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ReadInput {
  file_path: string;
  /** 1 起始行号。 */
  offset?: number;
  limit?: number;
}

export async function execRead(input: ReadInput, env: ExecEnv): Promise<string> {
  const path = resolve(env.cwd, requireString(input.file_path, "file_path"));
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ExecError(`file not found: ${path}`);
  }
  if (!info.isFile()) throw new ExecError(`not a regular file: ${path}`);
  if (info.size > READ_MAX_FILE_BYTES) throw new ExecError(`file too large (${info.size} bytes, limit ${READ_MAX_FILE_BYTES}): ${path}`);

  const handle = await open(path, "r");
  let raw: string;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  if (raw.includes("\0")) throw new ExecError(`binary file not displayed: ${path}`);
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (all.length === 1 && all[0] === "") all.length = 0;

  const offset = Math.max(Math.floor(input.offset ?? 1), 1);
  const limit = Math.max(Math.floor(input.limit ?? READ_DEFAULT_LIMIT), 1);
  const window = all.slice(offset - 1, offset - 1 + limit);
  const lines = window.map((line, i) => {
    const shown = line.length > READ_MAX_LINE_CHARS ? line.slice(0, READ_MAX_LINE_CHARS) + "…[line truncated]" : line;
    return `${String(offset + i).padStart(6, " ")}\t${shown}`;
  });
  const remaining = all.length - (offset - 1 + window.length);
  if (remaining > 0) lines.push(`... (+${remaining} more lines)`);
  if (lines.length === 0) return "(empty file or window past EOF)";
  return lines.join("\n");
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ExecError(`${name} must be a non-empty string`);
  return value;
}
