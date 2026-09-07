// L0 REPL（§5.1 L0：输入模式分发 · 渲染 · 中断；四模式见 input-modes.ts，五命令见 commands.ts）。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentLoop } from "@standardcode/harness";
import { PERMISSION_CYCLE, type Session } from "./session.ts";
import { parseInput } from "./input-modes.ts";
import { M1_COMMANDS, type CommandContext, type SlashCommand } from "./commands.ts";
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
    permissionMode: () => s.permissionMode,
    cyclePermissionMode: () => {
      const next = PERMISSION_CYCLE[(PERMISSION_CYCLE.indexOf(s.permissionMode) + 1) % PERMISSION_CYCLE.length]!;
      s.permissionMode = next;
      return next;
    },
    setPermissionMode: (mode) => {
      s.permissionMode = mode;
    },
    clearHistory: () => {
      s.messages.length = 0;
    },
    requestExit: () => {
      s.exitRequested = true;
    },
    write: deps.io.write,
  };
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const commands = new Map((deps.commands ?? M1_COMMANDS).map((c) => [c.name, c]));
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
      runAgentLoop({ provider: s.provider, model: s.model, messages: s.messages, tools: s.tools, signal: s.activeAbort.signal }),
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
