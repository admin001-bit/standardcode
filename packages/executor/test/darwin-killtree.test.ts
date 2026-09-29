// macOS 实机面（2026-09-30 轮次11）：killTree POSIX 臂真 darwin 进程组回收。
// 本仓进程类测试历史均在 Windows 执行，`process.kill(-child.pid, "SIGKILL")` 分支
// （packages/executor/src/proc.ts:54-58；detached 组语义 :71）从未在真 darwin 跑过——
// 残留面「macOS 实机」的进程/信号子面。仅 darwin 执行（CI macos gate 真跑），其它平台 skip。
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runProcess } from "@standardcode/executor";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 组内 pid 列表（pgrep -g=按 pgid 匹配；detached 子进程 pgid===child.pid）。 */
function groupPids(pgid: number): number[] {
  const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter(Boolean).map(Number);
}

describe.runIf(process.platform === "darwin")("darwin 真机：killTree 进程组回收", () => {
  it("abort→SIGKILL 整组：父+孙（后台 sleep）全灭；kill 前组在场=阳性对照", async () => {
    let pid = 0;
    const ac = new AbortController();
    const done = runProcess({
      command: "/bin/sh",
      args: ["-c", "sleep 300 & wait"],
      signal: ac.signal,
      registerProcess: (c) => {
        pid = c.pid ?? 0;
      },
    });
    // 阳性对照：组内 ≥2（sh 本体 + 后台 sleep 孙进程）——证明 pgrep 判据非恒空
    let before: number[] = [];
    const t0 = Date.now();
    while (before.length < 2 && Date.now() - t0 < 5000) {
      before = pid > 0 ? groupPids(pid) : [];
      if (before.length < 2) await sleepMs(200);
    }
    expect(pid).toBeGreaterThan(0);
    expect(before.length, `pgid=${pid} 阳性对照失败（组在场=[${before}]）`).toBeGreaterThanOrEqual(2);

    ac.abort(); // → killTree → process.kill(-pid, "SIGKILL")（proc.ts:55 真 darwin 首跑）
    const res = await done;
    expect(res.code).toBeNull(); // SIGKILL 终止 → close code null

    // 阴性：整组（含孙进程）回收，5s 窗
    let after = groupPids(pid);
    const t1 = Date.now();
    while (after.length > 0 && Date.now() - t1 < 5000) {
      await sleepMs(200);
      after = groupPids(pid);
    }
    expect(after, `pgid=${pid} 残留=[${after}]`).toEqual([]);
  }, 20_000);
});
