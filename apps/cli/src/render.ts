// 流式输出上屏（DoD④；UI-040 Concise [自定]：正文直出、工具折叠为状态行、thinking 不上屏、usage 行随 WP-05 口径）。
import { formatRawUsage, type UsageMeter } from "@standardcode/context";
import type { AgentEvent, TurnState } from "@standardcode/harness";

export async function renderTurn(
  events: AsyncGenerator<AgentEvent, TurnState, unknown>,
  write: (s: string) => void,
  meter: UsageMeter,
): Promise<TurnState> {
  const it = events[Symbol.asyncIterator]();
  let sawText = false;
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
        write(`\n${formatRawUsage(ev.usage, meter.observe(ev.usage))}\n`);
        break;
      case "recovery":
        write(`\n[recovery] ${ev.chain} (round ${ev.round})\n`);
        break;
      case "interrupted":
        write(`\n[interrupted: ${ev.phase}]\n`);
        break;
      case "context_exhausted":
        write("\n[context exhausted — start a new session (CTX-101)]\n");
        break;
      case "done":
        if (ev.reason !== "end") write(`[done: ${ev.reason}]\n`);
        break;
      default:
        break; // turn_start / finish：上屏省略（concise）
    }
  }
}
