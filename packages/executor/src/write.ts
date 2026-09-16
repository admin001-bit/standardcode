// L4 Write 原语：整文件写入（存在即覆盖）。护栏：不能以目录为目标 [自定]；已有文件读取-写入而不经 Edit 走独立流程（M1 不做强制 read-before-write）。
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ExecError, type ExecEnv } from "./env.ts";
import { requireString } from "./read.ts";

export interface WriteInput {
  file_path: string;
  content: string;
}

export async function execWrite(input: WriteInput, env: ExecEnv): Promise<string> {
  const path = resolve(env.cwd, requireString(input.file_path, "file_path"));
  if (typeof input.content !== "string") throw new ExecError("content must be a string");
  let info;
  try {
    info = await stat(path);
    if (info.isDirectory()) throw new ExecError(`path is a directory, not a file: ${path}`);
  } catch (err) {
    if (err instanceof ExecError) throw err;
    // ENOENT：目标不存在，继续
  }
  // 沙箱臂（WP-03 DoD②"文件写经沙箱"）：内容经 fsWrite 帧→沙箱内 --fs-write 子进程落盘
  // （越界写/元数据路径=策略层拒，错误可诊断上抛；目录预建在沙箱内完成）。
  if (env.sandbox) {
    await env.sandbox.writeViaSandbox(path, input.content);
    return `wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path}`;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.content, "utf8");
  return `wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path}`;
}

/** Edit 用：读当前内容（不存在抛错，写入侧保证目录存在）。 */
export async function readRawFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ExecError(`file not found: ${path}`);
  }
}
