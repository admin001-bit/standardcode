// 工具执行回路（§5.4：schema 校验 → 权限仲裁（接口点，WP-08）→ 执行 → 回灌）。

import { spawn, type ChildProcess } from "node:child_process";
import type { Tool, ToolContext, ToolRegistry } from "./types.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** M1 最小 schema 校验：object + required + properties.type 基础型；未声明属性放行（M1 六工具均为 object）。 */
export function validateToolInput(schema: Tool["inputSchema"], input: unknown): string | null {
  if (schema.type !== "object") return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const record = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in record)) return `missing required property: ${String(key)}`;
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const [key, value] of Object.entries(record)) {
    const expected = props[key]?.type;
    if (!expected) continue;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (expected === "integer" ? !Number.isInteger(value) : actual !== expected) {
      return `property ${key}: expected ${expected}, got ${actual}`;
    }
  }
  return null;
}

export interface RunToolsOptions {
  registry: ToolRegistry;
  permission?: { check(toolName: string, input: unknown): Promise<"allow" | "deny"> };
  signal?: AbortSignal;
}

/**
 * 执行一组工具调用并返回与入参同序的结果（block index 回填由调用方保证——结果数组顺序=tool_use 块顺序）。
 * 并发策略：本轮全部 isConcurrencySafe → Promise 竞速并行；否则按序串行（[CC] isConcurrencySafe 同构）。
 * 中断：abort 后未完成的调用合成 error tool_result（协议不留悬空 tool_use，硬不变量）。
 */
export async function runTools(calls: ToolCall[], opts: RunToolsOptions): Promise<ToolOutcome[]> {
  const outcomes = new Map<string, ToolOutcome>();
  const procs: import("node:child_process").ChildProcess[] = [];
  const ctx: ToolContext = {
    signal: opts.signal ?? new AbortController().signal,
    registerProcess(child) {
      procs.push(child);
    },
  };
  const runOne = async (call: ToolCall): Promise<void> => {
    outcomes.set(call.id, await runOneTool(call, ctx, opts));
  };

  const allSafe = calls.length > 0 && calls.every((c) => (opts.registry.get(c.name)?.isConcurrencySafe ?? false) === true);
  const all = Promise.all(calls.map(runOne));
  if (allSafe) {
    // 并行：abort 竞速仅在提供 signal 时建立（否则 race 会被非 thenable 立即胜出）
    const abortP = abortPromise(opts.signal);
    await (abortP ? Promise.race([all, abortP]) : all);
  } else {
    for (const call of calls) {
      if (opts.signal?.aborted) break;
      await runOne(call);
    }
  }

  if (opts.signal?.aborted) {
    for (const p of procs) killTreeSafe(p);
  }

  // 未完成的调用（中断路径）合成 error tool_result——顺序仍按 block index
  return calls.map((call) => {
    const done = outcomes.get(call.id);
    if (done) return done;
    return {
      id: call.id,
      name: call.name,
      content: "interrupted",
      isError: true,
    };
  });
}

function abortPromise(signal?: AbortSignal): Promise<null> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
}

async function runOneTool(call: ToolCall, ctx: ToolContext, opts: RunToolsOptions): Promise<ToolOutcome> {
  const tool = opts.registry.get(call.name);
  if (!tool) {
    return { id: call.id, name: call.name, content: `unknown tool: ${call.name}`, isError: true };
  }
  if (opts.permission) {
    const decision = await opts.permission.check(call.name, call.input);
    if (decision === "deny") {
      return { id: call.id, name: call.name, content: `permission denied: ${call.name}`, isError: true };
    }
  }
  const invalid = validateToolInput(tool.inputSchema, call.input);
  if (invalid) {
    return { id: call.id, name: call.name, content: `input failed schema validation: ${invalid}`, isError: true };
  }
  try {
    const content = await tool.execute(call.input, ctx);
    return { id: call.id, name: call.name, content, isError: false };
  } catch (err) {
    const message = ctx.signal.aborted ? "interrupted" : err instanceof Error ? err.message : String(err);
    return { id: call.id, name: call.name, content: `tool error: ${message}`, isError: true };
  }
}

function killTreeSafe(child: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {}
}
