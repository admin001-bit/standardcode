// 协议不变量断言（§12.2：每 turn——每个 tool_use 恰好配对一个 tool_result；并行结果按 block index 回填）。
// 在每次 provider 请求前对消息序列做机械校验；违反即抛 HarnessInvariantError（fail-fast）。

import type { LLMMessage } from "@standardcode/providers";

export class HarnessInvariantError extends Error {
  override name = "HarnessInvariantError";
}

export function assertProtocolInvariants(messages: LLMMessage[]): void {
  const open = new Map<string, number>(); // toolUseId → 该 tool_use 所在 assistant 消息下标
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "tool_use") {
          if (open.has(b.id)) throw new HarnessInvariantError(`duplicate tool_use id: ${b.id}`);
          open.set(b.id, i);
        }
      }
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          if (!open.has(b.toolUseId)) {
            throw new HarnessInvariantError(`tool_result without preceding tool_use: ${b.toolUseId}`);
          }
          open.delete(b.toolUseId);
        }
      }
    }
  }
  if (open.size > 0) {
    throw new HarnessInvariantError(`dangling tool_use without tool_result: ${[...open.keys()].join(", ")}`);
  }
}
