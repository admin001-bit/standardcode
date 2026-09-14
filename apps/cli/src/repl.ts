// L0 REPL（§5.1 L0：输入模式分发 · 渲染 · 中断；四模式见 input-modes.ts，五命令见 commands.ts）。
// WP-10：会话命令 /new /resume /rename + WP-08 设施真实接入（SessionLock+ResilientTranscriptWriter——
// 该两件 WP-08 复验登记"零生产消费者，真实接入=WP-10"）。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentLoop, spawnSubagentTask } from "@standardcode/harness";
import { checkToolInput as guardCheck, componentCounts, installPlugin, loadPluginsDoc, removePlugin, settingsValue } from "@standardcode/platform";
import { SessionLock, ResilientTranscriptWriter, listSessions, renameSessionTitle, resumeFrom, type SessionIndexEntry } from "@standardcode/platform";
import type { Session } from "./session.ts";
import { resolveThinking } from "./session.ts";
import { parseInput } from "./input-modes.ts";
import { AGENTS_SKELETON, CLI_COMMANDS, deriveSubtaskName, EFFORT_LEVELS, EFFORT_TO_THINKING, effortLabel, parseTasksArgs, priceTableRow, usageCostUsd, type CommandContext, type EffortLevel, type SlashCommand } from "./commands.ts";
import { bashWriteTargets, sessionDiff, persistAlwaysAllow, type FileHistoryStore } from "@standardcode/platform";
import { buildContextGrid, renderContextGrid, cleanupToolResults, contextCollapse, nextReactiveStep } from "@standardcode/context";
import { runCompaction, createCompactionCoordinator, resolveAutocompactConfig, MANUAL_WINDOW_MIN, MANUAL_WINDOW_MAX } from "@standardcode/context";
import { alwaysAllowRuleFor, type ConfirmPrompt } from "./confirm.ts";
import { isTrusted } from "@standardcode/platform";
import { createStandardTools } from "@standardcode/capabilities";
import { join } from "node:path";
import { setLocalSetting } from "./config-store.ts";
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
    deps.io.write(`${deps.session.i18n.t("repl.session.transcriptUnavailable", { value: err instanceof Error ? err.message : String(err) })}\n`);
    return null;
  }
}

/**
 * 会话切换（/new：全新；/resume：恢复历史并接续追加）。
 * 实现=原位改写 deps.session 的可变字段（identity 不换——runRepl 闭包持有同一对象）；旧锁释放、旧 writer 弃用。
 * resume 用既有 transcript 文件（sessionId 复用=接续追加；恢复消息只入内存，无回写路径）。
 */
async function switchSession(deps: ReplDeps, opts?: { sessionId: string; messages?: Session["messages"] }): Promise<void> {
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
      if (!s.catalog.includes(name)) throw new Error(s.i18n.t("cmd.model.err.unknownModel", { value: name, list: s.catalog.join(", ") }));
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
      if (!deps.fileHistory) throw new Error(s.i18n.t("repl.rewind.noStore"));
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
        deps.io.write(`${deps.session.i18n.t("repl.resume.none")}\n`);
        return false;
      }
      if (!deps.sessionPicker) {
        deps.io.write(`${deps.session.i18n.t("repl.resume.noPicker")}\n`);
        for (const e of sessions) deps.io.write(`  ${e.sessionId.slice(0, 8)}  ${e.title || "(no title)"}  (${e.messageCount} msgs, last ${e.lastActivityAt ?? "?"})\n`);
        return false;
      }
      const chosen = await deps.sessionPicker.pick(sessions);
      if (!chosen) {
        deps.io.write(`${deps.session.i18n.t("repl.resume.cancelled")}\n`);
        return false;
      }
      // R2 修复（V 退回 2026-09-09）：选择器内重命名（附录 A 要素三）——picker 侧对历史会话设标题后重新枚举
      await deps.sessionPicker.rename(chosen, deps.session.cwd);
      const r = await resumeFrom(chosen.filePath);
      await switchSession(deps, { sessionId: chosen.sessionId, messages: r.messages });
      deps.io.write(`${deps.session.i18n.t("repl.resume.restored", { id: chosen.sessionId.slice(0, 8), title: chosen.title || "(no title)", n: r.messages.length, tail: r.lastReason ? deps.session.i18n.t("repl.resume.lastReason", { reason: r.lastReason }) : "" })}\n`);
      return true;
    },
    renameSession: async (title) => {
      const session = currentSessionMeta(deps);
      if (!title.trim()) throw new Error(deps.session.i18n.t("cmd.rename.err.required"));
      await renameSessionTitle(deps.session.cwd, session.sessionId, title, deps.baseDir);
    },
    // —— WP-11（§8.2 M2 余量；ENG-043/S-10/ENG-080/MDL-010~013/CTX-036）——
    compact: async (window, partialIdx) => {
      const s = deps.session;
      // 手动窗口（CTX-036"手动窗 100k–1M"）：指定时重建协调器（V R1 修复：显式 config 直建，不经
      // env 字符串二次解析——裸数 k 启发式是 WP-03 解析器语义，命令参数处已按 [100000,1000000] 数值校验）。
      // M2 WP-11 登记级①收口（WP-08 DoD③）：直调面同样 fail-closed——界外值拒绝，不静默回落默认窗。
      if (window !== undefined) {
        if (!Number.isInteger(window) || window < MANUAL_WINDOW_MIN || window > MANUAL_WINDOW_MAX) {
          throw new Error(s.i18n.t("repl.compact.errManual", { min: MANUAL_WINDOW_MIN, max: MANUAL_WINDOW_MAX }));
        }
      s.autocompact = createCompactionCoordinator(
        resolveAutocompactConfig({ env: { STANDARD_CODE_AUTO_COMPACT_WINDOW: String(window) } }),
      );
      }
      // M4-WP04：PreCompact 触发（通知面；verdict 不消费 [自定]）
      await s.hooks.gate("PreCompact", undefined, {}).catch(() => null);
      const r = await runCompaction({
        provider: s.provider,
        model: s.model,
        system: s.memory.text.trim() !== "" ? s.memory.text : undefined,
        messages: s.messages,
        thinking: s.thinking,
        ...(partialIdx !== undefined ? { partial: { selectedIdx: partialIdx } } : {}),
      });
      s.messages = r.newMessages;
      s.autocompact.recordCompactSuccess(r.postTokens, 0); // 手动压缩=独立轮次（工具轮计数不属于 turn 状态，Session 无 toolRounds）
      // ADR-0038：压缩落盘 compact 记录（重建截断语义的历史起点；M2 偏差⑤清偿；keptCount=partial 保留尾部消息数）
      transcriptAppend(deps, { kind: "compact", mode: "manual", preTokens: r.preTokens, postTokens: r.postTokens, summary: r.summary, keptCount: r.newMessages.length - 1 });
      await s.hooks.gate("PostCompact", undefined, {}).catch(() => null); // M4-WP04：PostCompact 触发
      return { summary: r.summary, preTokens: r.preTokens, postTokens: r.postTokens };
    },
    config: async (args) => {
      const s = deps.session;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const lines = [s.i18n.t("repl.config.sourcesHeader", { value: s.settings.effectiveSources.join(", ") })];
        for (const [source, doc] of Object.entries(s.settings.docs)) {
          lines.push(s.i18n.t("repl.config.sourceLine", { source, keys: doc ? Object.keys(doc).filter((k) => k !== "schemaVersion").join(", ") || s.i18n.t("repl.config.sourceEmpty") : s.i18n.t("repl.config.sourceAbsent") }));
        }
        lines.push(s.i18n.t("repl.config.mergedLine", { value: Object.keys(s.settings.merged).sort().join(", ") || s.i18n.t("repl.config.none") }));
        return { text: lines.join("\n") };
      }
      const [key, ...rest] = parts;
      if (rest.length === 0) {
        const v = s.settings.merged[key!];
        return { text: `${key} = ${v === undefined ? s.i18n.t("repl.config.unset") : JSON.stringify(v)}` };
      }
      let value: unknown;
      try {
        value = JSON.parse(rest.join(" "));
      } catch {
        value = rest.join(" ");
      }
      setLocalSetting(s.cwd, key!, value);
      s.reload(); // 编辑即时生效（重载走门控与粘滞注入）
      return { text: s.i18n.t("repl.config.set", { key: key!, value: JSON.stringify(value) }) };
    },
    switchProvider: (name) => {
      const s = deps.session;
      if (!name) return { text: s.i18n.t("repl.provider.switchHint", { name: s.providerName }) };
      const before = s.provider;
      s.switchProvider(name);
      return { text: s.i18n.t("repl.provider.switched", { name: s.providerName, state: before === s.provider ? s.i18n.t("repl.provider.unchanged") : s.i18n.t("repl.provider.rebuilt") }) };
    },
    doctor: async () => {
      const s = deps.session;
      const fixed: string[] = [];
      const lines: string[] = [s.i18n.t("repl.doctor.header")];
      // ① settings 可读性（WP-01 loadSettings 告警=坏 JSON/schemaVersion）
      for (const w of s.settings.warnings) lines.push(s.i18n.t("repl.doctor.settingsWarn", { source: w.source, path: w.path, reason: w.reason }));
      if (s.settings.warnings.length === 0) lines.push(s.i18n.t("repl.doctor.settingsOk"));
      // ② 目录权限+自修复最小集（ENG-043）：缺失才创建并 [fix] 上屏（自修复如实登记）；写删探针文件验可写
      //（V O3 修复=原版硬编码 [ok] 无探针、无条件 mkdir、catch 把失败谎报为 "restored"）
      const stdDir = join(s.cwd, ".standardcode");
      if (!existsSync(stdDir)) {
        try {
          mkdirSync(stdDir, { recursive: true });
          fixed.push("created missing project .standardcode");
          lines.push(s.i18n.t("repl.doctor.dirFix"));
        } catch (err) {
          lines.push(s.i18n.t("repl.doctor.dirWarn", { value: err instanceof Error ? err.message : String(err) }));
        }
      }
      if (existsSync(stdDir)) {
        try {
          const probe = join(stdDir, `.doctor-probe-${process.pid}`);
          writeFileSync(probe, "probe", "utf8");
          rmSync(probe, { force: true });
          lines.push(s.i18n.t("repl.doctor.writableOk"));
        } catch (err) {
          lines.push(s.i18n.t("repl.doctor.writableWarn", { value: err instanceof Error ? err.message : String(err) }));
        }
      }
      // ③ transcript 清理提示（S-10）：枚举转录+体积
      const { sessions } = await listSessions(s.cwd, deps.baseDir);
      let totalBytes = 0;
      for (const sess of sessions) {
        try {
          totalBytes += statSync(sess.filePath).size;
        } catch {
          /* 文件消失 */
        }
      }
      lines.push(s.i18n.t("repl.doctor.transcripts", { n: sessions.length, kib: (totalBytes / 1024).toFixed(1), big: totalBytes > 10 * 1024 * 1024 ? s.i18n.t("repl.doctor.transcriptsBig") : "" }));
      // ④ frontmatter/迁移提示（ENG-080）：settings 文件缺 schemaVersion 计数
      const noSchema = Object.entries(s.settings.docs).filter(([, d]) => d !== null && (d as Record<string, unknown>).schemaVersion === undefined).length;
      if (noSchema > 0) lines.push(s.i18n.t("repl.doctor.schemaWarn", { value: noSchema }));
      if (fixed.length === 0) lines.push(s.i18n.t("repl.doctor.noRepair"));
      return { text: lines.join("\n"), fixed };
    },
    changeDir: (path) => {
      const s = deps.session;
      const d = resolve(s.cwd, path);
      if (!statSync(d).isDirectory()) throw new Error(s.i18n.t("repl.cd.notDir", { value: d }));
      s.cwd = d;
      s.tools = createStandardTools({ cwd: d }); // 工具面随目录重建（transcript 项目归属不迁移=偏差登记）
      return { text: s.i18n.t("repl.cd.working", { value: d }) };
    },
    addDir: async (path) => {
      const s = deps.session;
      const d = resolve(s.cwd, path);
      try {
        s.addAdditionalDirectory(d);
      } catch (err) {
        throw new Error(s.i18n.t("repl.adddir.err", { value: err instanceof Error ? err.message : String(err) }));
      }
      const untrustedRepo = existsSync(join(d, ".git")) && !isTrusted(d);
      const note = untrustedRepo ? s.i18n.t("repl.adddir.trustNote") : "";
      return { text: s.i18n.t("repl.adddir.authorized", { value: d }) + note };
    },
    reload: () => {
      const s = deps.session;
      s.reload();
      return { text: s.i18n.t("repl.reload.done", { files: s.memory.files.length, sources: s.settings.effectiveSources.join(", ") }) };
    },
    // —— WP-07：M3 分期余量三件（§8.2；/subtask 走 spawn——M6 前仅同步语义）——
    subtask: async (prompt) => {
      const s = deps.session;
      // CC /subtask 守卫同构（chunk-g7bantgw.js :328，A 级报告 §3.3）
      if (s.messages.length === 0) throw new Error(s.i18n.t("repl.subtask.guard"));
      const launch = await spawnSubagentTask(
        { prompt, description: deriveSubtaskName(prompt), runInBackground: false },
        { depth: 0, availableTypes: ["general-purpose"] }, // M3 恒 general-purpose（内置集发现链=WP-06）
        { provider: s.provider, model: s.model, tools: [...s.tools], permissionBroker: s.broker },
        {
          registry: s.taskRegistry,
          env: {}, // env 空=autoBackgroundMs 0 → 同步恒同步
          // M4-WP04：SubagentStart/Stop 触发点（回调覆盖后台/翻转/同步三路终态）
          onStart: (info) => {
            s.hooks.fire("SubagentStart", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}) });
          },
          onSettled: (info) => {
            s.hooks.fire("SubagentStop", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}), outcome: info.ok ? "success" : "failure" });
          },
        },
      );
      if (launch.status === "refused") return { text: s.i18n.t("repl.subtask.refused", { value: launch.message }) };
      if (launch.status !== "completed") return { text: s.i18n.t("repl.subtask.unexpected", { value: launch.status }) };
      // 结果注入（DoD①）：报告以 user 消息入会话（下一 turn 模型可见）+落转录保 resume 等价
      const injected = {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: s.i18n.t("repl.subtask.injected", { type: launch.result.agentType, tokens: launch.result.totalTokens, report: launch.result.report }),
          },
        ],
      };
      s.messages.push(injected);
      transcriptAppend(deps, { kind: "user_message", message: injected });
      return {
        text: s.i18n.t("repl.subtask.completed", { type: launch.result.agentType, tokens: launch.result.totalTokens, uses: launch.result.totalToolUseCount }) + "\n" + launch.result.content,
      };
    },
    effort: async (args) => {
      const s = deps.session;
      if (args === "") {
        return {
          text: s.i18n.t("repl.effort.current", { label: effortLabel(s.thinking), levels: EFFORT_LEVELS.join("|") }),
        };
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(args)) {
        throw new Error(s.i18n.t("repl.effort.unknown", { value: args, levels: EFFORT_LEVELS.join("|") }));
      }
      const level = args as EffortLevel;
      setLocalSetting(s.cwd, "model.thinking", EFFORT_TO_THINKING[level]);
      s.reload(); // settings 重载（local 层并入）
      s.thinking = resolveThinking(undefined, s.env, s.settings); // 下一 turn 生效（env 逃逸舱优先序不变）
      return { text: s.i18n.t("repl.effort.set", { value: level, thinking: EFFORT_TO_THINKING[level] }) };
    },
    init: async () => {
      const s = deps.session;
      const p = join(s.cwd, "AGENTS.md");
      if (existsSync(p)) return { text: s.i18n.t("repl.init.exists") };
      writeFileSync(p, AGENTS_SKELETON, "utf8");
      return { text: s.i18n.t("repl.init.created", { value: p }) };
    },
    // —— WP-05：/tasks /background（ORC-032：TaskList 语义=active_only 默认 true、limit 1–100 默认 20）——
    tasks: (args) => {
      const s = deps.session;
      const { activeOnly, limit } = parseTasksArgs(args);
      const all = s.taskRegistry.list(activeOnly ? { activeOnly: true } : undefined);
      const shown = all.slice(0, limit);
      if (shown.length === 0) return { text: s.i18n.t("repl.tasks.none", { which: activeOnly ? s.i18n.t("repl.tasks.noneActive") : s.i18n.t("repl.tasks.noneAll"), total: s.taskRegistry.list().length }) };
      const lines = shown.map((t) => {
        const bg = t.isBackgrounded ? " bg" : "";
        const usage = t.result ? ` ${t.result.totalTokens}tok/${t.result.totalToolUseCount}tools` : "";
        return `  ${t.taskId} [${t.status}]${bg} ${t.agentType} "${t.description}"${usage}`;
      });
      return { text: s.i18n.t("repl.tasks.header", { shown: shown.length, all: all.length, mode: activeOnly ? s.i18n.t("repl.tasks.activeOnly") : "" }) + "\n" + lines.join("\n") };
    },
    background: () => {
      const s = deps.session;
      const bg = s.taskRegistry.list().filter((t) => t.isBackgrounded);
      if (bg.length === 0) return { text: s.i18n.t("repl.background.none") };
      return { text: s.i18n.t("repl.background.header", { value: bg.length }) + "\n" + bg.map((t) => `  ${t.taskId} [${t.status}] ${t.agentType} "${t.description}"`).join("\n") };
    },
    // —— WP-10：/status /usage（§8.2 M3 分期；全字段实时读态——DoD① 判据面）——
    status: () => {
      const s = deps.session;
      const caps = s.provider.capabilities(s.model);
      const grid = buildContextGrid({
        window: caps.contextWindow,
        systemChars: s.memory.text.length,
        toolsChars: s.tools.reduce((acc, t) => acc + t.description.length, 0),
        memoryChars: s.memory.files.reduce((acc, f) => acc + f.raw.length, 0),
        messages: s.messages,
        usage: s.meter.snapshot(),
      });
      // 水位=grid 估算占用（window−freeSpace−autocompactBuffer，/context 同源口径）
      const occupied = Math.max(0, grid.window - grid.freeSpace - grid.autocompactBuffer);
      const all = s.taskRegistry.list();
      const active = s.taskRegistry.list({ activeOnly: true });
      return {
        text: [
          s.i18n.t("repl.status.header"),
          s.i18n.t("repl.status.model", { model: s.model, provider: s.providerName, catalog: s.catalog.join(", ") }),
          s.i18n.t("repl.status.permission", { value: s.broker.mode() }),
          s.i18n.t("repl.status.context", { occupied, window: grid.window, pct: ((occupied / grid.window) * 100).toFixed(1) }),
          s.i18n.t("repl.status.tasks", { active: active.length, total: all.length }),
          s.i18n.t("repl.status.session", { id: currentSessionMeta(deps).sessionId.slice(0, 8), cwd: s.cwd, files: s.memory.files.length, turns: s.meter.turns }),
        ].join("\n"),
      };
    },
    usage: () => {
      const s = deps.session;
      const t = s.meter.snapshot();
      const hit = t.inputTokens > 0 ? `${((t.cacheReadTokens / t.inputTokens) * 100).toFixed(1)}%` : s.i18n.t("repl.usage.noInput");
      const rate = priceTableRow(s.model);
      const price = rate
        ? s.i18n.t("repl.usage.costKnown", { usd: usageCostUsd(t, rate).toFixed(6), input: rate.inputUsdPerMTok, output: rate.outputUsdPerMTok, cw: rate.cacheWriteUsdPerMTok, cr: rate.cacheReadUsdPerMTok })
        : s.i18n.t("repl.usage.costUnknown", { model: s.model });
      return {
        text: [
          s.i18n.t("repl.usage.header"),
          s.i18n.t("repl.usage.totals", { input: t.inputTokens, output: t.outputTokens, cacheCreation: t.cacheCreationTokens, cacheRead: t.cacheReadTokens }),
          s.i18n.t("repl.usage.hitrate", { value: hit }),
          price,
        ].join("\n"),
      };
    },
    // —— WP-03：/mcp（S-3 安装即确认；可视化管控面，§8.2 M4 增）——
    mcpList: () => {
      const views = deps.session.mcpServers();
      const lines = [s.i18n.t("repl.mcp.header", { value: views.length })];
      for (const v of views) {
        const status = v.status ?? "-";
        lines.push(`  ${v.name}  ${v.transport}  ${v.origin}  ${v.state}  ${status}${v.error ? `  ${s.i18n.t("repl.mcp.errorCol", { value: v.error })}` : ""}`);
      }
      if (views.some((v) => v.state === "pending")) {
        lines.push(s.i18n.t("repl.mcp.pendingHint"));
      }
      return { text: lines.join("\n") };
    },
    mcpAction: async (action, name) => {
      await deps.session.mcpRecord(action, name);
      const doneWord = s.i18n.t(`repl.mcp.done.${action}`);
      const v = deps.session.mcpServers().find((x) => x.name.toLowerCase() === name.toLowerCase());
      const suffix = v ? s.i18n.t("repl.mcp.suffix", { state: v.state, status: v.status ? s.i18n.t("repl.mcp.suffixStatus", { value: v.status }) : "" }) : "";
      const hint = action === "enable" && v?.state === "rejected" ? s.i18n.t("repl.mcp.hintRejected") : "";
      return { text: s.i18n.t("repl.mcp.action", { done: doneWord, name, suffix, hint }) };
    },
    // —— WP-05：/skills（S-5+SEC-070；DoD⑦ list 形状+DoD④ run 豁免面）——
    skillsList: () => {
      const s = deps.session;
      const all = s.skills.all();
      const active = s.skills.active();
      const lines = [s.i18n.t("repl.skills.header", { value: all.length })];
      for (const sk of all) {
        const state = active?.name === sk.name ? s.i18n.t("repl.skills.state.active") : sk.disableModelInvocation ? s.i18n.t("repl.skills.state.userOnly") : s.i18n.t("repl.skills.state.model");
        const desc = [sk.description, sk.whenToUse].filter((x) => x !== undefined && x !== "").join(" ");
        lines.push(`  ${sk.name}  ${sk.source}  ${state}${sk.argumentHint ? `  (${sk.argumentHint})` : ""}${desc ? `  ${desc}` : ""}`);
      }
      for (const w of s.skills.warnings()) lines.push(s.i18n.t("repl.skills.warnPrefix", { value: w }));
      if (active) lines.push(s.i18n.t("repl.skills.activeLine", { name: active.name, tools: active.allowedTools ? s.i18n.t("repl.skills.activeTools", { list: active.allowedTools.join(", ") }) : "" }));
      return { text: lines.join("\n") };
    },
    // —— WP-06：/memory（MEM-044 双轨可视化：用户轨来源与顺序+自动轨索引摘要）——
    memoryView: () => {
      const s = deps.session;
      const lines = [s.i18n.t("repl.memory.userHeader")];
      for (const f of s.memory.files) lines.push(`  [${f.scope}] ${f.kind} ${f.path}`);
      if (s.memory.files.length === 0) lines.push(s.i18n.t("repl.memory.userEmpty"));
      lines.push(s.i18n.t("repl.memory.autoHeader", { state: s.autoMemory ? s.i18n.t("repl.memory.autoEnabled") : s.i18n.t("repl.memory.autoDisabled") }));
      if (s.autoMemory) {
        const v = s.autoMemory;
        lines.push(s.i18n.t("repl.memory.indexLine", { detail: v.index.exists ? s.i18n.t("repl.memory.indexDetail", { lines: v.index.lines, bytes: v.index.bytes, truncated: v.index.truncated ? s.i18n.t("repl.memory.indexTruncated") : "" }) : s.i18n.t("repl.memory.indexNone") }));
        lines.push(s.i18n.t("repl.memory.filesLine", { value: v.entryCount }));
        if (v.missing.length > 0) lines.push(s.i18n.t("repl.memory.missingLine", { value: v.missing.join(", ") }));
      }
      return { text: lines.join("\n") };
    },
    skillsRun: (name, args) => {
      const r = deps.session.skills.runByName(name, args);
      if (r.injected !== null) {
        // 用户点名展开注入（isMeta user 追加——CTX-005 载体；下一 turn 模型可见）
        deps.session.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${r.injected}</system-reminder>` }] });
      }
      return { text: r.text };
    },
    // —— M4-WP-09：/plugin（ECO-030~033；DoD③ 安装确认=组件清单展示且非 once 零落地 fail-closed；DoD⑤ list/remove 留痕即时）——
    pluginList: () => {
      const s = deps.session;
      const views = s.plugins.installed();
      const doc = loadPluginsDoc(s.plugins.baseDir());
      const lines = [s.i18n.t("repl.plugin.header", { value: views.length })];
      if (views.length === 0) lines.push(s.i18n.t("repl.plugin.empty"));
      for (const v of views) lines.push(`  ${v.record.name}  ${v.record.version}  ${v.record.source}${v.manifest === null ? `  ${s.i18n.t("repl.plugin.broken")}` : ""}`);
      if (doc.marketplaces.length > 0) {
        lines.push(s.i18n.t("repl.plugin.mktHeader", { value: doc.marketplaces.length }));
        for (const m of doc.marketplaces) lines.push(`  ${m.name}  ${m.source}`);
      }
      for (const w of s.plugins.warnings()) lines.push(s.i18n.t("repl.plugin.warn", { value: w }));
      return { text: lines.join("\n") };
    },
    pluginInstall: async (target) => {
      const s = deps.session;
      const confirm = deps.confirm;
      if (!confirm) throw new Error(s.i18n.t("cmd.plugin.err.noConfirm")); // 无确认 UI=拒绝安装方向（S-5/SEC-020 fail-closed）
      const out = await installPlugin(target, {
        baseDir: s.plugins.baseDir(),
        defaultMarketplace: settingsValue<string>(s.trust.settings, "plugins.defaultMarketplace"),
        opts: {
          onConfirm: async (manifest) => {
            // DoD③：对话框展示将注入组件清单（N commands/N agents/N skills/hooks/MCP 逐名）
            const c = componentCounts(manifest);
            const detail = s.i18n.t("repl.plugin.confirmDetail", {
              name: manifest.name,
              version: manifest.version,
              commands: c.commands.length,
              agents: c.agents,
              skills: c.skills.length,
              hooks: c.hookEvents.length > 0 ? s.i18n.t("repl.plugin.hookCol", { value: c.hookEvents.join(", ") }) : "",
              mcp: c.mcpServers.length > 0 ? s.i18n.t("repl.plugin.mcpCol", { value: c.mcpServers.join(", ") }) : "",
            });
            const choice = await confirm.confirm(`plugin:${manifest.name}`, detail);
            return choice === "once"; // 非 once（always/deny）=零落地 [自定 起步注记裁决：once=安装批准]
          },
        },
      });
      const warnLines = out.warnings.map((w) => s.i18n.t("repl.plugin.warn", { value: w }));
      switch (out.error) {
        case "declined":
          return { text: [s.i18n.t("repl.plugin.denied"), ...warnLines].join("\n") };
        case "exists":
          throw new Error(s.i18n.t("repl.plugin.exists", { value: out.manifest?.name ?? target }));
        case "no-manifest":
          throw new Error(s.i18n.t("repl.plugin.noManifest", { value: target }));
        case "clone-failed":
          throw new Error(s.i18n.t("repl.plugin.cloneFailed", { value: target }));
        case "marketplace-entry-not-found":
          throw new Error(s.i18n.t("repl.plugin.notFound", { value: target }));
      }
      if (out.marketplace) return { text: [s.i18n.t("repl.plugin.marketAdded", { name: out.marketplace.name, source: out.marketplace.source, value: out.marketplace.entries }), ...warnLines].join("\n") };
      return { text: [s.i18n.t("repl.plugin.installed", { name: out.manifest!.name, version: out.manifest!.version, source: target }), s.i18n.t("repl.plugin.effectNote"), ...warnLines].join("\n") };
    },
    pluginRemove: (name) => {
      const s = deps.session;
      const r = removePlugin(name, s.plugins.baseDir());
      if (!r.removed) throw new Error(s.i18n.t("repl.plugin.notFound", { value: name }));
      return { text: [s.i18n.t("repl.plugin.removed", { value: name }), ...r.warnings.map((w) => s.i18n.t("repl.plugin.warn", { value: w }))].join("\n") };
    },
    t: (key, params) => deps.session.i18n.t(key, params),
    write: deps.io.write,
  };
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  // WP-10：会话资产初始化（锁+转录；新会话在此建立——/resume 前的默认会话亦有落盘）
  const s0 = deps.session;
  s0.id = randomUUID();
  const assets = await createSessionAssets(deps, s0.id);
  if (assets) sessionAssets.set(s0, assets);
  // M4-WP04：SessionStart（source=startup [自定] 单值；/resume /clear 变体不区分）
  await s0.hooks.gate("SessionStart", { source: "startup" }, { source: "startup" });
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
      await exitRepl(deps);
      return;
    }
  }
  await exitRepl(deps);
}

/** M4-WP04：出口统一（SessionEnd 触发+资产 drain+锁释放+io.close）。 */
async function exitRepl(deps: ReplDeps): Promise<void> {
  await deps.session.hooks.gate("SessionEnd", { reason: "exit" }, { reason: "exit" }).catch(() => {});
  await drainSessionAssets(deps);
  const old = sessionAssets.get(deps.session);
  if (old) await old.lock.release().catch(() => {});
  deps.io.close();
}

async function runPromptTurn(deps: ReplDeps, text: string): Promise<void> {
  const s = deps.session;
  // M4-WP04：UserPromptSubmit 门（exit2/decision:block → 提示词不进轮次，blockingError 告知用户）
  if (s.hooks) {
    const up = await s.hooks.gate("UserPromptSubmit", undefined, { prompt: text }).catch(() => null);
    if (up?.blockingError) {
      deps.io.write(`${deps.session.i18n.t("repl.hooks.promptBlocked", { value: up.blockingError })}\n`);
      return;
    }
  }
  // WP-02（M4）：MCP 后台终态通知注入（turn 首前插 <system-reminder>，SEC-010 载体同构；isMeta 注入不入转录=transcripts.ts:113 口径）
  for (const note of s.drainMcpNotifications()) {
    s.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${note}</system-reminder>` }] });
    s.hooks.fire("Notification", undefined, { message: note }); // M4-WP04：Notification 事件触发面
  }
  // M4-WP05：skills 清单增量注入（meta user 消息追加，CTX-005 不动既有前缀字节；DoD③⑧）
  const listing = s.skills.listing();
  if (listing !== null) {
    s.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${listing}</system-reminder>` }] });
  }
  // M4-WP06：自动轨注入（索引+互链；内容 hash 变化才重发——增量 [自定]；CTX-005 追加载体）
  const autoMem = s.autoMemoryListing();
  if (autoMem !== null) {
    s.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${autoMem}</system-reminder>` }] });
  }
  const preTurnLength = s.messages.length; // R1/R3 修复：快照取 push 前——本轮新增块（含 prompt user/tool_result user/assistant）统一在 turn 末一次写入，防重复
  s.messages.push({ role: "user", content: [{ type: "text", text }] });
  s.activeAbort = new AbortController();
  let doneReason: string | null = null;
  let appendFrom = preTurnLength; // 已落盘水位（Stop 续轮推进；catch 补写起点——续轮后不重复）
  try {
    let stopBlocks = 0;
    for (;;) {
    let turnCompactBase: number | null = null; // ADR-0038：turn 中压缩水位（perform 置位；每轮独立）
    const iterBase = appendFrom;
    const final = await renderTurn(
      runAgentLoop({
        provider: s.provider,
        model: s.model,
        // WP-02：记忆用户轨进 system（§7.1 Memory 段）+WP-06：自动轨维护纪律段（memory.autoTrack 关=空串不入）
        system: [s.memory.text, s.memoryDiscipline].map((t) => t.trim()).filter((t) => t !== "").join("\n\n") || undefined,
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
            const preCompact = [...s.messages]; // 压缩前快照（ADR-0038 对齐前提：未落盘消息先补写）
            await s.hooks.gate("PreCompact", undefined, {}).catch(() => null); // M4-WP04：PreCompact 触发
            const r = await runCompaction({
              provider: s.provider,
              model: s.model,
              system: s.memory.text.trim() !== "" ? s.memory.text : undefined,
              messages: s.messages,
              thinking: s.thinking,
            });
            // ADR-0038 对齐前提：本 turn 尚未落盘、将被卷入压缩的消息先补写（保证 transcript 与压缩前活体对齐，
            // compact 截断语义才有确定的重建基点——V 首验 R1：缺此步则压缩后增量 slice 错位、重建≠活体）
            for (const m of preCompact.slice(preTurnLength)) {
              transcriptAppend(deps, { kind: m.role === "assistant" ? "assistant_message" : "user_message", message: m });
            }
            s.messages = r.newMessages;
            s.autocompact.recordCompactSuccess(r.postTokens, turn);
            // ADR-0038：自动通道压缩落盘 compact 记录（与手动通道同语义；keptCount=保留的尾部消息数，partial>0）
            turnCompactBase = r.newMessages.length; // 压缩水位：turn 末增量从该位起（覆盖 preTurnLength 前缀稳定假设）
            transcriptAppend(deps, {
              kind: "compact",
              mode: "auto",
              preTokens: r.preTokens,
              postTokens: r.postTokens,
              summary: r.summary,
              keptCount: r.newMessages.length - 1,
            });
            await s.hooks.gate("PostCompact", undefined, {}).catch(() => null); // M4-WP04：PostCompact 触发
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
        tools: s.skills.toolFace(s.tools), // M4-WP05：allowed-tools 白名单收窄（DoD⑤ S-5；激活自下一 turn 生效 [自定]）
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
        // M4-WP04：hooks 引擎适配面（PreToolUse 三裁决序/PostToolUse/PostToolUseFailure/PermissionRequest）
        hooks: s.hooks.toolAdapter(),
        signal: s.activeAbort.signal,
      }),
      deps.io.write,
      s.meter,
      { onDone: (reason) => (doneReason = reason) },
    );
    s.messages = final.messages;
    // WP-10 R1+R3 修复（V 退回+复验发现）：仅追加本轮新增的消息块（含 prompt user/tool_result user/assistant
    // ——R3：tool_result 缺失即悬空 tool_use 协议硬不变量违例；M1 E2E③ 先例形制）。原版全量遍历→第 N 轮重复。
    // ADR-0038（V 首验 R1）：turn 中压缩置 turnCompactBase=压缩后水位——增量基点从水位起（preTurnLength 的
    // 前缀稳定假设被压缩替换破坏，slice 错位会漏写重试回复）；水位前消息已由 perform 补写，无需重复。
    const appendBase = turnCompactBase ?? iterBase;
    if (final.messages.length >= appendBase) {
      for (const m of final.messages.slice(appendBase)) {
        if (m.role === "assistant") transcriptAppend(deps, { kind: "assistant_message", message: m });
        else if (m.role === "user") transcriptAppend(deps, { kind: "user_message", message: m });
      }
    }
    appendFrom = s.messages.length;
    // M4-WP04：Stop hook（正常完成才触发；blocking → stderr 回灌模型续轮；连续阻断上限 8（§5.4 ⑦ :151674）→交还用户）
    if ((doneReason ?? "end") === "end") {
      const so = await s.hooks.gate("Stop", undefined, {}, stopBlocks > 0).catch(() => null);
      if (so?.blockingError) {
        if (stopBlocks < 8) {
          stopBlocks++;
          s.messages.push({ role: "user", content: [{ type: "text", text: s.i18n.t("repl.hooks.stopFeedback", { value: so.blockingError }) }] });
          continue; // 反馈消息在下一轮 iterBase 之后落转录
        }
        deps.io.write(`\n${deps.session.i18n.t("repl.hooks.stopBlocked", { value: stopBlocks })}\n`);
      }
    }
    break;
    }
    transcriptAppend(deps, { kind: "done", reason: (doneReason ?? "end") as never, usage: s.meter.snapshot() });
  } catch (err) {
    // 硬错误路径：未落盘消息补写（appendFrom=已落盘水位——Stop 续轮后不重复）
    for (const m of s.messages.slice(appendFrom)) {
      if (m.role === "user") transcriptAppend(deps, { kind: "user_message", message: m });
      else if (m.role === "assistant") transcriptAppend(deps, { kind: "assistant_message", message: m });
    }
    transcriptAppend(deps, { kind: "done", reason: "error" });
    deps.io.write(`\n${deps.session.i18n.t("repl.error.prefix", { value: err instanceof Error ? err.message : String(err) })}\n`);
  } finally {
    s.activeAbort = null;
  }
}

/** !shell：本地直接执行，不进模型轮次（卡边界）；截断口径与 Bash 工具一致（30K）。 */
function runShellLine(deps: ReplDeps, command: string): void {
  if (command === "") {
    deps.io.write(`${deps.session.i18n.t("repl.shell.usage")}\n`);
    return;
  }
  const r = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  let out = (r.stdout ?? "") + (r.stderr ? (r.stdout ? "\n[stderr]\n" : "") + r.stderr : "");
  if (out.length > SHELL_OUTPUT_TRUNCATE_CHARS) out = out.slice(0, SHELL_OUTPUT_TRUNCATE_CHARS) + "\n" + deps.session.i18n.t("repl.shell.truncated");
  deps.io.write(out + (out.endsWith("\n") || out === "" ? "" : "\n"));
  if (r.status !== 0) deps.io.write(`${deps.session.i18n.t("repl.shell.exitCode", { value: r.status ?? "unknown" })}\n`);
}

/** @file：读文件注入用户消息（进模型轮次；卡边界"注入文件引用"）。 */
async function runFileTurn(deps: ReplDeps, path: string, rest: string): Promise<void> {
  if (path === "") {
    deps.io.write(`${deps.session.i18n.t("repl.file.usage")}\n`);
    return;
  }
  let content: string;
  try {
    content = await readFile(resolve(deps.session.cwd, path), "utf8");
  } catch {
    deps.io.write(`${deps.session.i18n.t("repl.file.notFound", { value: path })}\n`);
    return;
  }
  await runPromptTurn(deps, `${rest ? `${rest}\n\n` : ""}[attached file: ${path}]\n\n${content}`);
}

async function runSlash(deps: ReplDeps, commands: Map<string, SlashCommand>, name: string, args: string): Promise<void> {
  if (name === "") {
    deps.io.write(`${deps.session.i18n.t("repl.command.usage")}\n`);
    return;
  }
  const cmd = commands.get(name);
  if (!cmd) {
    deps.io.write(`${deps.session.i18n.t("repl.command.unknown", { value: name })}
`);
    return;
  }
  try {
    await cmd.execute(args, createCommandContext(deps));
  } catch (err) {
    deps.io.write(`${deps.session.i18n.t("repl.command.failed", { name, value: err instanceof Error ? err.message : String(err) })}\n`);
  }
}

/** Tab 补全入口（readline completer 用；UI-001）。 */
export function completerFor(commands: readonly SlashCommand[]): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const c: TabCompletion = completeInput(line, commands);
    return [c.candidates, line];
  };
}
