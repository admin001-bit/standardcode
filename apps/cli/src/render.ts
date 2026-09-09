// 流式输出上屏（DoD④；UI-040 Concise [自定]：正文直出、工具折叠为状态行、thinking 不上屏、usage 行随 WP-05 口径）。
import { formatRawUsage, type UsageMeter } from "@standardcode/context";
import type { TokenUsage } from "@standardcode/providers";
import type { AgentEvent, TurnState } from "@standardcode/harness";

export async function renderTurn(
  events: AsyncGenerator<AgentEvent, TurnState, unknown>,
  write: (s: string) => void,
  meter: UsageMeter,
  hooks?: { onDone?(reason: string): void },
): Promise<TurnState> {
  const it = events[Symbol.asyncIterator]();
  let sawText = false;
  // ADR-0027：usage 事件=轮内快照（Anthropic 每轮两条：message_start 部分快照+message_delta 合并）。
  // 只 observe 轮内末条，且挂到 finish（每轮恰一次）——按事件数 observe 会把会话累计翻倍（V 核验发现，WP-05 报告跑偏①）。
  let pendingUsage: TokenUsage | null = null;
  while (true) {
    const r = await it.next();
    if (r.done) {
      if (sawText) write("\n");
      return r.value;
    }
    const ev = r.value;
    switch (ev.type) {
      case "text_delta":
        write(ev.text);
        sawText = true;
        break;
      case "thinking_delta":
        break; // UI-040：M1 不上屏 thinking
      case "tool_start":
        if (sawText) write("\n");
        write(`[tool] ${ev.name} …`);
        sawText = false;
        break;
      case "tool_result":
        write(` ${ev.isError ? "✗" : "✓"}\n`);
        break;
      case "usage":
        pendingUsage = ev.usage;
        break;
      case "finish":
        if (pendingUsage) write(`\n${formatRawUsage(pendingUsage, meter.observe(pendingUsage))}\n`);
        pendingUsage = null;
        break;
      case "recovery":
        write(`\n[recovery] ${ev.chain} (round ${ev.round})\n`);
        break;
      case "reactive_step":
        // WP-05（CTX-037）：reactive 瀑布步升级上屏（tokenGap 指标可见）
        write(`\n[reactive] step ${ev.step} (gap ${ev.tokenGap})\n`);
        sawText = false;
        break;
      case "interrupted":
        write(`\n[interrupted: ${ev.phase}]\n`);
        break;
      case "context_exhausted":
        write("\n[context exhausted — start a new session (CTX-101)]\n");
        break;
      case "done":
        hooks?.onDone?.(ev.reason); // WP-10：终态入转录（resume 等价断言面）
        if (ev.reason !== "end") write(`[done: ${ev.reason}]\n`);
        break;
      default:
        break; // turn_start：上屏省略（concise）
    }
  }
}
