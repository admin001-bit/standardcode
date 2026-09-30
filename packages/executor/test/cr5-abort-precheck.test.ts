// S4-3 回归（全仓审查 2026-10-01 批5）：spawn/沙箱请求前 signal.aborted 前置拒——已 abort 的 signal
// 上 addEventListener 永不触发，原实现子进程/沙箱命令照跑满时长（树杀空转、沙箱臂成功路径无事后检查）。
import { describe, expect, it } from "vitest";
import { execBash, runProcess, type SandboxHandle, type SandboxRunResult } from "@standardcode/executor";

function preAborted(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

describe("S4-3 已 abort 信号前置拒（不 spawn）", () => {
  it("runProcess：pre-aborted → rejects interrupted（修复前照 spawn 并正常 resolve）", async () => {
    await expect(
      runProcess({ command: process.execPath, args: ["-e", "console.log('should-not-run')"], signal: preAborted() }),
    ).rejects.toThrow(/interrupted/);
  });

  it("execBash 直通臂：pre-aborted → rejects interrupted（不进 runProcess 即拦）", async () => {
    await expect(execBash({ command: "echo should-not-run" }, { cwd: process.cwd(), env: {}, signal: preAborted() })).rejects.toThrow(
      /interrupted/,
    );
  });

  it("execBash 沙箱臂：pre-aborted → rejects interrupted 且沙箱 run 零调用", async () => {
    let runs = 0;
    const rec: Array<{ kind: string; payload: unknown }> = [];
    const handle: SandboxHandle = {
      tier: "workspace-write",
      policy: () => ({ fs: { kind: "restricted", writable_roots: [], carveouts: [], metadata: { protected_names: [], read_only_subpaths: [] } }, net: "denied" }),
      run: async (e) => {
        runs++;
        rec.push({ kind: "run", payload: e });
        return { exitCode: 0, stdout: "ok", stderr: "" } satisfies SandboxRunResult;
      },
      writeViaSandbox: async () => {},
      livePid: () => 1,
      root: () => "/",
      setRoot: () => {},
      shutdown: () => {},
      close: async () => {},
    };
    await expect(execBash({ command: "echo x" }, { cwd: process.cwd(), env: {}, sandbox: handle, signal: preAborted() })).rejects.toThrow(
      /interrupted/,
    );
    expect(runs).toBe(0); // 修复前：沙箱臂无前置检查 → run 照发
    expect(rec).toHaveLength(0);
  });
});
