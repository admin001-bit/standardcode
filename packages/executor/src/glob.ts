// L4 Glob 原语：全树遍历 + 段匹配器过滤（[自定]：M1 无外部 glob 依赖；[CC] _525.js 自研 picomatch 变体——实现不同、语义同构）。
// 语义：模式相对 root 锚定（无 matchBase）；`*` 不跨 `/`、`**` 跨目录、`?` 单字符（不支持字符类/花括号——M1 简化）；
// 结果按修改时间倒序（新文件在前，[CC] 同构），上限截断。
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ExecError, type ExecEnv } from "./env.ts";
import { requireString } from "./read.ts";

export const GLOB_MAX_RESULTS = 100;
export const GLOB_MAX_DEPTH = 64;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface GlobInput {
  pattern: string;
  path?: string;
}

export async function execGlob(input: GlobInput, env: ExecEnv): Promise<string> {
  const pattern = requireString(input.pattern, "pattern");
  const root = input.path ? resolve(env.cwd, input.path) : env.cwd;
  const compiled = pattern.split(/[\\/]/).map((seg) => (seg === "**" ? null : globToRegExp(seg)));
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  try {
    await walk(root, root, "", 0, compiled, matches);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new ExecError(`path not found: ${root}`);
    throw err;
  }
  if (matches.length === 0) return "no files found";
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  const lines = matches.slice(0, GLOB_MAX_RESULTS).map((m) => relative(root, m.path).split(sep).join("/"));
  if (matches.length > GLOB_MAX_RESULTS) lines.push(`... (${matches.length - GLOB_MAX_RESULTS} more, showing ${GLOB_MAX_RESULTS} newest)`);
  return lines.join("\n");
}

async function walk(root: string, dir: string, relDir: string, depth: number, compiled: Array<RegExp | null>, out: Array<{ path: string; mtimeMs: number }>): Promise<void> {
  if (depth > GLOB_MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/竞态删除：跳过该目录
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(root, full, rel, depth + 1, compiled, out);
    } else if (entry.isFile() && matchSegments(compiled, rel.split("/"))) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {}
      out.push({ path: full, mtimeMs });
    }
  }
}

function matchSegments(compiled: Array<RegExp | null>, parts: string[], ci = 0, pi = 0): boolean {
  if (ci === compiled.length) return pi === parts.length;
  const c = compiled[ci];
  if (c === null) {
    // `**`：吞噬 0..N 段
    for (let k = pi; k <= parts.length; k++) if (matchSegments(compiled, parts, ci + 1, k)) return true;
    return false;
  }
  if (pi >= parts.length || !c.test(parts[pi])) return false;
  return matchSegments(compiled, parts, ci + 1, pi + 1);
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}
