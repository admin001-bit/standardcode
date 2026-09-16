// L4 Edit 原语：唯一性字符串替换（[CC] dig-03 §2：old_string 非唯一即拒绝，must-match fail-closed）。
// replace_all=true 时替换全部出现（[CC] 行为同构）。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ExecError, type ExecEnv } from "./env.ts";
import { requireString } from "./read.ts";
import { readRawFile } from "./write.ts";

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export async function execEdit(input: EditInput, env: ExecEnv): Promise<string> {
  const path = resolve(env.cwd, requireString(input.file_path, "file_path"));
  if (typeof input.old_string !== "string" || input.old_string.length === 0) throw new ExecError("old_string must be a non-empty string");
  if (typeof input.new_string !== "string") throw new ExecError("new_string must be a string");
  const current = await readRawFile(path);
  const occurrences = countOccurrences(current, input.old_string);
  if (occurrences === 0) throw new ExecError(`old_string not found in ${path}`);
  if (occurrences > 1 && !input.replace_all) throw new ExecError(`old_string is not unique in ${path} (${occurrences} occurrences) — provide more surrounding context or set replace_all`);
  const next = input.replace_all ? current.split(input.old_string).join(input.new_string) : current.replace(input.old_string, () => input.new_string);
  if (next === current) throw new ExecError("new_string is identical to old_string — nothing to change");
  const note = `edited ${path} (${input.replace_all && occurrences > 1 ? `${occurrences} replacements` : "1 replacement"})`;
  // 沙箱臂（WP-03 DoD②）：替换后的全文经 fsWrite 帧落盘（读侧 readRawFile=宿主读，
  // 读不受写策略限制——档差异在网络/写轴；越界/元数据写拒=沙箱层同 write.ts 形）。
  if (env.sandbox) {
    await env.sandbox.writeViaSandbox(path, next);
    return note;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return note;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    n++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return n;
}
