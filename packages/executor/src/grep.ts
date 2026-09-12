// L4 Grep 原语：ripgrep 子进程（用户裁决 2026-09-08：系统 PATH 单来源；嵌入档不设——Node 分发无 Bun 单文件嵌入形态，M5+ 发布工程再评估）。
// [CC] dig-03 §4 锚点：超时 20s（WSL 60s）、退出码 0=有结果/1=无结果（均成功）、2+ 带部分结果、ENOENT 安装指引、
// 正则/参数错误截 stderr 2000 字符、EAGAIN 单线程重试。
import { resolve } from "node:path";
import { ExecError, type ExecEnv } from "./env.ts";
import { requireString } from "./read.ts";
import { runProcess } from "./proc.ts";

export const GREP_TIMEOUT_MS = 20_000;
export const GREP_MAX_RESULTS = 100;

export interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  case_insensitive?: boolean;
}

export async function execGrep(input: GrepInput, env: ExecEnv): Promise<string> {
  const pattern = requireString(input.pattern, "pattern");
  const searchPath = input.path ? resolve(env.cwd, input.path) : env.cwd;
  const rgCommand = process.env.STANDARD_CODE_RIPGREP_PATH || "rg";
  // content 模式走 --json（vimgrep 行在 Windows 盘符冒号下不可靠解析）；-l/-c 下 rg 不发 JSON match 事件，走纯文本输出。
  const jsonMode = (input.output_mode ?? "content") === "content";
  const args = ["--no-config", ...(jsonMode ? ["--json"] : []), "--max-count", "50"];
  if (input.case_insensitive) args.push("-i");
  if (input.include) args.push("--glob", input.include);
  if (input.output_mode === "files_with_matches") args.push("-l");
  if (input.output_mode === "count") args.push("-c");
  args.push("--", pattern, searchPath);

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: rgCommand,
      args,
      cwd: env.cwd,
      env: env.env,
      timeoutMs: GREP_TIMEOUT_MS,
      signal: env.signal,
      registerProcess: env.registerProcess,
      maxOutputChars: 1_000_000,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new ExecError(
        "ripgrep not found on PATH. Install it (winget install BurntSushi.ripgrep.MSVC / brew install ripgrep / apt install ripgrep) and retry.",
      );
    throw err;
  }
  if (result.timedOut) throw new ExecError(`ripgrep timed out after ${GREP_TIMEOUT_MS}ms`);
  // [CC] EAGAIN 自愈同构：资源暂时不可用自动单线程重试
  if (result.code !== 0 && /EAGAIN/.test(result.stderr)) {
    result = await runProcess({
      command: rgCommand,
      args: [...args, "-j", "1"],
      cwd: env.cwd,
      env: env.env,
      timeoutMs: GREP_TIMEOUT_MS,
      signal: env.signal,
      registerProcess: env.registerProcess,
      maxOutputChars: 1_000_000,
    });
  }
  if (result.code === 0 || result.code === 1) {
    const mode = input.output_mode ?? "content";
    const lines = mode === "content" ? formatMatches(result.stdout, env.cwd) : formatPlainText(result.stdout, env.cwd);
    const trimmed = lines.length > GREP_MAX_RESULTS
      ? [...lines.slice(0, GREP_MAX_RESULTS), `... (${lines.length - GREP_MAX_RESULTS} more matches, refine the pattern)`]
      : lines;
    return trimmed.length > 0 ? trimmed.join("\n") : "no matches found";
  }
  // 2+：真错误——用法错误（正则/glob/文件类型）转专用异常，stderr 截 2000 字符（[CC] RipgrepUsageError 同构）
  const detail = result.stderr.trim().slice(0, 2000) || result.stdout.trim().slice(0, 2000);
  throw new ExecError(`search failed — ripgrep rejected the pattern, glob, or file type without searching:\n${detail}`);
}

/** rg --json 行流 → content 行（相对路径:行号: 行文本）。 */
function formatMatches(stdout: string, cwd: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    let obj: { type: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "match" || !obj.data?.path?.text) continue;
    out.push(`${toRel(obj.data.path.text, cwd)}:${obj.data.line_number ?? 0}: ${(obj.data.lines?.text ?? "").replace(/\n$/, "")}`);
  }
  return out;
}

/** -l/-c 纯文本输出 → 相对路径行（-c 形如 path:count，贪婪正则兼容 Windows 盘符冒号；分隔符统一正斜杠）。 */
function formatPlainText(stdout: string, cwd: string): string[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*):(\d+)$/);
      if (m) return `${toRel(m[1]!, cwd)}:${m[2]}`;
      return toRel(line, cwd);
    });
}

function toRel(absPath: string, cwd: string): string {
  const p = resolve(cwd, absPath);
  return (p.startsWith(cwd + "\\") || p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p).replaceAll("\\", "/");
}
