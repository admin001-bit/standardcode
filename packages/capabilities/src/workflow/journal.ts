// M6-WP-04：workflow journal 续跑与运行目录。
//
// 规格：v2.8 ORC-023/024（行 295「journal 续跑」）+ ADR-014（行 557）+ §12.5 接缝⑰（vm 沙箱 × resume 缓存：
// 禁 `Date.now/Math.random` 是 journal key 稳定与缓存命中的**前提**，非独立洁癖）。
// 逐字参考 A 级 `claude-code-workflow.md` §7.1（三型记录 L168318-168345）、§7.2（resume 命中与回放 L168290-168316、
// 遥测 `tengu_workflow_journal_started_hit_respawn`）、§7.3（手动恢复配方 `_243.js` L11-12 + 清理容错 ENOENT/ENOTEMPTY）、
// §7.4（运行目录 `workflows/<runId>/`）、§2.1（脚本持久化 L170994）。
//
// 边界（卡）：不实现 workflow 完成通知 / progress 事件流 / `/workflows`（WP-05）；不改动既有 transcript schema；
// 跨会话 SendMessage 载体属 WP-07（不碰）。
//
// 形态决策（[自定]①，登记供 V）：**以「包装 hooks」方式实现，不改 kernel.ts**（卡上明示「若能用包装 hooks 的方式不改
// kernel 达到同等效果，更好」）。journaled agent 只包住 `agent()`，parallel/pipeline/phase/log 原样透传——脚本内
// `parallel(thunks)` 的 thunk 仍经 sandbox 桥接回 `hooks.agent`（=本包装件），故并发路径同样被 journal 覆盖。
//
// 路径编码单源纪律：runsDir 由调用方（apps/cli 装配层）经 platform `workflowsDir(projectRoot)` 注入，本模块**不复制**
// 路径编码；run 目录组合直接复用 `script-store.ts` 的 `workflowRunDir()`/`sanitizeWorkflowRunId()`。

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { sanitizeWorkflowRunId, workflowRunDir } from "./script-store.ts";
import type { WorkflowAgentOptions, WorkflowHooks } from "./sandbox.ts";

/** journal 文件名（A 级 §7.3：`journal.jsonl` 位于 transcriptDir/run 目录下）。 */
export const WORKFLOW_JOURNAL_FILENAME = "journal.jsonl";

/** 清理容错错误码（A 级 §7.3 逐字：ENOENT / ENOTEMPTY）。 */
export const WORKFLOW_CLEANUP_TOLERATED_CODES = ["ENOENT", "ENOTEMPTY"] as const;

/** resume 命中遥测事件名（A 级 §7.2 L168314 逐字）。 */
export const WORKFLOW_JOURNAL_HIT_EVENT = "tengu_workflow_journal_started_hit_respawn";

/** key 摘要长度（[自定]②：sha256 前 16 hex，等价 [CC] 的短规范标识；哈希函数 [CC] 未逐字定位，报告 §12 未解⑤）。 */
export const WORKFLOW_AGENT_KEY_LENGTH = 16;

/** 结果预览长度上限（A 级 §7.2 `resultPreview: Qj(Te.result)`；`Qj` 实现未定位→[自定] 取 200 字符）。 */
export const WORKFLOW_RESULT_PREVIEW_MAX = 200;

// ───────────────────────── fs 注入面（测试判别力：ENOTEMPTY 在 Windows 上无稳定触发路径） ─────────────────────────

export interface WorkflowJournalFs {
  appendFile(filePath: string, data: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  mkdir(dirPath: string): Promise<void>;
  rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

const defaultFs: WorkflowJournalFs = {
  appendFile: (filePath, data) => appendFile(filePath, data, "utf8"),
  readFile: (filePath) => readFile(filePath, "utf8"),
  mkdir: async (dirPath) => {
    await mkdir(dirPath, { recursive: true });
  },
  rm: (target, options) => rm(target, options),
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isToleratedCode(code: string | undefined): boolean {
  return code !== undefined && (WORKFLOW_CLEANUP_TOLERATED_CODES as readonly string[]).includes(code);
}

// ───────────────────────── 三型记录（DoD①：字段同构 {type, key, agentId, ...result}） ─────────────────────────

export type WorkflowJournalRecordType = "started" | "failed" | "result";

export interface WorkflowJournalStartedRecord {
  type: "started";
  key: string;
  agentId: string;
}

export interface WorkflowJournalFailedRecord {
  type: "failed";
  key: string;
  agentId: string;
}

/**
 * 成功结果记录。[自定]③：`[CC]` 为 `{type, key, agentId, ...result}`（A 级 §7.1 L168345 展开形），展开形在结果
 * 为非对象（字符串/null/数组）时不可表达，故以 `result` 单字段承载；三型骨架 `{type,key,agentId}` 同构不变（DoD①）。
 */
export interface WorkflowJournalResultRecord {
  type: "result";
  key: string;
  agentId: string;
  result: unknown;
}

export type WorkflowJournalRecord =
  | WorkflowJournalStartedRecord
  | WorkflowJournalFailedRecord
  | WorkflowJournalResultRecord;

export function isWorkflowJournalRecord(value: unknown): value is WorkflowJournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (rec.type !== "started" && rec.type !== "failed" && rec.type !== "result") return false;
  return typeof rec.key === "string" && typeof rec.agentId === "string";
}

// ───────────────────────── journal 状态（resume 判定面） ─────────────────────────

export interface WorkflowJournalStartedInfo {
  agentId: string;
  /** 同一 key 的 started 记录条数（[CC] 遥测字段 `attempts: je.length`，A 级 §7.2 L168314）。 */
  attempts: number;
}

export interface WorkflowJournalState {
  /** key → 最近一次 started 信息（含历史尝试数）。 */
  started: Map<string, WorkflowJournalStartedInfo>;
  /** 出现过 failed 记录的 key（结果为 null 或派发抛错）。 */
  failed: Set<string>;
  /** key → 成功结果（仅 type=result 记录）。 */
  results: Map<string, unknown>;
}

export function emptyWorkflowJournalState(): WorkflowJournalState {
  return { started: new Map(), failed: new Set(), results: new Map() };
}

/**
 * 解析 jsonl 文本为 resume 状态。[自定]④：坏行/未知 type **跳过而非抛错**——末行可能是中断时的半截写；
 * 抛错会让 resume 退化为崩溃（DoD⑥ 要求正常重跑）。
 */
export function parseWorkflowJournal(text: string): WorkflowJournalState {
  const state = emptyWorkflowJournalState();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isWorkflowJournalRecord(parsed)) continue;
    if (parsed.type === "started") {
      const prev = state.started.get(parsed.key);
      state.started.set(parsed.key, { agentId: parsed.agentId, attempts: (prev?.attempts ?? 0) + 1 });
    } else if (parsed.type === "failed") {
      state.failed.add(parsed.key);
    } else {
      state.results.set(parsed.key, parsed.result);
    }
  }
  return state;
}

/**
 * 读 journal 文件。[自定]⑤：**任何**读取失败（缺文件/权限/路径是目录/非法编码）一律返回 `null`＝「无 journal，正常重跑」，
 * 不抛（DoD⑥）。代价=权限类错误被降级为重跑（无数据损失，仅重复消耗），登记供 V。
 */
export async function readWorkflowJournal(
  filePath: string,
  fs: WorkflowJournalFs = defaultFs,
): Promise<WorkflowJournalState | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath);
  } catch {
    return null;
  }
  return parseWorkflowJournal(text);
}

/** 回放判定（DoD②）：已 started **且** 有 result **且** 无 failed 记录。 */
export function isReplayableWorkflowKey(state: WorkflowJournalState | null, key: string): boolean {
  if (!state) return false;
  return state.started.has(key) && state.results.has(key) && !state.failed.has(key);
}

// ───────────────────────── 写入器（三型记录） ─────────────────────────

export interface WorkflowJournalWriter {
  readonly filePath: string;
  /** 追加一条记录（内部串行化，保证 jsonl 行不交错）。 */
  append(record: WorkflowJournalRecord): Promise<void>;
  /** 等待已排队写入落盘。 */
  flush(): Promise<void>;
}

export function createWorkflowJournalWriter(options: {
  filePath: string;
  fs?: WorkflowJournalFs;
}): WorkflowJournalWriter {
  const fs = options.fs ?? defaultFs;
  const filePath = options.filePath;
  let chain: Promise<void> = Promise.resolve();
  let dirReady: Promise<void> | null = null;

  const ensureDir = (): Promise<void> => {
    dirReady ??= fs.mkdir(path.dirname(filePath));
    return dirReady;
  };

  return {
    filePath,
    append(record) {
      const task = async (): Promise<void> => {
        await ensureDir();
        await fs.appendFile(filePath, JSON.stringify(record) + "\n");
      };
      const next = chain.then(task, task);
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    flush() {
      return chain;
    },
  };
}

// ───────────────────────── agent key（resume 命中面） ─────────────────────────

export type WorkflowAgentKeyDerivation = (prompt: string, opts?: WorkflowAgentOptions) => string;

let unstableKeyCounter = 0;

/** 规范序列化（键排序 + 丢弃 undefined/函数；跨界对象经 Object.keys 读取，vm realm 对象同样可读）。 */
function normalizeForKey(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return value;
  if (kind === "bigint") return `${value as bigint}n`;
  if (kind === "undefined" || kind === "function" || kind === "symbol") return undefined;
  if (kind !== "object") return String(value);
  const obj = value as object;
  if (seen.has(obj)) throw new Error("workflow agent key: cyclic value");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return Array.from(obj as unknown[], (item) => normalizeForKey(item, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
      const normalized = normalizeForKey((obj as Record<string, unknown>)[k], seen);
      if (normalized !== undefined) out[k] = normalized;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * 缺省 key 派生（[CC] `Pe` = (prompt, opts) 的规范标识；哈希函数未逐字定位，报告 §12 未解⑤）：
 * `wfkey-` + sha256(规范 JSON([prompt, opts])) 前 16 hex。**同输入必同 key**＝resume 可命中。
 * 规范化失败（脚本传入环状 opts）→ 回落进程内唯一 key（**永不命中**，也不崩溃）。
 */
export function defaultWorkflowAgentKey(prompt: string, opts?: WorkflowAgentOptions): string {
  try {
    const canonical = JSON.stringify(normalizeForKey([prompt, opts ?? null], new Set<object>()));
    return "wfkey-" + createHash("sha256").update(canonical).digest("hex").slice(0, WORKFLOW_AGENT_KEY_LENGTH);
  } catch {
    unstableKeyCounter++;
    return `wfkey-unstable-${unstableKeyCounter}`;
  }
}

/**
 * journal agentId（[自定]⑥）：`wfagent-<runId>-<key 摘要>-<attempt>`——由 key+尝试序号派生的**确定性** id
 * （不依赖 M3 内部递增计数器，故 resume 前后稳定）。重放不需要该 id（直接取 started 记录里的原值）。
 */
export function workflowJournalAgentId(key: string, attempt: number, runId?: string): string {
  const scope = runId ? `${sanitizeWorkflowRunId(runId)}-` : "";
  const digest = key.startsWith("wfkey-") ? key.slice("wfkey-".length) : key;
  return `wfagent-${scope}${digest.slice(0, 12)}-${attempt}`;
}

// ───────────────────────── 结果预览 ─────────────────────────

export function previewWorkflowResult(result: unknown, max = WORKFLOW_RESULT_PREVIEW_MAX): string {
  let text: string;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result) ?? String(result);
  } catch {
    text = String(result);
  }
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ───────────────────────── resume 回放标记（DoD② `cached:true`） ─────────────────────────

export interface WorkflowReplayMark {
  key: string;
  agentId: string;
  cached: true;
  attempts: number;
  result: unknown;
  resultPreview: string;
}

// ───────────────────────── 包装 hooks（不改 kernel 的接缝形态） ─────────────────────────

export interface WorkflowJournalRunOptions {
  /** 写入器（缺位=不记录，仍可回放；用于测试与只读 resume 面）。 */
  journal?: WorkflowJournalWriter | null;
  /** 已加载的 resume 状态（null/缺位=无 journal，全量重跑）。 */
  resume?: WorkflowJournalState | null;
  /** runId（进 agentId，便于日志/转录目录对齐）。 */
  runId?: string;
  /** key 派生（缺省 defaultWorkflowAgentKey；注入以做接缝⑰ 变异）。 */
  keyDerivation?: WorkflowAgentKeyDerivation;
  /** 遥测回调（cap/budget 由 kernel 发；本层发 resume 命中事件）。 */
  onTelemetry?: (event: string, payload: Record<string, unknown>) => void;
  /** 命中回放回调（DoD② 可观察面）。 */
  onReplay?: (mark: WorkflowReplayMark) => void;
  /** journal 写失败回调（缺位=静默；A 级 §7.1 每个 append 均 `.catch(...)`，写失败不阻断 workflow）。 */
  onJournalError?: (error: unknown, record: WorkflowJournalRecord) => void;
}

export interface WorkflowJournaledHooks {
  hooks: WorkflowHooks;
  /** 本次运行中被回放的 key（cached:true）。 */
  replays: WorkflowReplayMark[];
  flush(): Promise<void>;
}

/**
 * 把 journal 续跑包在任意 `WorkflowHooks`（WP-03 内核）外：agent() 命中→回放缓存结果并标 `cached:true`（不派生）；
 * 未命中→写 `started` → 调内层 → 写 `result`（非 null）/ `failed`（null 或抛错）。
 */
export function withWorkflowJournal(
  orchestration: WorkflowHooks,
  options: WorkflowJournalRunOptions = {},
): WorkflowJournaledHooks {
  const journal = options.journal ?? null;
  const resume = options.resume ?? null;
  const deriveKey = options.keyDerivation ?? defaultWorkflowAgentKey;
  const attempts = new Map<string, number>();
  const replays: WorkflowReplayMark[] = [];

  // [自定]⑦：journal 写失败不阻断 workflow（同 [CC] 的 `.catch(...)` 语义）；仅回调给宿主。
  const safeAppend = async (record: WorkflowJournalRecord): Promise<void> => {
    if (!journal) return;
    try {
      await journal.append(record);
    } catch (error) {
      options.onJournalError?.(error, record);
    }
  };

  const runAndRecord: WorkflowHooks["agent"] = async (prompt, opts) => {
    const key = deriveKey(prompt, opts);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const agentId = workflowJournalAgentId(key, attempt, options.runId);

    await safeAppend({ type: "started", key, agentId });

    let result: unknown;
    try {
      result = await orchestration.agent(prompt, opts);
    } catch (error) {
      await safeAppend({ type: "failed", key, agentId });
      throw error;
    }
    // DoD①：agent 结果为 null → 写 failed（不写 result，避免下次把 null 当缓存结果回放）。
    await safeAppend(result === null ? { type: "failed", key, agentId } : { type: "result", key, agentId, result });
    return result;
  };

  const agent: WorkflowHooks["agent"] = async (prompt, opts) => {
    const key = deriveKey(prompt, opts);
    if (isReplayableWorkflowKey(resume, key)) {
      const started = resume!.started.get(key)!;
      const result = resume!.results.get(key);
      const mark: WorkflowReplayMark = {
        key,
        agentId: started.agentId,
        cached: true,
        attempts: started.attempts,
        result,
        resultPreview: previewWorkflowResult(result),
      };
      replays.push(mark);
      options.onReplay?.(mark);
      options.onTelemetry?.(WORKFLOW_JOURNAL_HIT_EVENT, {
        key,
        agentId: started.agentId,
        attempts: started.attempts,
      });
      return result;
    }
    return runAndRecord(prompt, opts);
  };

  return {
    hooks: { ...orchestration, agent },
    replays,
    flush: () => journal?.flush() ?? Promise.resolve(),
  };
}

// ───────────────────────── 运行目录与清理（DoD④） ─────────────────────────

/** journal 路径：`<runsDir>/<sanitized runId>/journal.jsonl`（run 目录组合复用 script-store 单源）。 */
export function workflowJournalPath(runsDir: string, runId: string): string {
  return path.join(workflowRunDir(runsDir, runId), WORKFLOW_JOURNAL_FILENAME);
}

export interface WorkflowCleanupResult {
  runDir: string;
  journalRemoved: boolean;
  dirRemoved: boolean;
  /** 被容错吞掉的错误码（形如 `journal:ENOENT` / `dir:ENOTEMPTY`），供核验员观察。 */
  tolerated: string[];
}

/**
 * 运行结束清理（A 级 §7.3 L12：删 journal.jsonl 并递归清理 run 目录，容错 ENOENT/ENOTEMPTY）。
 * [自定]⑧：用 `force:false` + 显式容错，使容错路径**可判别**（force:true 会静默吞 ENOENT，测试无法证伪）。
 * 非容错错误（EPERM/EBUSY 等）原样抛——清理失败须可见，不做静默降级。
 */
export async function cleanupWorkflowRun(
  runsDir: string,
  runId: string,
  fs: WorkflowJournalFs = defaultFs,
): Promise<WorkflowCleanupResult> {
  const runDir = workflowRunDir(runsDir, runId);
  const tolerated: string[] = [];

  let journalRemoved = false;
  try {
    await fs.rm(workflowJournalPath(runsDir, runId), { recursive: false, force: false });
    journalRemoved = true;
  } catch (error) {
    const code = errorCode(error);
    if (!isToleratedCode(code)) throw error;
    tolerated.push(`journal:${code}`);
  }

  let dirRemoved = false;
  try {
    await fs.rm(runDir, { recursive: true, force: false });
    dirRemoved = true;
  } catch (error) {
    const code = errorCode(error);
    if (!isToleratedCode(code)) throw error;
    tolerated.push(`dir:${code}`);
  }

  return { runDir, journalRemoved, dirRemoved, tolerated };
}

// ───────────────────────── 恢复配方（DoD③） ─────────────────────────

/** 单引号字符串字面量转义（[CC] `F()` 未逐字定位→[自定]⑨：`\` → `\\`、`'` → `\'`）。 */
export function escapeWorkflowResumeArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * 逐字恢复配方（A 级 §7.3 L11 原文形状）：
 * `To resume manually: Workflow({scriptPath: '<p>', resumeFromRunId: '<id>'}).`
 */
export function workflowResumeRecipe(input: { scriptPath: string; runId: string }): string {
  return `To resume manually: Workflow({scriptPath: '${escapeWorkflowResumeArg(input.scriptPath)}', resumeFromRunId: '${escapeWorkflowResumeArg(input.runId)}'}).`;
}

/** 中断提示（配方进工具结果；[自定]⑩：前缀文案自拟，配方本体逐字）。 */
export function workflowInterruptedNotice(input: { scriptPath: string; runId: string }): string {
  return `Workflow interrupted before completion; its journal was preserved. ${workflowResumeRecipe(input)}`;
}

// ───────────────────────── 运行会话（run 目录 + resume + 清理，装配层单入口） ─────────────────────────

export interface WorkflowJournalSessionOptions {
  /** 内层编排 hooks（WP-03 createWorkflowOrchestrator 的产物）。 */
  orchestration: WorkflowHooks;
  /** 运行目录根（装配层经 platform `workflowsDir(projectRoot)` 注入）。 */
  runsDir: string;
  /** 本次 runId（新 run）。 */
  runId: string;
  /** 从哪个历史 run 的 journal 续跑（缺位=不 resume）。 */
  resumeFromRunId?: string | null;
  /** 脚本落盘路径（恢复配方用；缺位=空串，同 [CC] `?? ""`）。 */
  scriptPath?: string;
  keyDerivation?: WorkflowAgentKeyDerivation;
  onTelemetry?: (event: string, payload: Record<string, unknown>) => void;
  onReplay?: (mark: WorkflowReplayMark) => void;
  onJournalError?: (error: unknown, record: WorkflowJournalRecord) => void;
  fs?: WorkflowJournalFs;
}

export interface WorkflowJournalSession {
  readonly runId: string;
  readonly runDir: string;
  readonly journalPath: string;
  /** resume 源 runId（null=无）。 */
  readonly resumeFromRunId: string | null;
  /** 已加载的 resume 状态（null=无 journal/读取失败→全量重跑）。 */
  readonly resumeState: WorkflowJournalState | null;
  readonly hooks: WorkflowHooks;
  readonly replays: WorkflowReplayMark[];
  /** 恢复配方（DoD③）：`Workflow({scriptPath, resumeFromRunId})` 形。 */
  resumeRecipe(): string;
  /** 中断提示（配方进工具结果）。 */
  interruptedNotice(): string;
  /** 落盘 journal，可选结束清理（DoD④）。 */
  finish(options?: { cleanup?: boolean }): Promise<WorkflowCleanupResult | null>;
}

export async function createWorkflowJournalSession(
  options: WorkflowJournalSessionOptions,
): Promise<WorkflowJournalSession> {
  const fs = options.fs ?? defaultFs;
  const resumeFromRunId = options.resumeFromRunId ?? null;
  const journalPath = workflowJournalPath(options.runsDir, options.runId);
  const runDir = workflowRunDir(options.runsDir, options.runId);

  // 缺 journal/读取失败 → null（DoD⑥：正常重跑，不崩溃）。
  const resumeState = resumeFromRunId ? await readWorkflowJournal(workflowJournalPath(options.runsDir, resumeFromRunId), fs) : null;

  const writer = createWorkflowJournalWriter({ filePath: journalPath, fs });
  const journaled = withWorkflowJournal(options.orchestration, {
    journal: writer,
    resume: resumeState,
    runId: options.runId,
    keyDerivation: options.keyDerivation,
    onTelemetry: options.onTelemetry,
    onReplay: options.onReplay,
    onJournalError: options.onJournalError,
  });

  const recipeInput = { scriptPath: options.scriptPath ?? "", runId: options.runId };

  return {
    runId: options.runId,
    runDir,
    journalPath,
    resumeFromRunId,
    resumeState,
    hooks: journaled.hooks,
    replays: journaled.replays,
    resumeRecipe: () => workflowResumeRecipe(recipeInput),
    interruptedNotice: () => workflowInterruptedNotice(recipeInput),
    async finish(finishOptions = {}) {
      await journaled.flush();
      if (!finishOptions.cleanup) return null;
      return cleanupWorkflowRun(options.runsDir, options.runId, fs);
    },
  };
}
