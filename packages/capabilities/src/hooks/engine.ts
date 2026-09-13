// WP-04：hooks 执行引擎（事件编排+matcher+超时+退出码/JSON 协议+聚合）。
// 形状出处：[CC] dig-04——§3.2 matcher（* / | , 列表 / 正则；非法正则 warn=false；query 缺失 matcher 整体跳过 :261743）；
// §3.4 超时（事件默认 Rs=600000ms；每 hook timeout 秒覆盖 s.timeout*1000；PreToolUse 超时/异常=工具不执行 :61919）；
// §3.5 退出码/JSON（exit0+JSON=success；exit2=blocking stderr 入 blockingError；其他非零=non_blocking_error；
// decision approve→allow/block→deny；permissionDecision 四值非法抛错带 schema 说明 :260365；RANK 只升不降 :60861/:60897；
// decisionReason 结构化 :61769）；§3.3 http（allowedHttpHookUrls 白名单+maxRedirects:0+SessionStart 禁用 :261879）；
// §3.6 信任门（未接受跳全部 :262013）；§7.5 disableAllHooks 总闸。
// [自定] 登记：defer≡ask（卡边界预登记）；shell=Node shell:true 缺省（win32=cmd.exe，PowerShell 特判不做）；
// allowedHttpHookUrls 逐字精确匹配；hookSpecificOutput.permissionDecision 优先于顶层 decision；非门事件超时=non_blocking 告警继续。
import { spawn } from "node:child_process";
import { sanitizeToolEnv } from "@standardcode/executor";
import { hookQueryFor, type HookConfig, type HookEventName, type HookMatcherGroup, type LoadedHooksConfig } from "./config.ts";

export type HookDecisionValue = "allow" | "deny" | "ask";

/** 结构化裁决依据（[CC] :61769 形状 type/hookName/hookSource/reason）。 */
export interface HookDecisionReason {
  type: "hook";
  hookName: string;
  hookSource: string;
  reason?: string;
}

export interface HookEventOutcome {
  /** 聚合裁决（RANK 只升不降 deny>ask>allow；defer≡ask；null=无 hook 产出裁决）。 */
  verdict: HookDecisionValue | null;
  /** 聚合依据（最高严重度决定的结构化原因；deny 恒赢语义下=deny 项）。 */
  decisionReason: HookDecisionReason | null;
  /** blocking 文本（exit2 stderr / decision:block reason——Stop/UserPromptSubmit 阻断与 PreToolUse 阻断文案）。 */
  blockingError?: string;
  /** non-blocking 告警（其他非零退出/JSON 解析失败/HTTP 白名单外/SessionStart 禁用/非门事件超时——继续不阻断）。 */
  nonBlockingErrors: string[];
  /** 信任门/总闸/空配置跳过原因（审计面）。 */
  skippedReason?: string;
}

export interface HookFireInput {
  query?: { toolName?: string; agentType?: string; source?: string; reason?: string };
  payload: Record<string, unknown>;
  /** Stop hook 重入标记（[自定]；blocks>0 时置位）。 */
  stopHookActive?: boolean;
}

export interface HookEngineOptions {
  /** 工作区信任态（:262013 逐字跳全部；thunk 形式=/reload 后读最新）。 */
  trusted: boolean | (() => boolean);
  cwd?: string;
  sessionId?: string;
  /** http 型注入面（测试）；缺省 global fetch。 */
  fetchImpl?: typeof fetch;
  /** command 型注入面（测试）；缺省 node:child_process spawn。 */
  spawnImpl?: typeof spawn;
  /** 事件默认超时覆盖（测试）；缺省 600000ms（[CC] Rs :62011）。 */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
/** 事件默认超时（DoD⑦ 缺省值断言面；[CC] Rs=600000 :62011）。 */
export const HOOK_EVENT_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const RANK: Record<"deny" | "ask" | "allow", number> = { deny: 3, ask: 2, allow: 1 }; // :60861 xgn 同构
const PERMISSION_DECISION_SCHEMA = 'hookSpecificOutput.permissionDecision must be one of "allow", "deny", "ask", "defer" (optional)'; // :260365 schema 说明形状

/** matcher 三态（dig-04 §3.2 vHt）：`*`/缺席=全配；`|`/`,` 列表=逐项全等；否则正则（非法=告警+false）。 */
export function matchHookMatcher(matcher: string | undefined, query: string | undefined, warnings: string[]): boolean {
  if (matcher === undefined || matcher === "*") return true;
  if (query === undefined) return true; // :261743 query 缺失=matcher 整体跳过（全执行——语义陷阱）
  for (const part of matcher.split(/[|,]/)) {
    const p = part.trim();
    if (p === "*" || p === "") continue;
    if (p === query) return true;
    try {
      if (new RegExp(p).test(query)) return true;
    } catch {
      if (!warnings.includes(`invalid hook matcher regex: ${matcher}`)) warnings.push(`invalid hook matcher regex: ${matcher}`);
      return false;
    }
  }
  return false;
}

interface HookExit {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runCommandHook(config: Extract<HookConfig, { type: "command" }>, payload: Record<string, unknown>, timeoutMs: number, opts: HookEngineOptions): Promise<HookExit> {
  const envSanitized = sanitizeToolEnv(process.env); // 接缝⑬：hook 子进程 env 过 SEC-080 清洗（fail-closed 缺省）
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const spawnFn = opts.spawnImpl ?? spawn;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(config.command, [], {
        shell: true, // [自定]：win32=cmd.exe / POSIX=sh（[CC] PowerShell 特判不做，偏差登记）
        env: envSanitized.env as NodeJS.ProcessEnv,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // 超时即决（不等 close）：Windows shell:true 下 SIGKILL 杀 shell 不杀孙进程，孤儿持 stdio 管道会把
      // close 拖到孙进程自然退出——timeout 语义（:61919 fail-closed 面）要求立即返回。
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, Math.max(1, Math.min(timeoutMs, 2_147_483_647)));
    timer.unref?.();
    const finish = (r: HookExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => finish({ exitCode: null, stdout, stderr, timedOut, spawnError: err.message }));
    child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* stdin 关闭失败=hook 自行读 EOF */
    }
  });
}

interface HttpExit {
  status: number | null;
  body: string;
  timedOut: boolean;
  error?: string;
}

async function runHttpHook(config: Extract<HookConfig, { type: "http" }>, payload: Record<string, unknown>, timeoutMs: number, opts: HookEngineOptions): Promise<HttpExit> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.min(timeoutMs, 2_147_483_647)));
  timer.unref?.();
  try {
    const res = await fetchFn(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual", // maxRedirects:0（:259195 形状——3xx 不跟随）
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { status: res.status, body, timedOut: false };
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    return { status: null, body: "", timedOut: aborted, error: aborted ? undefined : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** stdout → 归一决定（:260352/:260403 形状）；返回 decision=undefined 表示无产出（纯文本/无字段）。 */
function normalizeHookOutput(stdoutOrBody: string, warnings: string[]): { decision?: HookDecisionValue; blockingError?: string; reason?: string } {
  const trimmed = stdoutOrBody.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return {}; // 纯文本=success 无决定（:260353-260356）
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    warnings.push(`hook stdout JSON parse failed; expected object with optional decision ("approve" | "block") and hookSpecificOutput.permissionDecision (${PERMISSION_DECISION_SCHEMA})`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const r = parsed as Record<string, unknown>;
  let decision: HookDecisionValue | undefined;
  let blockingError: string | undefined;
  let reason: string | undefined;
  const hso = r.hookSpecificOutput;
  if (hso !== null && typeof hso === "object" && !Array.isArray(hso)) {
    const h = hso as Record<string, unknown>;
    const pd = h.permissionDecision;
    if (pd !== undefined) {
      if (pd === "allow" || pd === "deny" || pd === "ask") decision = pd;
      else if (pd === "defer") decision = "ask"; // [自定] defer≡ask（卡边界预登记：交互仓无 print/云形态）
      else warnings.push(`Invalid hookSpecificOutput.permissionDecision: ${JSON.stringify(pd)}. ${PERMISSION_DECISION_SCHEMA}`);
      if (typeof h.reason === "string") reason = h.reason;
    }
  }
  if (decision === undefined && r.decision !== undefined) {
    if (r.decision === "approve") decision = "allow";
    else if (r.decision === "block") decision = "deny";
    else warnings.push(`Invalid decision: ${JSON.stringify(r.decision)}. Must be "approve" or "block" (optional)`);
    if (typeof r.reason === "string") reason = r.reason;
  }
  if (decision === "deny" && reason !== undefined) blockingError = reason;
  return { decision, blockingError, reason };
}

/** 单 hook 配置的执行名（decisionReason hookName 形状）。 */
function hookName(config: HookConfig): string {
  return config.type === "command" ? config.command : config.url;
}

/** 事件默认超时（[CC] Rs=600000 :62011；SessionEnd 特殊面不做=偏差外边界）。 */
function hookTimeoutMs(config: HookConfig, opts: HookEngineOptions): number {
  const base = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return config.timeout !== undefined ? Math.max(1, Math.min(config.timeout * 1000, 2_147_483_647)) : base;
}

export interface HookEngine {
  fire(event: HookEventName, input: HookFireInput): Promise<HookEventOutcome>;
}

export function createHookEngine(config: LoadedHooksConfig, opts: HookEngineOptions): HookEngine {
  return {
    async fire(event: HookEventName, input: HookFireInput): Promise<HookEventOutcome> {
      const nonBlockingErrors: string[] = [];
      if (config.disableAllHooks) return { verdict: null, decisionReason: null, nonBlockingErrors, skippedReason: "hooks disabled (disableAllHooks)" };
      const trusted = typeof opts.trusted === "function" ? opts.trusted() : opts.trusted;
      if (!trusted) {
        // :262013 逐字形状 "Skipping ${event} hook execution - workspace trust not accepted"
        return { verdict: null, decisionReason: null, nonBlockingErrors, skippedReason: `Skipping ${event} hook execution - workspace trust not accepted` };
      }
      const groups: HookMatcherGroup[] = config.events[event] ?? [];
      if (groups.length === 0) return { verdict: null, decisionReason: null, nonBlockingErrors };
      const query = hookQueryFor(event, input.query ?? {});
      const matched = query === undefined ? groups.filter((g) => !g.matcher || matchHookMatcher(g.matcher, undefined, nonBlockingErrors)) : groups.filter((g) => matchHookMatcher(g.matcher, query, nonBlockingErrors));
      // 组平铺为 hook 序（组内 hooks 数组序；matcher 在组级）
      const flat: { config: HookConfig; source: string }[] = [];
      for (const g of matched) for (const h of g.hooks) flat.push({ config: h, source: g.source });
      if (flat.length === 0) return { verdict: null, decisionReason: null, nonBlockingErrors };

      const payload: Record<string, unknown> = {
        hook_event_name: event,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(input.stopHookActive ? { stop_hook_active: true } : {}),
        ...input.payload,
      };

      let bestRank = 0;
      let verdict: HookDecisionValue | null = null;
      let decisionReason: HookDecisionReason | null = null;
      let blockingError: string | undefined;
      let anyIncomplete = false;
      let incompleteReason: string | undefined;

      for (const { config: h, source } of flat) {
        const timeoutMs = hookTimeoutMs(h, opts);
        if (h.type === "command") {
          // SessionStart 禁 http 不影响 command；command 全事件可用
          const r = await runCommandHook(h, payload, timeoutMs, opts);
          if (r.timedOut || r.spawnError !== undefined) {
            anyIncomplete = true;
            incompleteReason = r.timedOut ? `hook did not respond before its timeout (${timeoutMs}ms)` : `hook failed to run: ${r.spawnError}`;
            nonBlockingErrors.push(`hook "${hookName(h)}" (${event}) ${r.timedOut ? `timed out after ${timeoutMs}ms` : `failed to run: ${r.spawnError}`}`);
            continue;
          }
          if (r.exitCode === 2) {
            // exit2=blocking（stderr 入 blockingError，:260403 形状）
            const reason = r.stderr.trim() || `exit code 2`;
            if (RANK.deny > bestRank) {
              bestRank = RANK.deny;
              verdict = "deny";
              decisionReason = { type: "hook", hookName: hookName(h), hookSource: source, reason };
              blockingError = reason;
            }
            continue;
          }
          if (r.exitCode !== 0) {
            nonBlockingErrors.push(`hook "${hookName(h)}" (${event}) non_blocking_error: exited with code ${r.exitCode}${r.stderr.trim() ? ` — ${r.stderr.trim().slice(0, 500)}` : ""}`);
            continue;
          }
          const norm = normalizeHookOutput(r.stdout, nonBlockingErrors);
          if (norm.decision) {
            const rank = RANK[norm.decision];
            if (rank > bestRank) {
              bestRank = rank;
              verdict = norm.decision;
              decisionReason = { type: "hook", hookName: hookName(h), hookSource: source, ...(norm.reason ? { reason: norm.reason } : {}) };
              if (norm.decision === "deny" && norm.blockingError) blockingError = norm.blockingError;
            }
          }
        } else {
          // http 型：SessionStart 禁用（:261879 逐字形状）+白名单+maxRedirects:0
          if (event === "SessionStart") {
            nonBlockingErrors.push(`HTTP hooks are not supported for ${event} ("${hookName(h)}" skipped)`);
            continue;
          }
          if (!config.allowedHttpHookUrls?.includes(h.url)) {
            nonBlockingErrors.push(`hook "${hookName(h)}" (${event}) refused: url not in allowedHttpHookUrls whitelist`);
            continue;
          }
          const r = await runHttpHook(h, payload, timeoutMs, opts);
          if (r.timedOut || r.error !== undefined) {
            anyIncomplete = true;
            incompleteReason = r.timedOut ? `hook did not respond before its timeout (${timeoutMs}ms)` : `hook failed to run: ${r.error}`;
            continue;
          }
          if (r.status !== null && r.status >= 300 && r.status < 400) {
            nonBlockingErrors.push(`hook "${hookName(h)}" (${event}) refused: redirect response ${r.status} (maxRedirects: 0)`);
            continue;
          }
          if (r.status === null || r.status < 200 || r.status >= 300) {
            nonBlockingErrors.push(`hook "${hookName(h)}" (${event}) non_blocking_error: HTTP ${r.status ?? "no response"}`);
            continue;
          }
          const norm = normalizeHookOutput(r.body, nonBlockingErrors);
          if (norm.decision) {
            const rank = RANK[norm.decision];
            if (rank > bestRank) {
              bestRank = rank;
              verdict = norm.decision;
              decisionReason = { type: "hook", hookName: hookName(h), hookSource: source, ...(norm.reason ? { reason: norm.reason } : {}) };
              if (norm.decision === "deny" && norm.blockingError) blockingError = norm.blockingError;
            }
          }
        }
      }

      // PreToolUse fail-closed（:61919 形状——超时/异常=工具不执行，无旁路；deny 恒赢不受 allow 洗白）
      if (event === "PreToolUse" && anyIncomplete && bestRank < RANK.deny) {
        return {
          verdict: "deny",
          decisionReason: { type: "hook", hookName: "(incomplete)", hookSource: "engine", reason: `PreToolUse ${incompleteReason}. The tool call was not executed (fail-closed); other configured hooks may not have completed.` },
          nonBlockingErrors,
          ...(blockingError !== undefined ? { blockingError } : {}),
        };
      }
      return { verdict, decisionReason, ...(blockingError !== undefined ? { blockingError } : {}), nonBlockingErrors };
    },
  };
}
