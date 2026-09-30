// S4-1 接线回归（全仓审查 2026-10-01 批2）：tool-factory bind 逐调用并入 env 的 signal/registerProcess
// 必须真达 executor——原六工具 run 写单参 `(input) => execX(input, 闭包 env)`，bind 的第 2 参被形参表
// 静默丢弃 ⇒ registerProcess 恒 0（procs 恒空、树杀空转）、执行中 abort 无效（Ctrl+C/TaskStop 失效）。
// 判别性：注册面修复前恒 0（快红）；中断面修复前信号丢弃、60s 长命令须跑满（测试超时红）。
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStandardTools } from "../src/tool-factory.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-cr2-int-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("S4-1 标准工具中断接线（bind 逐调用 env 透传）", () => {
  it("registerProcess 真收子进程（echo 短命令；修复前恒 0——procs 空、树杀空转）", async () => {
    const tools = createStandardTools({ cwd: dir });
    const bash = tools.find((t) => t.name === "Bash");
    expect(bash).toBeDefined();
    const registered: ChildProcess[] = [];
    const out = await bash!.execute(
      { command: "echo s4-1-ok" },
      { signal: new AbortController().signal, registerProcess: (c) => registered.push(c) },
    );
    expect(out).toContain("s4-1-ok");
    expect(registered.length).toBeGreaterThanOrEqual(1);
    expect(registered[0]!.pid).toBeTruthy();
  });

  it("执行中 abort → interrupted（60s 长命令被打断；修复前信号被丢弃须跑满）", async () => {
    const tools = createStandardTools({ cwd: dir });
    const bash = tools.find((t) => t.name === "Bash")!;
    const ac = new AbortController();
    const p = bash.execute(
      { command: `node -e "setTimeout(function(){},60000)"` },
      { signal: ac.signal, registerProcess: () => {} },
    );
    await new Promise((r) => setTimeout(r, 400)); // 子进程已起（与 executor.test abort 臂同形制）
    ac.abort();
    const started = Date.now();
    await expect(p).rejects.toThrow(/interrupted/);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("基线 env 语义不变：bind 合并的 cwd/spill/sandbox 基座仍在（SEC-080 面零回归）", async () => {
    const tools = createStandardTools({ cwd: dir });
    const read = tools.find((t) => t.name === "Read");
    expect(read).toBeDefined();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "r.txt"), "hello-read");
    const out = await read!.execute({ file_path: "r.txt" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(out).toContain("hello-read"); // 相对路径按 opts.cwd 解析=基座 env 在位
  });
});
