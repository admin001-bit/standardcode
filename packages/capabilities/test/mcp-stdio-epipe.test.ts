// MCP stdio EPIPE 回归（2026-09-30 O 项清偿；源自 2026-09-23 CI 教训：wp09-plugin-session
// afterAll 对已关子进程写 → write EPIPE → vitest "Unhandled Errors" → 全部用例通过仍 exit 1）。
// 缺陷本体=stdin 流级 'error' 无接收者（send() 回调面已拒；流级事件裸奔 → 进程级未捕获）。
// 复现形：destroy(EPIPE) 令流确定性 emit 'error'（Windows 下 OS 级断管不可靠，实测
// closeSync(0)/destroy 句柄后 write 仍成功——故靶向流事件面而非 syscall 面）。
// 修复前=本文件红（Unhandled Error）；修复后=流级事件被 transport 监听吞掉＋send 走回调拒绝。
import { describe, expect, it } from "vitest";
import { StdioTransport } from "../src/mcp/transport.ts";

describe("MCP stdio 传输 EPIPE 面", () => {
  it("stdin 流级 error 有接收者：destroy(EPIPE) 后 send 拒绝且无进程级未捕获", async () => {
    const t = new StdioTransport({
      config: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 8000)"],
      },
      cwd: process.cwd(),
      sessionId: "epipe-test",
    });
    await t.start();
    const stdin = (t as unknown as { child: { stdin: import("node:stream").Writable } }).child.stdin;
    stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(t.send({ jsonrpc: "2.0", method: "ping", id: 1 } as never)).rejects.toThrow();
    await t.close();
  }, 15_000);
});
