// S5-9 回归（全仓审查 2026-10-01 批5）：/loop 执行期接管 session.activeAbort 且 runProviderTurn
// 收 AbortSignal——原命令派发在 runPromptTurn 之外（activeAbort 恒 null）：Ctrl+C 只置轮间标志、
// 当前流跑完才停，main 还走 else 提示「(输入 /exit 退出)」误导；provider 请求恒不带 signal。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createCommandContext } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-cr5-loop-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 流挂起直到 signal abort（模拟适配器停流）；记录每个请求的 signal。 */
function interruptibleProvider(reqs: LLMRequest[]): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      yield { type: "message_start", id: "m", model: "test" } as LLMEvent;
      yield { type: "text_delta", text: "partial" } as LLMEvent;
      // push 放在 partial 之后：测试 waitFor(reqs≥1) 可见 ⇒ 消费方已收 text_delta（消除抢跑歧义）
      reqs.push(req);
      if (req.signal) {
        if (!req.signal.aborted) {
          await new Promise<void>((res) => req.signal!.addEventListener("abort", () => res(), { once: true }));
        }
        return; // abort=停流结束（保留已生成 partial）
      }
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeSession(provider: ProviderAdapter): Session {
  const proj = path.join(root, "proj");
  return createSession({ provider, catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home: path.join(root, "home"), trusted: true });
}

describe("S5-9 /loop 中断接线", () => {
  it("执行期 activeAbort=作用域控制器、provider 收 signal；中断=当轮停流保留 partial、下一轮即止、作用域还原", async () => {
    const reqs: LLMRequest[] = [];
    const s = makeSession(interruptibleProvider(reqs));
    let interrupted = false;
    const ctx = createCommandContext({
      session: s,
      io: { lines: (async function* () {})(), write: () => {}, close: () => {} },
      baseDir: path.join(root, "repl-store"),
      isInterrupted: () => interrupted,
    });
    const p = ctx.loop("3 hello");
    await waitFor(() => reqs.length >= 1);
    // 修复前：/loop 期间 session.activeAbort 恒 null（onInterrupt 落 else 提示）——两断言均红
    const scope = s.activeAbort;
    expect(scope).not.toBeNull();
    expect(reqs[0]!.signal).toBe(scope!.signal); // runProviderTurn 收到作用域 signal
    // 模拟 main.onInterrupt：置标志 + abort 当前流
    interrupted = true;
    scope!.abort();
    const r = await p;
    expect(reqs).toHaveLength(1); // 第 2 轮顶 break（修复前无 signal → 当前流跑满才轮间断，且此处 scope=null 直接 TypeError）
    // partial 保留（§8.4）：当轮 assistant 已落会话
    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(JSON.stringify(assistants[0])).toContain("partial");
    expect(r.text).toBeTruthy();
    expect(s.activeAbort).toBeNull(); // 作用域还原（prev=null）
  });
});
