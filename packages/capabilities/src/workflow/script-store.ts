// M6-WP-02：workflow 脚本持久化（交付物第四件；A 级 workflow 报告 §2.1 L170994 原文："每次调用自动把脚本存到
// session 目录并在工具结果中返回路径；迭代时改用 {scriptPath} 重调"；运行目录布局见 §7.4 L168877
// `transcriptSubdir: r ? \`workflows/${r}\``）。
//
// 层归属：本模块只做"给定 runsDir 写脚本"，**不计算 runsDir**——路径编码单源在 platform
// （`encodeProjectPath`/`workflowsDir`，packages/platform/src/transcripts.ts），capabilities 不复制（单源纪律）。
// 调用方（apps/cli 装配层）组合 `workflowsDir(projectRoot)` 后注入。
//
// 文件名净化 [自定]：meta.name 由脚本作者提供，直接拼路径会引入目录穿越；一律折叠为 `[A-Za-z0-9._-]`
// 并剥去首尾 `.`/`-`，空则回落缺省名。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKFLOW_SCRIPT_EXTENSION = ".js";

const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]+/g;
const FALLBACK_SCRIPT_NAME = "workflow";
const FALLBACK_RUN_ID = "run";
const MAX_SEGMENT_LENGTH = 64;

function sanitizeSegment(raw: string, fallback: string): string {
  const folded = raw.replace(UNSAFE_SEGMENT, "-");
  const trimmed = folded.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, MAX_SEGMENT_LENGTH);
}

/** runId → 单层安全目录名（防目录穿越）。 */
export function sanitizeWorkflowRunId(runId: string): string {
  return sanitizeSegment(runId, FALLBACK_RUN_ID);
}

/** meta.name → 单层安全文件名主干（防目录穿越）。 */
export function sanitizeWorkflowScriptName(name: string): string {
  return sanitizeSegment(name, FALLBACK_SCRIPT_NAME);
}

/** 某 run 的目录：`<runsDir>/<sanitized runId>`。 */
export function workflowRunDir(runsDir: string, runId: string): string {
  return path.join(runsDir, sanitizeWorkflowRunId(runId));
}

/** 脚本落盘路径：`<runsDir>/<runId>/<meta.name>.js`。 */
export function workflowScriptPath(runsDir: string, runId: string, name: string): string {
  return path.join(workflowRunDir(runsDir, runId), sanitizeWorkflowScriptName(name) + WORKFLOW_SCRIPT_EXTENSION);
}

/** 落盘脚本并返回路径（L170994 同构：调用方把该路径回填工具结果供 {scriptPath} 重调）。 */
export async function persistWorkflowScript(
  runsDir: string,
  runId: string,
  name: string,
  script: string,
): Promise<string> {
  const target = workflowScriptPath(runsDir, runId, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, script, "utf8");
  return target;
}
