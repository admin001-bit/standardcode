// WP-03 客户端协议面（对 fake server=纯 TS 帧形，非真 Rust；跨边界真形见 integration 测）。
// 覆盖：lazy 拉起（DoD① 断言面）、握手、事件重组/reqId 关联、并发复用（池首形）、
// error 帧 fail-closed（DoD⑥）、shutdown/close 终态、坏帧关通道。
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxHandle, SandboxExecError, SandboxUnavailableError, type SandboxHandle } from "@standardcode/executor";

const FAKE_SERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-sandbox-serve.mjs");

function handle(): SandboxHandle {
  return createSandboxHandle({ tier: "workspace-write", workspaceRoot: path.resolve(process.cwd()), binaryPath: process.execPath, binaryArgs: [FAKE_SERVE] });
}

describe("wp03 sandbox client（fake serve）", () => {
  it("DoD① lazy：装配后零拉起；首次 run 后 livePid 在位", async () => {
    const h = handle();
    expect(h.livePid()).toBe(null);
    await h.run({ program: "x", args: ["a"], cwd: process.cwd(), env: {} });
    expect(h.livePid()).not.toBe(null);
    await h.close();
  });

  it("run：事件按 reqId 归位拼接 stdout/stderr + exitCode 透传", async () => {
    const h = handle();
    const r = await h.run({ program: "sh", args: ["-c", "echo hi"], cwd: "/x", env: {} });
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe("chunk1:-c|echo hi");
    expect(r.stderr).toBe("E");
    await h.close();
  });

  it("并发复用：同 server 多请求 id 关联不串扰（池首形 DoD 交付项）", async () => {
    const h = handle();
    const pid0 = (await h.run({ program: "warm", args: ["w"], cwd: "/x", env: {} })) && h.livePid();
    const results = await Promise.all([
      h.run({ program: "p1", args: ["one"], cwd: "/x", env: {} }),
      h.run({ program: "p2", args: ["two"], cwd: "/x", env: {} }),
      h.run({ program: "p3", args: ["three"], cwd: "/x", env: {} }),
    ]);
    expect(results.map((r) => r.stdout)).toEqual(["chunk1:one", "chunk1:two", "chunk1:three"]);
    expect(h.livePid()).toBe(pid0); // 不另拉进程
    await h.close();
  });

  it("fsWrite 成功响应通过；error 帧 → SandboxExecError 上抛（DoD⑥ fail-closed 回灌面）", async () => {
    const h = handle();
    await expect(h.writeViaSandbox(path.join(process.cwd(), "f.txt"), "content")).resolves.toBeUndefined();
    const err = await h.run({ program: "x", args: ["boom"], cwd: "/x", env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxExecError);
    expect((err as SandboxExecError).code).toBe("privilege_missing");
    // error 帧不杀通道：后续请求仍可复用
    const ok = await h.run({ program: "x", args: ["after"], cwd: "/x", env: {} });
    expect(ok.stdout).toBe("chunk1:after");
    await h.close();
  });

  it("shutdown 后再执行=拒绝（不回退未沙箱；会话终态不可逆）", async () => {
    const h = handle();
    await h.run({ program: "p", args: ["x"], cwd: "/x", env: {} });
    h.shutdown();
    await expect(h.run({ program: "p", args: ["y"], cwd: "/x", env: {} })).rejects.toBeInstanceOf(Error);
  });

  it("close=stdin EOF 正常收束；server 退出后无悬挂", async () => {
    const h = handle();
    await h.run({ program: "p", args: ["x"], cwd: "/x", env: {} });
    await h.close();
    expect(h.livePid()).toBe(null);
  });
});
