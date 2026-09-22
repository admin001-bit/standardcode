// L0 REPL（§5.1 L0：输入模式分发 · 渲染 · 中断；四模式见 input-modes.ts，五命令见 commands.ts）。
// WP-10：会话命令 /new /resume /rename + WP-08 设施真实接入（SessionLock+ResilientTranscriptWriter——
// 该两件 WP-08 复验登记"零生产消费者，真实接入=WP-10"）。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentLoop, spawnSubagentTask } from "@standardcode/harness";
import { checkToolInput as guardCheck, componentCounts, installPlugin, loadPluginsDoc, removePlugin, settingsValue, TELEMETRY_SETTINGS_KEY } from "@standardcode/platform";
import { SessionLock, ResilientTranscriptWriter, listSessions, renameSessionTitle, resumeFrom, type SessionIndexEntry } from "@standardcode/platform";
import { checkRegistryLatest, compareVersions, runNpmUpdate, AUTO_UPDATE_ENV_KEY, type UpdateCheckResult, type NpmRunResult, type NpmRunner } from "@standardcode/platform";
import { CLI_VERSION } from "./version.ts";
import type { Session } from "./session.ts";
import { resolveThinking } from "./session.ts";
import { parseInput } from "./input-modes.ts";
import { AGENTS_SKELETON, CLI_COMMANDS, deriveSubtaskName, EFFORT_LEVELS, EFFORT_SEMANTICS, EFFORT_TO_THINKING, effortLabel, parseTasksArgs, priceTableRow, splitSubtaskType, usageCostUsd, type CommandContext, type EffortLevel, type SlashCommand } from "./commands.ts";
import { bashWriteTargets, sessionDiff, persistAlwaysAllow, type FileHistoryStore } from "@standardcode/platform";
import { buildContextGrid, renderContextGrid, cleanupToolResults, contextCollapse, nextReactiveStep } from "@standardcode/context";
import { runCompaction, createCompactionCoordinator, resolveAutocompactConfig, MANUAL_WINDOW_MIN, MANUAL_WINDOW_MAX } from "@standardcode/context";
import { alwaysAllowRuleFor, type ConfirmPrompt } from "./confirm.ts";
import { isTrusted } from "@standardcode/platform";
import { createStandardTools } from "@standardcode/capabilities";
import { workflowBoard } from "./workflow-board.ts";
import { DEFAULT_FORK_INSTRUCTION, deriveForkDescription, renderForkContextPrompt } from "./fork-command.ts";
import { exportTargetPath, renderSessionMarkdown } from "./export-command.ts";
import { join } from "node:path";
import { setLocalSetting } from "./config-store.ts";
import { renderTurn } from "./render.ts";
import { resolveTheme, setTheme, THEMES, themeFromSettings, type Theme } from "./theme.ts";
import { completeInput, type TabCompletion } from "./tab-complete.ts";

export const SHELL_OUTPUT_TRUNCATE_CHARS = 30_000;

export interface ReplIo {
  lines: AsyncIterable<string>;
  write(s: string): void;
  close(): void;
  /** WP-08 DoD③：异步通知的行重绘通道（清当前行+写通知+重绘提示符保留已输入缓冲）；
   * 缺席=回落 write（尾窗形态 [自定] 处置=有 readline 宿主时优先重绘，M4 WP-08 未解决②清偿）。 */
  redrawNotice?(line: string): void;
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
  /** WP-08 /update 注入面（离线测试桩；缺席=真 registry+npm 子进程，缺省零网络请求依赖 env 门）。 */
  update?: UpdateDeps;
}

/**
 * WP-08：/update 依赖注入面（全可选；测试注入离线桩）。check/runNpm 缺席=转 platform 缺省实现，
 * fetchImpl/timeoutMs/runner/env 透传至 platform 层（网络注入面离线测试，卡交付物口径）。
 */
export interface UpdateDeps {
  /** 覆写 registry 查询（返回 UpdateCheckResult；缺席=checkRegistryLatest）。 */
  check?: () => Promise<UpdateCheckResult>;
  /** 覆写 npm 执行（缺席=runNpmUpdate）。 */
  runNpm?: () => Promise<NpmRunResult>;
  /** 当前版本比对基准（缺席=CLI_VERSION）。 */
  currentVersion?: string;
  /** 透传 platform：registry fetch。 */
  fetchImpl?: typeof fetch;
  /** 透传 platform：registry 超时。 */
  timeoutMs?: number;
  /** 透传 platform：npm 子进程 runner。 */
  runner?: NpmRunner;
  /** 透传 platform：npm 子进程 env 源（SEC-080 基线剥离入参）。 */
  env?: NodeJS.ProcessEnv;
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
  // M7-WP-01：会话目标状态（/goal）——ctx 生命周期=会话生命周期；/new 经 newSession 清除；仅会话内存态不落盘 [自定]
  // （历史可见性由注入的 user turn 落转录承载，resume 后目标文本在消息历史中仍可见）
  let sessionGoal: string | undefined;
  return {    // WP-01：现行注册表（门控后；/help 同源）
    commands: () => deps.commands ?? CLI_COMMANDS,
    catalog: () => s.catalog,
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
      sessionGoal = undefined; // M7-WP-01：新会话不带旧目标（目标=会话内存态 [自定]）
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
      // 工具面随目录重建（transcript 项目归属不迁移=偏差登记）；M5-WP-03：沙箱在位时同步换
      // 可写根（workspace-write 根=会话 cwd），保 -sdb 会话 /cd 后仍经沙箱。
      if (s.sandbox) {
        s.sandbox.setRoot(d);
        s.tools = createStandardTools({ cwd: d, sandbox: s.sandbox });
      } else {
        s.tools = createStandardTools({ cwd: d });
      }
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
    // M4-WP-10（DoD②）：类型首词解析（首词∈注册表名=类型，余=任务 prompt；无匹配=现状 general-purpose）；
    // availableTypes/definitionsOf/requiredMCP/agent hooks 全经 session.agents.prepareSpawn 生产接线。
    subtask: async (input) => {
      const s = deps.session;
      // CC /subtask 守卫同构（chunk-g7bantgw.js :328，A 级报告 §3.3）
      if (s.messages.length === 0) throw new Error(s.i18n.t("repl.subtask.guard"));
      const { type, prompt } = splitSubtaskType(input, s.agents.names());
      const spawn = s.agents.prepareSpawn(type);
      const launch = await spawnSubagentTask(
        { prompt, ...(type !== undefined ? { subagentType: type } : {}), description: deriveSubtaskName(prompt), runInBackground: false },
        spawn.ctx,
        { provider: s.provider, model: s.model, tools: [...s.tools], permissionBroker: s.broker, ...(spawn.hooks !== undefined ? { hooks: spawn.hooks } : {}) },
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
      if (launch.status === "refused") {
        // M5-WP-06：subagent_launch refused 分支（outcome 枚举 [自定]；产生点=/subtask 唯一生产 spawn 面）。
        s.telemetry.subagentLaunch({ outcome: "refused", refusedCode: launch.code, ...(type !== undefined ? { agentType: type } : {}) });
        return { text: s.i18n.t("repl.subtask.refused", { value: launch.message }) };
      }
      // M5-WP-06：subagent_launch launched 分支（refused 外三态 async_launched/backgrounded/completed 均已注册+取槽）。
      s.telemetry.subagentLaunch({ outcome: "launched", taskId: launch.taskId, agentId: launch.agentId, ...(type !== undefined ? { agentType: type } : {}) });
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
    // —— M7-WP-02 细化：档位枚举与持久化键位不变（off|low|medium|high→model.thinking），细化三面——
    // ①档位语义表（每档 thinking 值+语义说明，当前档标 *）②model×effort 组合面（切换模型后档位保持=local 层持久）
    // ③生效面如实报告（env 逃逸舱 STANDARD_CODE_THINKING 优先于 settings，resolveThinking 序不变=MDL-010~013）—
    effort: async (args) => {
      const s = deps.session;
      const levelsBlock = (current: string): string =>
        s.i18n.t("repl.effort.levels", {
          levels: EFFORT_LEVELS.map((lv) => `  ${lv === current ? "*" : " "} ${lv}  ${EFFORT_SEMANTICS[lv].thinking}  ${s.i18n.t(EFFORT_SEMANTICS[lv].descKey)}`).join("\n"),
        });
      const combo = (current: string): string => s.i18n.t("repl.effort.combo", { model: s.model, level: current });
      // env 逃逸舱覆盖：local 档位写了但被 env 抢占 → 点名告知实际生效值（防静默误导）
      const envOverride = (): string => {
        const raw = s.env.STANDARD_CODE_THINKING;
        if (raw === undefined || raw === "") return "";
        // {level}=真实 local 档位（**只看 settings**，env 传空对象）；effective=env 优先后的实际解析值。
        // 修复 V-1：查看支的 current 是 env 派生档，若填进 {level} 会输出「local level high … effective=high」自相矛盾。
        const local = effortLabel(resolveThinking(undefined, {}, s.settings));
        return "\n" + s.i18n.t("repl.effort.envOverride", { value: raw, level: local, effective: effortLabel(resolveThinking(undefined, s.env, s.settings)) });
      };
      if (args === "") {
        const label = effortLabel(s.thinking);
        return {
          text:
            s.i18n.t("repl.effort.current", { label, levels: EFFORT_LEVELS.join("|") }) +
            "\n" +
            levelsBlock(label) +
            "\n" +
            combo(label) +
            envOverride(),
        };
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(args)) {
        throw new Error(s.i18n.t("repl.effort.unknown", { value: args, levels: EFFORT_LEVELS.join("|") }));
      }
      const level = args as EffortLevel;
      setLocalSetting(s.cwd, "model.thinking", EFFORT_TO_THINKING[level]);
      s.reload(); // settings 重载（local 层并入）
      s.thinking = resolveThinking(undefined, s.env, s.settings); // 下一 turn 生效（env 逃逸舱优先序不变）
      return {
        text:
          s.i18n.t("repl.effort.set", { value: level, thinking: EFFORT_TO_THINKING[level] }) +
          "\n" +
          levelsBlock(level) +
          "\n" +
          combo(level) +
          envOverride(),
      };
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
    // —— M4-WP-08：/update（DoD①：registry 查询→同版=显示当前/新版=提示并执行 npm 全局安装；
    // 两路失败=ADR-0034 三件套+手动兜底文案；env 清洗=SEC-080 共享面见 platform/runNpmUpdate）——
    updateNow: async () => {
      const s = deps.session;
      const u = deps.update ?? {};
      const current = u.currentVersion ?? CLI_VERSION;
      const check = u.check ? await u.check() : await checkRegistryLatest({ fetchImpl: u.fetchImpl, timeoutMs: u.timeoutMs });
      if (!check.ok) throw new Error(s.i18n.t("cmd.update.queryFailed", { value: check.reason }));
      if (compareVersions(check.latest, current) <= 0) return { text: s.i18n.t("cmd.update.latest", { version: current, latest: check.latest }) };
      deps.io.write(`${s.i18n.t("cmd.update.found", { latest: check.latest, version: current })}\n`); // "提示并执行"：提示先上屏，再 await 安装子进程
      const run = u.runNpm ? await u.runNpm() : await runNpmUpdate({ runner: u.runner, env: u.env });
      if (run.status !== 0) {
        // Windows 文件锁 EBUSY/EPERM 形态=stderr 尾进入 {value}（三件套含手动兜底——卡 DoD①）。
        throw new Error(s.i18n.t("cmd.update.installFailed", { value: run.error ?? `exit=${run.status}${run.stderrTail ? `; stderr: ${run.stderrTail}` : ""}` }));
      }
      return { text: s.i18n.t("cmd.update.installed", { latest: check.latest }) };
    },
    // —— M6-WP-10：/fork（fork 型 subagent；[CC] _353.js fork 语义束同构——父上下文携带＋后台异步；
    // spawn 走 spawnSubagentTask 同一入口=ORC-022 校验序列复用（DoD①），不碰 harness 既有校验面）——
    fork: async (args) => {
      const s = deps.session;
      // [CC] subagent_fork_prompt_missing 同构：空会话=无父上下文可 fork（点名报错，与 /subtask 守卫同形）；
      // [CC] 的 ended_by_model/coordinator_mode 两拒绝态本仓无对应面（无该状态机）——[CC]-only 不移植，非静默吞。
      if (s.messages.length === 0) throw new Error(s.i18n.t("repl.fork.emptySession"));
      const { type, prompt } = splitSubtaskType(args, s.agents.names()); // 类型缺省 general-purpose（首词可指定，/subtask 同族 [自定]）
      const instruction = prompt !== "" ? prompt : DEFAULT_FORK_INSTRUCTION; // 空指令=缺省指令 [自定]
      const spawn = s.agents.prepareSpawn(type);
      const launch = await spawnSubagentTask(
        {
          prompt: renderForkContextPrompt(s.messages, instruction), // DoD①：fork 携带父转录（复合形 [自定]）
          ...(type !== undefined ? { subagentType: type } : {}),
          description: deriveForkDescription(instruction), // [CC] Te slug 同构（空回落 "fork"）
          runInBackground: true, // fork=后台异步（[CC] isAsync:!0）→ async_launched
        },
        spawn.ctx,
        { provider: s.provider, model: s.model, tools: [...s.tools], permissionBroker: s.broker, ...(spawn.hooks !== undefined ? { hooks: spawn.hooks } : {}) },
        {
          registry: s.taskRegistry,
          env: {}, // 同 /subtask：翻转面无涉（后台显式 true 恒走后台分支）
          onStart: (info) => {
            s.hooks.fire("SubagentStart", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}) });
          },
          onSettled: (info) => {
            s.hooks.fire("SubagentStop", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}), outcome: info.ok ? "success" : "failure" });
          },
        },
      );
      if (launch.status === "refused") {
        s.telemetry.subagentLaunch({ outcome: "refused", refusedCode: launch.code, ...(type !== undefined ? { agentType: type } : {}) });
        return { text: s.i18n.t("repl.fork.refused", { value: launch.message }) };
      }
      s.telemetry.subagentLaunch({ outcome: "launched", taskId: launch.taskId, agentId: launch.agentId, ...(type !== undefined ? { agentType: type } : {}) });
      if (launch.status !== "async_launched") return { text: s.i18n.t("repl.fork.unexpected", { value: launch.status }) };
      // 回显 taskId/agentId：agentId 为内部 ID 不向用户暴露（WP-07 spawnAddressingNote 同族口径 [自定]）；
      // 完成通知经既有任务事件面（/tasks /background）——不做结果注入（与 /subtask 同步语义的差异，如实登记）。
      return {
        text: s.i18n.t("repl.fork.dispatched", { taskId: launch.taskId, type: type ?? "general-purpose", agentId: launch.agentId }),
      };
    },
    // —— M6-WP-10：/export（导出当前会话转录为 Markdown；目标已存在=拒绝点名 fail-closed，不静默覆盖）——
    exportSession: async (args) => {
      const s = deps.session;
      if (args.trim() !== "") throw new Error(s.i18n.t("repl.export.takesNoArgs"));
      const assets = sessionAssets.get(s);
      if (!assets) throw new Error(s.i18n.t("repl.session.transcriptUnavailable", { value: "no transcript writer for this session" })); // 复用既有 i18n 同族 key（不新增条目）
      if (s.messages.length === 0) throw new Error(s.i18n.t("repl.export.emptySession"));
      const target = exportTargetPath(s.cwd, assets.sessionId);
      if (existsSync(target)) throw new Error(s.i18n.t("repl.export.exists", { value: target }));
      const md = renderSessionMarkdown({ sessionId: assets.sessionId, exportedAt: new Date().toISOString(), messages: s.messages });
      await writeFile(target, md, { encoding: "utf8", flag: "wx" }); // wx=存在即失败（TOCTOU 双保险，B-12 fail-closed）
      return { text: s.i18n.t("repl.export.wrote", { n: s.messages.length, target }) };
    },
    // —— M7-WP-01：/goal（Kimi goal mode 语义束收敛 [自定]；锚=KimiCode的产品细节.md 行 334-364——
    // status 显示收敛为纯目标文本（Kimi 的已用时间/轮次/token 数=自动续跑面，本卡边界不做）；
    // 子命令词判定先剥 `-- ` 转义（Kimi 行 352 同构）；带参子命令=拒绝点名 fail-closed（Kimi 未定义行为，取严 [自定]）；
    // 设定/清除/refine 结果均 user turn 注入（subtask.injected 先例形）=下一轮 prompt 模型可见（DoD③）；
    // refine 走 spawnSubagentTask 同一入口（ORC-022 校验序列复用，fork/subtask 同族），首轮守卫=subtask 同构 [自定]）——
    goal: async (args) => {
      const s = deps.session;
      const raw = args.trim();
      const escaped = raw === "--" || raw.startsWith("-- "); // Kimi 行 352 `--` 转义同构：转义形整段为目标文本，跳过子命令判定
      const objective = escaped ? raw.slice(raw === "--" ? 2 : 3).trim() : raw;
      if (escaped) {
        if (objective === "") {
          return { text: sessionGoal === undefined ? s.i18n.t("repl.goal.none") : s.i18n.t("repl.goal.status", { value: sessionGoal }) };
        }
        sessionGoal = objective;
        const injectedEsc = { role: "user" as const, content: [{ type: "text" as const, text: s.i18n.t("repl.goal.injected", { value: sessionGoal }) }] };
        s.messages.push(injectedEsc);
        transcriptAppend(deps, { kind: "user_message", message: injectedEsc });
        return { text: s.i18n.t("repl.goal.set", { value: sessionGoal }) };
      }
      const words = objective === "" ? [] : objective.split(/\s+/);
      const first = words.length > 0 ? words[0]!.toLowerCase() : "";
      const extraArgs = words.length > 1;
      if (first === "status" || objective === "") {
        if (first === "status" && extraArgs) throw new Error(s.i18n.t("repl.goal.err.subcommandArgs", { sub: "status", hint: "--" }));
        return { text: sessionGoal === undefined ? s.i18n.t("repl.goal.none") : s.i18n.t("repl.goal.status", { value: sessionGoal }) };
      }
      if (first === "clear") {
        if (extraArgs) throw new Error(s.i18n.t("repl.goal.err.subcommandArgs", { sub: "clear", hint: "--" }));
        if (sessionGoal === undefined) return { text: s.i18n.t("repl.goal.none") };
        sessionGoal = undefined;
        const cleared = { role: "user" as const, content: [{ type: "text" as const, text: s.i18n.t("repl.goal.clearedInjected") }] };
        s.messages.push(cleared);
        transcriptAppend(deps, { kind: "user_message", message: cleared });
        return { text: s.i18n.t("repl.goal.cleared") };
      }
      if (first === "refine") {
        if (extraArgs) throw new Error(s.i18n.t("repl.goal.err.subcommandArgs", { sub: "refine", hint: "--" }));
        if (sessionGoal === undefined) throw new Error(s.i18n.t("repl.goal.err.noGoal"));
        if (s.messages.length === 0) throw new Error(s.i18n.t("repl.subtask.guard")); // spawn 面首轮守卫（subtask 同构 [自定]）
        const spawn = s.agents.prepareSpawn(undefined);
        const launch = await spawnSubagentTask(
          { prompt: s.i18n.t("repl.goal.refinePrompt", { value: sessionGoal }), description: "goal-refine", runInBackground: false },
          spawn.ctx,
          { provider: s.provider, model: s.model, tools: [...s.tools], permissionBroker: s.broker, ...(spawn.hooks !== undefined ? { hooks: spawn.hooks } : {}) },
          {
            registry: s.taskRegistry,
            env: {}, // env 空=同步恒同步（subtask 同形）
            onStart: (info) => {
              s.hooks.fire("SubagentStart", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}) });
            },
            onSettled: (info) => {
              s.hooks.fire("SubagentStop", { agentType: info.agentType }, { agent_type: info.agentType, ...(info.agentId ? { agent_id: info.agentId } : {}), outcome: info.ok ? "success" : "failure" });
            },
          },
        );
        if (launch.status === "refused") {
          s.telemetry.subagentLaunch({ outcome: "refused", refusedCode: launch.code });
          return { text: s.i18n.t("repl.goal.refused", { value: launch.message }) };
        }
        s.telemetry.subagentLaunch({ outcome: "launched", taskId: launch.taskId, agentId: launch.agentId });
        if (launch.status !== "completed") return { text: s.i18n.t("repl.goal.unexpected", { value: launch.status }) };
        const refined = launch.result.content.trim();
        // harness 对空输出回落占位文案（packages/harness/src/subagent.ts:447）——refine 判空须含此形，
        // 防占位文案污染目标 [自定]；harness 文案若变更，wp01 测试即红=同步提示（判别力）。
        const EMPTY_SUBAGENT_OUTPUT = "(Subagent completed but returned no output.)";
        if (refined === "" || refined === EMPTY_SUBAGENT_OUTPUT) throw new Error(s.i18n.t("repl.goal.err.emptyRefine"));
        sessionGoal = refined;
        const injected = { role: "user" as const, content: [{ type: "text" as const, text: s.i18n.t("repl.goal.injected", { value: refined }) }] };
        s.messages.push(injected);
        transcriptAppend(deps, { kind: "user_message", message: injected });
        return { text: s.i18n.t("repl.goal.refined", { value: refined }) };
      }
      // 设定（raw 以 `-- ` 开头=目标以子命令词开头的转义形；无 -- 时首词恰为子命令词已在上分支按子命令处理）
      sessionGoal = objective;
      const injected = { role: "user" as const, content: [{ type: "text" as const, text: s.i18n.t("repl.goal.injected", { value: sessionGoal }) }] };
      s.messages.push(injected);
      transcriptAppend(deps, { kind: "user_message", message: injected });
      return { text: s.i18n.t("repl.goal.set", { value: sessionGoal }) };
    },
    // —— M7-WP-03：/theme（终端渲染主题单源+持久化；§8.2 M7 增 /theme——
    // 无参=展示当前主题+可选主题；带参=切换并写 ui.theme 到 local 层（setLocalSetting→settings.local.json）；
    // 非法值=fail-closed 抛错（不静默回落缺省）；重启恢复=下一 turn 由 settings 装配经 themeFromSettings 解析当前主题）——
    theme: async (args) => {
      const s = deps.session;
      const raw = args.trim();
      if (raw === "") {
        const cur = themeFromSettings(s.settings);
        const opts = THEMES.map((t) => (t === cur ? `* ${t}` : `  ${t}`)).join("\n");
        return { text: `${s.i18n.t("repl.theme.current", { value: cur })}\n${opts}` };
      }
      let next: Theme;
      try {
        next = resolveTheme(raw); // 非法/未知 = fail-closed 抛错（不静默回落）
      } catch {
        // 经 i18n 本地化报错（repl.theme.err.unknown 键对应；EN/ZH 模板均含 "plain, light, dark"）
        throw new Error(s.i18n.t("repl.theme.err.unknown", { value: raw }));
      }
      setLocalSetting(s.cwd, "ui.theme", next);
      s.reload(); // 重载 settings（local 层并入）；下一 turn 渲染读取新主题
      setTheme(next); // 本会话即时生效（模块单源）
      return { text: s.i18n.t("repl.theme.switched", { value: next }) };
    },
    t: (key, params) => deps.session.i18n.t(key, params),
    write: deps.io.write,
  };
}

/**
 * M4-WP-08 DoD②③④：STANDARD_CODE_AUTO_UPDATE=1 启动后台非阻塞检查（附录 C 行 616；调用点不 await=
 * 不挂冷启动门禁，计时器面=AbortSignal.timeout 内部 unref）。env≠"1"=零请求（DoD④ 缺省关；其余值=关，
 * 取严方向 [自定]）；新版=仅一行提示不自动装（卡边界"不静默安装"）；任何失败=静默不影响会话（DoD③）。
 * 返回 settled promise 供测试确定性等待（生产调用点丢弃返回值）。
 */
export function startAutoUpdateCheck(deps: ReplDeps, env: NodeJS.ProcessEnv = deps.update?.env ?? process.env): Promise<void> {
  if (env[AUTO_UPDATE_ENV_KEY] !== "1") return Promise.resolve();
  const s = deps.session;
  const u = deps.update ?? {};
  const current = u.currentVersion ?? CLI_VERSION;
  return (u.check ? u.check() : checkRegistryLatest({ fetchImpl: u.fetchImpl, timeoutMs: u.timeoutMs }))
    .then((r) => {
      if (r.ok && compareVersions(r.latest, current) > 0) {
        const line = `${s.i18n.t("repl.update.available", { latest: r.latest, version: current })}\n`;
        // WP-08 DoD③（M4 未解决②清偿）：readline 提示符在场时经行重绘通道（清行+写通知+prompt(true)
        // 重绘并保留已输入缓冲）——直写 stdout 的并发尾窗乱码形制就此处置；无宿主（测试/非 TTY）=回落 write。
        if (deps.io.redrawNotice) deps.io.redrawNotice(line);
        else deps.io.write(line);
      }
    })
    .catch(() => {}); // DoD③ 静默（含注入桩抛错形态）
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  // WP-10：会话资产初始化（锁+转录；新会话在此建立——/resume 前的默认会话亦有落盘）
  const s0 = deps.session;
  s0.id = randomUUID();
  const assets = await createSessionAssets(deps, s0.id);
  if (assets) sessionAssets.set(s0, assets);
  // M4-WP04：SessionStart（source=startup [自定] 单值；/resume /clear 变体不区分）
  await s0.hooks.gate("SessionStart", { source: "startup" }, { source: "startup" });
  // M4-WP-10（ADR-0043 决策 1）：项目级 agent 首轮补装——isTrusted→load→gate(二次确认 UI)→registry project 层；
  // 未信任=整层不加载（SEC-070）；无确认通道=gate fail-closed 剥离提权字段（M3-WP-09 既有契约）；异常=降级不阻塞。
  const confirmPrompt = deps.confirm;
  await s0.agents.loadProjectAgents(
    confirmPrompt
      ? {
          confirm: async (name, fields) => {
            const choice = await confirmPrompt.confirm(`agent:${name}`, s0.i18n.t("repl.agents.confirmDetail", { value: fields.join(", ") }));
            return choice !== "deny"; // once/always 皆批准（留痕经 gate onConfirmed→recordAgentTrust 落 local 层）
          },
        }
      : {},
  );
  // M4-WP-08（ENG-041/附录 C）：STANDARD_CODE_AUTO_UPDATE 启动后台检查——fire-and-forget 不 await=
  // 不挂冷启动门禁（DoD②）；env 未设=零请求（DoD④）；失败静默（DoD③）。
  void startAutoUpdateCheck(deps);
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

/**
 * M7-WP-13⑫：会话待投递通知 drain（三段 isomorphic，原 `runPromptTurn` 内联段抽公共）。
 * 唯一 drain 宿主原为 `runPromptTurn`（仅 REPL 可达），非 REPL 入口（headless/evals）无 drain——
 * 本函数导出后两类调用方复用同一实现（单源；非 REPL 的接入点属产品语义决策，见 .work/wp13-x-a.md §B⑦/⑫）。
 * 顺序与语义逐字同内联版：MCP（<system-reminder>）→ workflow（<task-notification>）→ teammate→main；
 * 每条作 user turn 回灌主循环并触发 Notification 钩子（M4-WP04 触发面）。
 */
export function drainSessionNotes(s: Session): void {
  // WP-02（M4）：MCP 后台终态通知注入（turn 首前插 <system-reminder>，SEC-010 载体同构；isMeta 注入不入转录=transcripts.ts:113 口径）
  for (const note of s.drainMcpNotifications()) {
    s.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${note}</system-reminder>` }] });
    s.hooks.fire("Notification", undefined, { message: note }); // M4-WP04：Notification 事件触发面
  }
  // M6-WP-05（DoD③）：workflow 完成通知注入（isomorphic 到上方 MCP drain 路径）。workflow 完成时 runner 经
  // workflowBoard.queue.push 投递 <task-notification>，此处作为 user turn 回灌主循环、并触发 Notification 钩子。
  // 与 /tasks + 后台 subagent 任务族（packages/harness task-*）互不干扰——独立缓冲、独立 drain 循环。
  for (const note of workflowBoard.drainNotifications()) {
    s.messages.push({ role: "user", content: [{ type: "text", text: note }] });
    s.hooks.fire("Notification", undefined, { message: note });
  }
  // M6-WP-07（DoD④）：teammate→main 投递回灌（"main" 恒路由主对话的落点；isomorphic 到上方 workflow 通知段）。
  // teammate 经 SendMessage to:"main" 的消息由 roster port 渲染进会话缓冲，此处作为 user turn 回灌主循环、
  // 并触发 Notification 钩子；teams flag 不活跃=drainTeammateMessages 恒空（bootstrap 占位零开销）。
  for (const note of s.drainTeammateMessages()) {
    s.messages.push({ role: "user", content: [{ type: "text", text: note }] });
    s.hooks.fire("Notification", undefined, { message: note });
  }
}

async function runPromptTurn(deps: ReplDeps, text: string): Promise<void> {
  const s = deps.session;
  // M5-WP-06：遥测 turn 界门刷新（SEC-050 一键关：env STANDARD_CODE_TELEMETRY 每 turn 重读=翻回即时生效；
  // settings telemetry.enabled 随 session.settings/装配与 /reload 解析=次会话或 reload 生效口径 [自定]）。
  s.telemetry.refreshGate({ env: process.env, settingsEnabled: settingsValue<boolean>(s.settings, TELEMETRY_SETTINGS_KEY) });
  const turnStartedAt = performance.now(); // turn_end duration_ms 墙钟（WP-06）
  // M4-WP04：UserPromptSubmit 门（exit2/decision:block → 提示词不进轮次，blockingError 告知用户）
  if (s.hooks) {
    const up = await s.hooks.gate("UserPromptSubmit", undefined, { prompt: text }).catch(() => null);
    if (up?.blockingError) {
      deps.io.write(`${deps.session.i18n.t("repl.hooks.promptBlocked", { value: up.blockingError })}\n`);
      return;
    }
  }
  // WP-13⑫：三段 isomorphic drain 抽为公共函数（`drainSessionNotes`）——REPL 与非 REPL（headless/evals）调用方复用。
  // 语义零变化：MCP 后台终态通知（<system-reminder>，SEC-010 载体同构；isMeta 注入不入转录=transcripts.ts:113 口径）
  // → workflow 完成通知（<task-notification>，M6-WP-05 DoD③）→ teammate→main 投递（M6-WP-07 DoD④），逐一作为
  // user turn 回灌主循环并触发 Notification 钩子。
  drainSessionNotes(s);
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
          perform: (turn) => performAutoCompactWithTelemetry(s, turn, async () => {
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
          }),
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
      {
        onDone: (reason) => (doneReason = reason),
        // M5-WP-06：遥测观察面（产生点=事件流观察，不经 harness 依赖倒灌）——
        // tool_use_cancelled：中断落在工具执行相（interrupted phase:"tool"，§8.4 中断合成 error tool_result 同源）；
        // max_tokens_reached：恢复链③续写触发（recovery max_tokens_continue）。
        onEvent: (ev) => {
          if (ev.type === "interrupted" && ev.phase === "tool") s.telemetry.toolUseCancelled();
          else if (ev.type === "recovery" && ev.chain === "max_tokens_continue") s.telemetry.maxTokensReached({ round: ev.round });
        },
      },
      themeFromSettings(s.settings), // 每 turn 由 settings 重装配当前主题（重启恢复；plain 缺省）
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
    // M5-WP-06：turn_end（ENG-090 terminal_reason/turn_count/duration_ms；turn_count=门面内会话序数 [自定]）。
    s.telemetry.turnEnd({ terminalReason: doneReason ?? "end", durationMs: Math.round(performance.now() - turnStartedAt) });
  } catch (err) {
    // 硬错误路径：未落盘消息补写（appendFrom=已落盘水位——Stop 续轮后不重复）
    for (const m of s.messages.slice(appendFrom)) {
      if (m.role === "user") transcriptAppend(deps, { kind: "user_message", message: m });
      else if (m.role === "assistant") transcriptAppend(deps, { kind: "assistant_message", message: m });
    }
    transcriptAppend(deps, { kind: "done", reason: "error" });
    // M5-WP-06：query_error + turn_end(terminal_reason="error")（错误消息经门面 SEC-030 单源脱敏后入事件体）。
    s.telemetry.queryError({ message: err instanceof Error ? err.message : String(err) });
    s.telemetry.turnEnd({ terminalReason: "error", durationMs: Math.round(performance.now() - turnStartedAt) });
    deps.io.write(`\n${deps.session.i18n.t("repl.error.prefix", { value: err instanceof Error ? err.message : String(err) })}\n`);
  } finally {
    s.activeAbort = null;
  }
}

/** M5-WP-06：autocompact.perform 包装——压缩失败经 recordCompactFailure 登记（CTX-035 闸②熔断器生产接线；
 * 原树 recordCompactFailure 零生产调用方=熔断器死态，本卡为 auto_compact_circuit_breaker 事件产生点的最小接线
 * [偏差登记供 V]：失败后原样重抛=turn 失败传播路径零变，唯一增量=协调器状态推进（连续失败 ≥3→闸② blocked=
 * CTX-035 设计语义）；trip 迁移即发 auto_compact_circuit_breaker 事件）。 */
async function performAutoCompactWithTelemetry(
  s: Session,
  turn: number,
  perform: () => Promise<{ ok: boolean; postCompactTokens: number; messages?: Session["messages"] }>,
): Promise<{ ok: boolean; postCompactTokens: number; messages?: Session["messages"] }> {
  try {
    return await perform();
  } catch (err) {
    const wasTripped = s.autocompact.state.tripped;
    s.autocompact.recordCompactFailure(turn);
    if (!wasTripped && s.autocompact.state.tripped) s.telemetry.autoCompactCircuitBreaker({ turn });
    throw err;
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
