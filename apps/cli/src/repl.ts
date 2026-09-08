// L0 REPL（§5.1 L0：输入模式分发 · 渲染 · 中断；四模式见 input-modes.ts，五命令见 commands.ts）。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentLoop } from "@standardcode/harness";
import { checkToolInput as guardCheck } from "@standardcode/platform";
import type { Session } from "./session.ts";
import { parseInput } from "./input-modes.ts";
import { CLI_COMMANDS, type CommandContext, type SlashCommand } from "./commands.ts";
import { bashWriteTargets, sessionDiff, type FileHistoryStore } from "@standardcode/platform";
import { renderTurn } from "./render.ts";
import { completeInput, type TabCompletion } from "./tab-complete.ts";

export const SHELL_OUTPUT_TRUNCATE_CHARS = 30_000;

export interface ReplIo {
  lines: AsyncIterable<string>;
  write(s: string): void;
  close(): void;
}

export interface ReplDeps {
  session: Session;
  io: ReplIo;
  commands?: readonly SlashCommand[];
  /** file-history store（WP-09；main.ts 装配；缺席=/rewind 报错、工具写盘不快照）。 */
  fileHistory?: FileHistoryStore;
}

export function createCommandContext(deps: ReplDeps): CommandContext {
  const s = deps.session;
  return {
    catalog: () => s.catalog,
    currentModel: () => s.model,
    switchModel: (name) => {
      if (!s.catalog.includes(name)) throw new Error(`unknown model: ${name}（可用：${s.catalog.join(", ")}）`);
      s.model = name;
    },
    permissionMode: () => s.broker.mode(),
    cyclePermissionMode: () => s.broker.cycle(),
    setPermissionMode: (mode) => {
      s.broker.setMode(mode);
    },
    clearHistory: () => {
      s.messages.length = 0;
    },
    requestExit: () => {
      s.exitRequested = true;
    },
    workingDir: () => s.cwd,
    snapshotCount: () => deps.fileHistory?.maxSeq() ?? 0,
    sessionDiff: async () => {
      if (!deps.fileHistory) return { output: "", changed: 0, scanned: 0, skipped: [] };
      return sessionDiff(deps.fileHistory);
    },
    rewind: async (seq) => {
      if (!deps.fileHistory) throw new Error("file-history unavailable（/rewind 需要 file-history store）");
      return deps.fileHistory.rewindTo(seq);
    },
    write: deps.io.write,
  };
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const commands = new Map((deps.commands ?? CLI_COMMANDS).map((c) => [c.name, c]));
  for await (const raw of deps.io.lines) {
    const line = raw.trim();
    if (line === "") continue;
    const parsed = parseInput(line);
    if (parsed.kind === "prompt") {
      await runPromptTurn(deps, parsed.text);
    } else if (parsed.kind === "shell") {
      runShellLine(deps, parsed.command);
    } else if (parsed.kind === "file") {
      await runFileTurn(deps, parsed.path, parsed.rest);
    } else {
      await runSlash(deps, commands, parsed.name, parsed.args);
    }
    if (deps.session.exitRequested) {
      deps.io.close();
      return;
    }
  }
  deps.io.close();
}

async function runPromptTurn(deps: ReplDeps, text: string): Promise<void> {
  const s = deps.session;
  s.messages.push({ role: "user", content: [{ type: "text", text }] });
  s.activeAbort = new AbortController();
  try {
    const final = await renderTurn(
      runAgentLoop({
        provider: s.provider,
        model: s.model,
        // WP-02：记忆用户轨进 system（§7.1 Memory 段；loader 拼接文本原样传递）
        system: s.memory.text.trim() !== "" ? s.memory.text : undefined,
        // WP-06（CTX-020）：thinking 配置随每 turn 请求（缺省关闭不发）
        thinking: s.thinking,
        // WP-09（EXE-030/040）：写盘前快照（Write/Edit 取 file_path；Bash 重定向启发式，[自定]）
        fileHistory: deps.fileHistory
          ? {
              beforeTool: async (name, input) => {
                const rec = input as { file_path?: unknown; command?: unknown };
                if ((name === "Write" || name === "Edit") && typeof rec.file_path === "string") {
                  await deps.fileHistory!.snapshot(name as "Write" | "Edit", resolve(s.cwd, rec.file_path));
                } else if (name === "Bash" && typeof rec.command === "string") {
                  for (const t of bashWriteTargets(rec.command)) {
                    await deps.fileHistory!.snapshot("Bash", resolve(s.cwd, t));
                  }
                }
              },
            }
          : undefined,
        messages: s.messages,
        tools: s.tools,
        // WP-09：guard-path 护栏（platform 实现；stop 硬停/confirm 升 ask——S-9 Auto 不豁免）
        guard: {
          check: (name, input) => {
            const v = guardCheck(name, input, s.cwd);
            return { action: v.action, ...(v.rule ? { rule: v.rule } : {}), ...(v.detail ? { detail: v.detail } : {}) };
          },
        },
        // WP-08：权限仲裁挂接（评估序与 Plan 硬门在 broker；ask 无确认 UI→fail-closed 拒绝，B-13/SEC-020）
        permission: { check: async (name, input) => s.broker.evaluate(name, input).decision },
        signal: s.activeAbort.signal,
      }),
      deps.io.write,
      s.meter,
    );
    s.messages = final.messages;
  } catch (err) {
    deps.io.write(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    s.activeAbort = null;
  }
}

/** !shell：本地直接执行，不进模型轮次（卡边界）；截断口径与 Bash 工具一致（30K）。 */
function runShellLine(deps: ReplDeps, command: string): void {
  if (command === "") {
    deps.io.write("[shell] usage: !<command>\n");
    return;
  }
  const r = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  let out = (r.stdout ?? "") + (r.stderr ? (r.stdout ? "\n[stderr]\n" : "") + r.stderr : "");
  if (out.length > SHELL_OUTPUT_TRUNCATE_CHARS) out = out.slice(0, SHELL_OUTPUT_TRUNCATE_CHARS) + "\n[output truncated]";
  deps.io.write(out + (out.endsWith("\n") || out === "" ? "" : "\n"));
  if (r.status !== 0) deps.io.write(`[shell] exit code ${r.status}\n`);
}

/** @file：读文件注入用户消息（进模型轮次；卡边界"注入文件引用"）。 */
async function runFileTurn(deps: ReplDeps, path: string, rest: string): Promise<void> {
  if (path === "") {
    deps.io.write("[file] usage: @<path> [prompt]\n");
    return;
  }
  let content: string;
  try {
    content = await readFile(resolve(deps.session.cwd, path), "utf8");
  } catch {
    deps.io.write(`[file] not found: ${path}\n`);
    return;
  }
  await runPromptTurn(deps, `${rest ? `${rest}\n\n` : ""}[attached file: ${path}]\n\n${content}`);
}

async function runSlash(deps: ReplDeps, commands: Map<string, SlashCommand>, name: string, args: string): Promise<void> {
  if (name === "") {
    deps.io.write("[command] usage: /<command> — try /help\n");
    return;
  }
  const cmd = commands.get(name);
  if (!cmd) {
    deps.io.write(`[command] unknown: /${name}（B-03：五命令之外不注册，try /help）\n`);
    return;
  }
  try {
    await cmd.execute(args, createCommandContext(deps));
  } catch (err) {
    deps.io.write(`[command] /${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Tab 补全入口（readline completer 用；UI-001）。 */
export function completerFor(commands: readonly SlashCommand[]): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const c: TabCompletion = completeInput(line, commands);
    return [c.candidates, line];
  };
}
