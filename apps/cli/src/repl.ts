// L0 REPL（§5.1 L0：输入模式分发 · 渲染 · 中断；四模式见 input-modes.ts，五命令见 commands.ts）。
// WP-10：会话命令 /new /resume /rename + WP-08 设施真实接入（SessionLock+ResilientTranscriptWriter——
// 该两件 WP-08 复验登记"零生产消费者，真实接入=WP-10"）。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentLoop } from "@standardcode/harness";
import { checkToolInput as guardCheck } from "@standardcode/platform";
import { SessionLock, ResilientTranscriptWriter, listSessions, renameSessionTitle, resumeFrom, type SessionIndexEntry } from "@standardcode/platform";
import type { Session } from "./session.ts";
import { parseInput } from "./input-modes.ts";
import { CLI_COMMANDS, type CommandContext, type SlashCommand } from "./commands.ts";
import { bashWriteTargets, sessionDiff, persistAlwaysAllow, type FileHistoryStore } from "@standardcode/platform";
import { buildContextGrid, renderContextGrid, cleanupToolResults, contextCollapse, nextReactiveStep } from "@standardcode/context";
import { runCompaction } from "@standardcode/context";
import { alwaysAllowRuleFor, type ConfirmPrompt } from "./confirm.ts";
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
  /** 确认 UI（WP-07；main.ts TTY 装配/测试注入；缺席=ask 保持 fail-closed 拒绝，SEC-020）。 */
  confirm?: ConfirmPrompt;
  /** ~/.standardcode 基目录覆写（测试隔离；缺省真实家目录）。 */
  baseDir?: string;
  /** /resume 选择器（WP-10；测试注入桩/非交互=不可用报错）。 */
  sessionPicker?: SessionPicker;
}

/**
 * UI-030 会话选择器（附录 A 三要素：搜索+预览+重命名）。
 * pick=搜索+预览并返回选中项（null=取消）；rename=对指定会话设标题（选择器内重命名，/rename 只管当前会话）。
 */
export interface SessionPicker {
  pick(entries: SessionIndexEntry[]): Promise<SessionIndexEntry | null>;
  rename(entry: SessionIndexEntry, projectRoot: string): Promise<void>;
}

/** 会话资产（WP-08 设施真实接入：锁+脱敏转录 writer；/new /resume 时随会话切换）。 */
interface SessionAssets {
  sessionId: string;
  lock: SessionLock;
  writer: ResilientTranscriptWriter;
  /** 转录 append 串行链（appendFile 并发完成序≠调用序——链式保物理行序；出口/切换前 drain）。 */
  chain: Promise<unknown>;
}

/** 会话资产存放（模块级 WeakMap 按deps.session 实例跟踪；switchSession 原位换 deps.session 内容）。 */
const sessionAssets = new WeakMap<object, SessionAssets>();

function currentSessionMeta(deps: ReplDeps): { sessionId: string } {
  const assets = sessionAssets.get(deps.session);
  return { sessionId: assets?.sessionId ?? deps.session.id };
}

/** 开新会话资产（锁+writer）；失败不阻断（转录降级为无落盘会话，告警一次）。 */
async function createSessionAssets(deps: ReplDeps, sessionId: string): Promise<SessionAssets | null> {
  try {
    const baseDirArgs = deps.baseDir ? [deps.baseDir] : [];
    const lock = await SessionLock.acquire(deps.session.cwd, sessionId, ...baseDirArgs);
    const writer = await ResilientTranscriptWriter.create(deps.session.cwd, sessionId, ...baseDirArgs);
    return { sessionId, lock, writer, chain: Promise.resolve() };
  } catch (err) {
    deps.io.write(`[session] transcript unavailable (${err instanceof Error ? err.message : String(err)}) — session continues without persistence\n`);
    return null;
  }
}

/**
 * 会话切换（/new：全新；/resume：恢复历史并接续追加）。
 * 实现=原位改写 deps.session 的可变字段（identity 不换——runRepl 闭包持有同一对象）；旧锁释放、旧 writer 弃用。
 * resume 用既有 transcript 文件（sessionId 复用=接续追加；skipResumeWrite=恢复消息不重写回转录）。
 */
async function switchSession(deps: ReplDeps, opts?: { sessionId: string; messages?: Session["messages"]; skipResumeWrite?: boolean }): Promise<void> {
  const s = deps.session;
  const old = sessionAssets.get(s);
  if (old) await old.chain.catch(() => {}); // 旧会话尾部先落盘（drain 串行链）
  if (old) await old.lock.release().catch(() => {});
  s.messages = opts?.messages ? [...opts.messages] : [];
  s.exitRequested = false;
  s.meter = new (Object.getPrototypeOf(s.meter).constructor)();
  const sessionId = opts?.sessionId ?? randomUUID();
  const assets = await createSessionAssets(deps, sessionId);
  if (assets) sessionAssets.set(s, assets);
}

/** 转录追加（fire-and-forget；写入失败已由 Resilient 层降级，不阻断会话）。 */
function transcriptAppend(deps: ReplDeps, rec: Parameters<ResilientTranscriptWriter["append"]>[0]): void {
  const assets = sessionAssets.get(deps.session);
  if (!assets) return;
  assets.chain = assets.chain.then(() => assets.writer.append(rec)).catch(() => {}); // 串行链：物理行序=调用序
}

/** 等待会话在途转录写入（出口/切换前调用——转录读取与写入竞速防护）。 */
async function drainSessionAssets(deps: ReplDeps): Promise<void> {
  const assets = sessionAssets.get(deps.session);
  if (assets) await assets.chain;
}

export function createCommandContext(deps: ReplDeps): CommandContext {
  const s = deps.session;
  return {    catalog: () => s.catalog,
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
    contextGrid: () => {
      const caps = s.provider.capabilities(s.model);
      const grid = buildContextGrid({
        window: caps.contextWindow,
        systemChars: s.memory.text.length,
        toolsChars: s.tools.reduce((acc, t) => acc + t.description.length, 0),
        memoryChars: s.memory.files.reduce((acc, f) => acc + f.raw.length, 0),
        messages: s.messages,
        usage: s.meter.snapshot(),
      });
      return { text: renderContextGrid(grid) };
    },
    rewind: async (seq) => {
      if (!deps.fileHistory) throw new Error("file-history unavailable（/rewind 需要 file-history store）");
      return deps.fileHistory.rewindTo(seq);
    },
    // —— WP-10 会话命令（CTX-101 交接终点/UI-030）——
    newSession: () => {
      // 旧 transcript 完好（append-only 不动）；锁随旧会话释放；新 sessionId 新 writer 新锁
      return switchSession(deps);
    },
    resumeSession: async () => {
      const { sessions } = await listSessions(deps.session.cwd, deps.baseDir);
      if (sessions.length === 0) {
        deps.io.write("[resume] no sessions recorded for this project\n");
        return false;
      }
      if (!deps.sessionPicker) {
        deps.io.write("[resume] interactive picker unavailable（非交互环境；索引如下）\n");
        for (const e of sessions) deps.io.write(`  ${e.sessionId.slice(0, 8)}  ${e.title || "(no title)"}  (${e.messageCount} msgs, last ${e.lastActivityAt ?? "?"})\n`);
        return false;
      }
      const chosen = await deps.sessionPicker.pick(sessions);
      if (!chosen) {
        deps.io.write("[resume] cancelled\n");
        return false;
      }
      // R2 修复（V 退回 2026-09-09）：选择器内重命名（附录 A 要素三）——picker 侧对历史会话设标题后重新枚举
      await deps.sessionPicker.rename(chosen, deps.session.cwd);
      const r = await resumeFrom(chosen.filePath);
      await switchSession(deps, { sessionId: chosen.sessionId, messages: r.messages, skipResumeWrite: true });
      deps.io.write(`[resume] ${chosen.sessionId.slice(0, 8)} — ${chosen.title || "(no title)"}：${r.messages.length} message(s) restored${r.lastReason ? `（上次终态 ${r.lastReason}）` : ""}\n`);
      return true;
    },
    renameSession: async (title) => {
      const session = currentSessionMeta(deps);
      if (!title.trim()) throw new Error("/rename <title>: title required");
      await renameSessionTitle(deps.session.cwd, session.sessionId, title, deps.baseDir);
    },
    write: deps.io.write,
  };
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  // WP-10：会话资产初始化（锁+转录；新会话在此建立——/resume 前的默认会话亦有落盘）
  const s0 = deps.session;
  s0.id = randomUUID();
  const assets = await createSessionAssets(deps, s0.id);
  if (assets) sessionAssets.set(s0, assets);
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
      await drainSessionAssets(deps);
      const old = sessionAssets.get(deps.session);
      if (old) await old.lock.release().catch(() => {});
      deps.io.close();
      return;
    }
  }
  await drainSessionAssets(deps);
  const old = sessionAssets.get(deps.session);
  if (old) await old.lock.release().catch(() => {});
  deps.io.close();
}

async function runPromptTurn(deps: ReplDeps, text: string): Promise<void> {
  const s = deps.session;
  const preTurnLength = s.messages.length; // R1/R3 修复：快照取 push 前——本轮新增块（含 prompt user/tool_result user/assistant）统一在 turn 末一次写入，防重复
  s.messages.push({ role: "user", content: [{ type: "text", text }] });
  s.activeAbort = new AbortController();
  let doneReason: string | null = null;
  try {
    const final = await renderTurn(
      runAgentLoop({
        provider: s.provider,
        model: s.model,
        // WP-02：记忆用户轨进 system（§7.1 Memory 段；loader 拼接文本原样传递）
        system: s.memory.text.trim() !== "" ? s.memory.text : undefined,
        // WP-06（CTX-020）：thinking 配置随每 turn 请求（缺省关闭不发）
        thinking: s.thinking,
        // WP-05（CTX-037）：reactive 瀑布接线（R1 修复——原版零生产接线为 V 退回）。
        // 前两级就地收缩历史；auto-compact 级 apply 返回 null（exhausted）→ 落下方 autocompact 路由（WP-04 perform）。
        reactive: {
          modelWindow: s.provider.capabilities(s.model).contextWindow,
          decide: (current) => nextReactiveStep(current),
          apply: (step, messages) => {
            if (step === "tool-result-cleanup") {
              const r = cleanupToolResults(messages);
              return r.cleaned > 0 ? r.messages : null;
            }
            if (step === "context-collapse") {
              const r = contextCollapse(messages);
              return r.dropped > 0 ? r.messages : null;
            }
            return null; // auto-compact：交还协调器路由
          },
        },
        // WP-04：AutoCompact 执行体接线（协调器=WP-03 装配；CTX-101 交接终点）
        autocompact: {
          evaluate: (used, turn) => s.autocompact.evaluate(used, turn),
          perform: async (turn) => {
            const r = await runCompaction({
              provider: s.provider,
              model: s.model,
              system: s.memory.text.trim() !== "" ? s.memory.text : undefined,
              messages: s.messages,
              thinking: s.thinking,
            });
            s.messages = r.newMessages;
            s.autocompact.recordCompactSuccess(r.postTokens, turn);
            return { ok: true, postCompactTokens: r.postTokens, messages: r.newMessages };
          },
        },
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
        // WP-08：权限仲裁挂接（评估序与 Plan 硬门在 broker；ask → 确认 UI 最小流——解除 M1 拒绝降级）
        permission: {
          check: async (name, input) => {
            const v = s.broker.evaluate(name, input);
            if (v.decision !== "ask" || !deps.confirm) return v.decision;
            const rule = alwaysAllowRuleFor(name, input);
            const choice = await deps.confirm.confirm(name, v.reason);
            if (choice === "once") return "allow";
            if (choice === "always") {
              try {
                s.broker.addAllow(rule); // 运行时即时生效（构造期清洗，违规抛错→按拒绝处理）
              } catch {
                return "deny";
              }
              persistAlwaysAllow(s.cwd, rule); // ADR-0037：跨会话落项目 local 层（§8.3"只落 local 层"原文路径）
              return "allow";
            }
            return "deny";
          },
        },
        signal: s.activeAbort.signal,
      }),
      deps.io.write,
      s.meter,
      { onDone: (reason) => (doneReason = reason) },
    );
    s.messages = final.messages;
    // WP-10 R1+R3 修复（V 退回+复验发现）：仅追加本轮新增的消息块（含 prompt user/tool_result user/assistant
    // ——R3：tool_result 缺失即悬空 tool_use 协议硬不变量违例；M1 E2E③ 先例形制）。原版全量遍历→第 N 轮重复。
    // 压缩发生（长度回缩）时本轮无新增可记。
    if (final.messages.length >= preTurnLength) {
      for (const m of final.messages.slice(preTurnLength)) {
        if (m.role === "assistant") transcriptAppend(deps, { kind: "assistant_message", message: m });
        else if (m.role === "user") transcriptAppend(deps, { kind: "user_message", message: m });
      }
    }
    transcriptAppend(deps, { kind: "done", reason: (doneReason ?? "end") as never, usage: s.meter.snapshot() });
  } catch (err) {
    // 硬错误路径：turn 前的 user 消息此轮未入转录——补写（重建等价：尾随 user 无 assistant，V 首验认可形制）
    for (const m of s.messages.slice(preTurnLength)) {
      if (m.role === "user") transcriptAppend(deps, { kind: "user_message", message: m });
      else if (m.role === "assistant") transcriptAppend(deps, { kind: "assistant_message", message: m });
    }
    transcriptAppend(deps, { kind: "done", reason: "error" });
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
