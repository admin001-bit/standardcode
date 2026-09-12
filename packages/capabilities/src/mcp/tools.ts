// MCP 工具注入+权限消费面+超时矩阵+120s 转后台（M4-WP-02；卡 DoD①-⑧）。
// 锚点：dig-05 §5（命名净化 :72740；mcpInfo/annotations :296452-296467；顶层组合器跳过文案 :296293）、
// §3.1（超时矩阵：总 1e8/钳位 [1000,2147483647] :294965-294971；idle stdio 1800000 其他 300000 :294973-294979+iGs/sGs :298452；
// 可操作提示文案 :298032-298034；分页 c9r=20 :298442）、§3.2（转后台 120s :178829/Mos :177526 同构+全文案形状 :293505；
// 终态双路通知；TaskStop 清理）。S-3（§11）：MCP 工具缺省 ask——经 full name 走既有 broker 评估序，无自动放行。
import { McpClient, type JsonRpcNotification } from "./client.ts";
import type { StandardTool } from "../contract.ts";
import { parseAutoBackgroundMs, type TaskRegistry, type ToolContext } from "@standardcode/harness";
import type { ToolInputSchema } from "@standardcode/providers";

// —— 超时矩阵常量（纯函数判据面） ——

export const MCP_TOOL_TOTAL_DEFAULT_MS = 100_000_000; // Vqs=1e8 形状 :298441（缺省实质不限）
export const MCP_IDLE_STDIO_MS = 1_800_000; // iGs :298452
export const MCP_IDLE_OTHER_MS = 300_000; // sGs :298453
export const MCP_TOOLS_LIST_MAX_PAGES = 20; // c9r :298442

const clampTimeout = (n: number): number => Math.max(1000, Math.min(n, 2_147_483_647));

export function resolveTotalTimeoutMs(serverTimeout: number | undefined, env: NodeJS.ProcessEnv): number {
  if (typeof serverTimeout === "number" && serverTimeout >= 1000) return clampTimeout(serverTimeout);
  const raw = Number(env.STANDARD_CODE_MCP_TOOL_TIMEOUT);
  if (Number.isFinite(raw) && raw > 0) return clampTimeout(raw);
  return MCP_TOOL_TOTAL_DEFAULT_MS;
}

/** idle=min(max(基准, per-server timeout≥1000, 1000), total)（:294973 形状）；基准 env=0 → 禁用（0 透传）。 */
export function resolveIdleTimeoutMs(
  transportKind: "stdio" | "sse" | "http",
  serverTimeout: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env.STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT;
  let base: number;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) base = transportKind === "stdio" ? MCP_IDLE_STDIO_MS : MCP_IDLE_OTHER_MS;
    else base = parsed; // 0=禁用
  } else {
    base = transportKind === "stdio" ? MCP_IDLE_STDIO_MS : MCP_IDLE_OTHER_MS;
  }
  if (base === 0) return 0;
  const perServer = typeof serverTimeout === "number" && serverTimeout >= 1000 ? serverTimeout : 0;
  const total = resolveTotalTimeoutMs(serverTimeout, env);
  return Math.min(Math.max(base, perServer, 1000), total);
}

// —— 命名净化与 schema 兼容闸（DoD①③） ——

/** [CC] Ir 净化同构（_712.js:11）：非法字符→"_"；mcp__<server>__<tool> 命名空间（§5.3(4)）。 */
export function sanitizeMcpNameSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}
export function mcpToolFullName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeMcpNameSegment(serverName)}__${toolName}`;
}

const TOP_LEVEL_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/** 顶层组合器判定（Anthropic API 拒收面，:296293）；返回命中的组合器名列表。 */
export function topLevelCombinators(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  return TOP_LEVEL_COMBINATORS.filter((k) => k in (schema as Record<string, unknown>));
}
export function skipReasonForCombinators(combinators: string[]): string {
  return `its input schema uses top-level ${combinators.join("/")}, which the Anthropic API does not accept`;
}

// —— 枚举（分页 20 页上限，DoD⑦；schema 门，DoD③） ——

export interface McpRawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}
export interface McpEnumerateResult {
  tools: McpRawTool[];
  skipped: { name: string; reason: string }[];
  pageCapReached: boolean;
}

export async function enumerateMcpTools(client: McpClient, maxPages = MCP_TOOLS_LIST_MAX_PAGES): Promise<McpEnumerateResult> {
  const tools: McpRawTool[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let pageCapReached = false;
  for (;;) {
    const res = (await client.request("tools/list", cursor ? { cursor } : undefined)) as {
      tools?: McpRawTool[];
      nextCursor?: string;
    };
    for (const t of res.tools ?? []) {
      const combos = topLevelCombinators(t.inputSchema);
      if (combos.length > 0) {
        skipped.push({ name: t.name, reason: skipReasonForCombinators(combos) });
        continue;
      }
      tools.push(t);
    }
    pages++;
    cursor = typeof res.nextCursor === "string" && res.nextCursor !== "" ? res.nextCursor : undefined;
    if (!cursor) break;
    if (pages >= maxPages) {
      pageCapReached = true; // 还有 nextCursor 但预算耗尽
      break;
    }
  }
  return { tools, skipped, pageCapReached };
}

// —— 工具构建（execute=超时矩阵+转后台包装） ——

export interface McpToolContext {
  serverName: string;
  transport: "stdio" | "sse" | "http";
  serverTimeout: number | undefined;
  env: NodeJS.ProcessEnv;
  /** 转后台仅主循环（:296642 生效条件之"主循环"面；子代理执行器传 false）。 */
  isMainLoop: boolean;
  /** 缺省=无注册表→不翻转（ORC-022 条件机制：env 缺席恒同步）。 */
  registry?: TaskRegistry;
  /** 会话级通知队列（转后台终态文本 push——repl 轮首 drain 注入 <system-reminder>）。 */
  notifications?: string[];
  /** server 宣告 list_changed 时的重载回调（DoD⑧；session 装配接线）。 */
  onToolsChanged?: (serverName: string) => void;
  /** 注入时钟（测试）。 */
  now?: () => number;
}

export interface McpToolMeta {
  mcpInfo: { serverName: string; serverType: string; displayName: string; toolName: string };
  annotations: McpRawTool["annotations"];
}

function flattenToolResult(result: unknown): string {
  const r = (typeof result === "object" && result !== null ? result : {}) as { content?: unknown; isError?: boolean };
  const parts: string[] = [];
  for (const block of Array.isArray(r.content) ? r.content : []) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else parts.push(`[mcp ${String(b.type ?? "content")} content omitted]`); // 非文本块 M4 承载面 [自定]：标注不静默
  }
  const text = parts.join("\n");
  if (r.isError === true) throw new Error(text === "" ? "MCP tool returned isError with no content" : text);
  return text;
}

const excerpt = (s: string, n = 4000): string => (s.length <= n ? s : `…${s.slice(-n)}`); // 通知摘要=尾窗（32KB 预览面=TaskOutput 消费）

function timeoutHint(fullName: string, totalMs: number): string {
  return (
    `MCP tool "${fullName}" timed out after ${totalMs}ms. ` +
    `Set a per-server "timeout" (ms) in its mcpServers entry, or set STANDARD_CODE_MCP_TOOL_TIMEOUT (ms) globally (clamped [1000, 2147483647]).`
  );
}
function idleHint(fullName: string, idleMs: number): string {
  return (
    `MCP tool "${fullName}" received no response or progress notification for ${idleMs}ms. ` +
    `Set a per-server "timeout" (ms) in its mcpServers entry, otherwise set STANDARD_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables).`
  ); // 文案形状 :298032-298034 同构（env 名换本仓前缀）
}

/** 单次调用：total+idle 双闸（idle=入站活动复位）。 */
async function callToolOnce(
  client: McpClient,
  fullName: string,
  rawToolName: string,
  input: unknown,
  ctx: ToolContext,
  mctx: McpToolContext,
): Promise<string> {
  const totalMs = resolveTotalTimeoutMs(mctx.serverTimeout, mctx.env);
  const idleMs = resolveIdleTimeoutMs(mctx.transport, mctx.serverTimeout, mctx.env);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleMs === 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(idleHint(fullName, idleMs)), idleMs);
      idleTimer.unref?.();
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      offActivity();
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new Error(msg));
    };
    const offActivity = client.onActivity(() => armIdle());
    const onAbort = () => fail(`MCP tool "${fullName}" cancelled`);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const totalTimer = setTimeout(() => fail(timeoutHint(fullName, totalMs)), totalMs);
    totalTimer.unref?.();
    armIdle();
    client
      .request("tools/call", { name: rawToolName, arguments: input ?? {} }, { signal: ctx.signal })
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        offActivity();
        ctx.signal.removeEventListener("abort", onAbort);
        try {
          resolve(flattenToolResult(res));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
  });
}

/**
 * 120s 转后台（DoD⑥；fqs=callMcpToolWithAutoBackground :293382-293511 同构）：
 * 生效条件=主循环+有注册表+env 阈值>0；翻转=注册 task（type=mcp_tool）+markBackgrounded+立即返回
 * :293505 形状文本；原调用后台继续，终态 completed/failed 双路落账+通知。
 */
export async function callMcpToolWithAutoBackground(
  client: McpClient,
  fullName: string,
  rawToolName: string,
  input: unknown,
  ctx: ToolContext,
  mctx: McpToolContext,
): Promise<string> {
  // 生效条件（DoD⑥/:296642）：主循环+有注册表+env 阈值>0——子代理执行器 agentKind 标记排除。
  const autoMs = mctx.isMainLoop && mctx.registry && ctx.agentKind !== "subagent" ? parseAutoBackgroundMs(mctx.env.STANDARD_CODE_AUTO_BACKGROUND_TASKS) : 0;
  // TaskStop 取消链：本调用挂自有 taskAbort；前台中断（ctx.signal）与后台终止分离——
  // §8.4"后台任务不受前台中断影响"仅对已翻转任务成立；翻转前 ctx.signal 透传（前台调用可中断）。
  const taskAbort = new AbortController();
  const callSignal = autoMs > 0 ? AbortSignal.any([ctx.signal, taskAbort.signal]) : ctx.signal;
  const call = callToolOnce(client, fullName, rawToolName, input, { ...ctx, signal: callSignal }, mctx);
  if (autoMs <= 0) return call;
  const start = (mctx.now ?? Date.now)();
  const flipped = await new Promise<"done" | "backgrounded">((resolve, reject) => {
    const timer = setTimeout(() => resolve("backgrounded"), autoMs);
    timer.unref?.();
    call.then(
      () => {
        clearTimeout(timer);
        resolve("done");
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
  if (flipped === "done") return call;
  // 翻转：注册任务（TaskStop 经 runtime.abort 停原调用——取消链闭环）；原 call 继续，settle 落账+双路通知。
  const registry = mctx.registry!;
  const task = registry.register({
    type: "mcp_tool",
    agentId: `mcp:${mctx.serverName}:${rawToolName}`,
    agentType: `mcp__${sanitizeMcpNameSegment(mctx.serverName)}`,
    description: `MCP tool call: ${rawToolName}`,
    isBackgrounded: true,
  });
  registry.attachRuntime(task.taskId, { abort: taskAbort, children: new Set() });
  registry.markBackgrounded(task.taskId);
  const T = Math.round(autoMs / 1000);
  void call.then(
    (content) => {
      registry.complete(task.taskId, { content, totalTokens: 0, totalToolUseCount: 0, totalDurationMs: (mctx.now ?? Date.now)() - start, doneReason: "completed" });
      mctx.notifications?.push(`MCP task ${task.taskId} completed. Tool "${rawToolName}" on server "${mctx.serverName}":\n${excerpt(content)}`);
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      registry.fail(task.taskId, msg); // stopTask 先行 fail 时此处 no-op（settle 幂等）
      mctx.notifications?.push(`MCP task ${task.taskId} failed. Tool "${rawToolName}" on server "${mctx.serverName}": ${msg}`);
    },
  );
  return (
    `MCP tool "${rawToolName}" is still running after ${T}s. It was moved to the background as task ${task.taskId} and keeps running; ` +
    `you'll receive a notification with the result when it completes. You can keep working in the meantime. ` +
    `To stop it, use TaskStop with task_id "${task.taskId}". Note: it does not survive exiting this session.`
  ); // :293505 逐段形状
}

/** 客户端→工具列表（含 list_changed 订阅 DoD⑧）；serverName 经 mctx 提供（=连接 entry.name）。 */
export async function buildMcpToolsForConnection(client: McpClient, mctx: McpToolContext): Promise<{ tools: (StandardTool & McpToolMeta)[]; skipped: { name: string; reason: string }[]; pageCapReached: boolean }> {
  const enumerated = await enumerateMcpTools(client);
  if (mctx.onToolsChanged) {
    client.addNotificationListener((n: JsonRpcNotification) => {
      if (n.method === "notifications/tools/list_changed") mctx.onToolsChanged!(mctx.serverName);
    });
  }
  const cfg = mctx.serverName;
  const tools = enumerated.tools.map((t): StandardTool & McpToolMeta => {
    const fullName = mcpToolFullName(cfg, t.name);
    return {
      name: fullName,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }) as ToolInputSchema,
      searchHint: `${cfg}: ${t.description ?? t.name}`.slice(0, 200),
      isConcurrencySafe: t.annotations?.readOnlyHint === true, // [自定] 保守：hint 非真=串行
      deferred: false,
      mcpInfo: { serverName: cfg, serverType: mctx.transport, displayName: t.title ?? t.name, toolName: t.name },
      annotations: t.annotations,
      execute: (input: unknown, ctx: ToolContext) => callMcpToolWithAutoBackground(client, fullName, t.name, input, ctx, mctx),
    };
  });
  return { tools, skipped: enumerated.skipped, pageCapReached: enumerated.pageCapReached };
}
