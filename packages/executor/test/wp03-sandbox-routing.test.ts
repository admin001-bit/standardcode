// WP-03 工具路由臂：ExecEnv.sandbox 在位=Bash/Write/Edit 走句柄；缺席=直通零变化（DoD①）。
// fake handle=协议面替身（真跨边界形见 integration 测）。
import { describe, expect, it } from "vitest";
import { execBash, execWrite, execEdit, ExecError, type SandboxHandle, type SandboxRunResult } from "@standardcode/executor";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fakeHandle(impl: Partial<SandboxHandle> & { run?: (e: Parameters<SandboxHandle["run"]>[0]) => Promise<SandboxRunResult> }, rec: Array<{ kind: string; payload: unknown }>): SandboxHandle {
  return {
    tier: "workspace-write",
    policy: () => ({ fs: { kind: "restricted", writable_roots: [], carveouts: [], metadata: { protected_names: [], read_only_subpaths: [] } }, net: "denied" }),
    run: async (e) => {
      rec.push({ kind: "run", payload: e });
      return impl.run ? impl.run(e) : { exitCode: 0, stdout: "ok", stderr: "" };
    },
    writeViaSandbox: async (p, c) => {
      rec.push({ kind: "write", payload: { p, c } });
    },
    livePid: () => 4242,
    root: () => process.cwd(),
    setRoot: () => {},
    shutdown: () => {},
    close: async () => {},
  };
}

describe("wp03 bash/write/edit sandbox routing", () => {
  it("DoD①/形状：无 sandbox=零经手（execBash 走真进程 echo）", async () => {
    const out = await execBash({ command: "echo direct" }, { cwd: process.cwd(), env: {} });
    expect(out.trim()).not.toBe("ok");
  });

  it("execBash 经句柄：program/args/cwd/env 透传+exit code 与直通同形（ExecError `exit code N`）", async () => {
    const rec: Array<{ kind: string; payload: unknown }> = [];
    const envOk = { cwd: path.resolve(process.cwd()), env: {}, sandbox: fakeHandle({}, rec) };
    const out = await execBash({ command: "echo hi" }, envOk);
    expect(out.trim()).toBe("ok");
    const envFail = { cwd: path.resolve(process.cwd()), env: {}, sandbox: fakeHandle({ run: async () => ({ exitCode: 3, stdout: "so", stderr: "se" }) }, rec) };
    await expect(execBash({ command: "false" }, envFail)).rejects.toThrow(/exit code 3[\s\S]*\[stderr\]/);
    const last = rec.at(-1) as { payload: { program: string; args: string[] } };
    expect(last.payload.args.at(-1)).toContain("false"); // 命令入参原样（shell 包装形同直通臂）
  });

  it("接缝⑭：env 缺席现场清洗——SEC-080 剔除键（密钥通道/Bash 注入）不入沙箱请求；代理键由 server 策略闸承担（双闸归位见 integration）", async () => {
    const rec: Array<{ kind: string; payload: unknown }> = [];
    const prev = { ...process.env };
    process.env.WP03_TEST_API_KEY = "secret";
    process.env.BASH_ENV = "/tmp/x";
    process.env.WP03_KEEP_ME = "keep";
    try {
      const h = fakeHandle({}, rec);
      await execBash({ command: "echo x" }, { cwd: process.cwd(), sandbox: h });
    } finally {
      for (const k of ["WP03_TEST_API_KEY", "BASH_ENV", "WP03_KEEP_ME"]) delete process.env[k];
      Object.assign(process.env, prev);
    }
    void rec;
    const payload = rec.at(-1)?.payload as { env: Record<string, string> };
    expect(Object.keys(payload.env).some((k) => /API_KEY$/.test(k))).toBe(false);
    expect(Object.keys(payload.env).map((k) => k.toLowerCase())).not.toContain("bash_env");
    expect(Object.keys(payload.env)).toContain("WP03_KEEP_ME"); // 保留键在位（清洗非全剥）
  });

  it("超时臂：timeout 触发 shutdown+`timed out` 文案（同直通形）", async () => {
    const h = createSandboxHandleDelay();
    await expect(execBash({ command: "sleep 5", timeout: 1 }, { cwd: process.cwd(), env: {}, sandbox: h })).rejects.toThrow(/timed out after 1ms/);
    expect(h.shutdownCalled).toBe(true);
  }, 15_000);

  it("中断臂：signal abort → shutdown+`interrupted`（DoD⑧ 沙箱面同文案）", async () => {
    const h = createSandboxHandleDelay();
    const ac = new AbortController();
    const p = execBash({ command: "sleep 5" }, { cwd: process.cwd(), env: {}, sandbox: h, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/interrupted/);
    expect(h.shutdownCalled).toBe(true);
  }, 15_000);

  it("execWrite 经沙箱：目录护栏先行（宿主 stat）；写走 writeViaSandbox 同文案", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp03-route-"));
    const rec: Array<{ kind: string; payload: unknown }> = [];
    const h = fakeHandle({}, rec);
    const out = await execWrite({ file_path: path.join(dir, "a.txt"), content: "hello" }, { cwd: dir, sandbox: h });
    expect(out).toContain("wrote 5 bytes to");
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false); // 直通写未发生（经句柄单路）
    expect((rec.at(-1)?.payload as { p: string }).p).toBe(path.join(dir, "a.txt"));
    await expect(execWrite({ file_path: dir, content: "x" }, { cwd: dir, sandbox: h })).rejects.toBeInstanceOf(ExecError);
  });

  it("execEdit 经沙箱：唯一性校验同形+全文交句柄", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp03-route2-"));
    const f = path.join(dir, "x.txt");
    fs.writeFileSync(f, "aa\naa\nbb");
    const rec: Array<{ kind: string; payload: unknown }> = [];
    const h = fakeHandle({}, rec);
    await expect(execEdit({ file_path: f, old_string: "aa", new_string: "cc" }, { cwd: dir, sandbox: h })).rejects.toThrow(/not unique/);
    const out = await execEdit({ file_path: f, old_string: "bb", new_string: "cc" }, { cwd: dir, sandbox: h });
    expect(out).toContain("1 replacement");
    expect(fs.readFileSync(f, "utf8")).toBe("aa\naa\nbb"); // 宿主直写未发生
    expect((rec.at(-1)?.payload as { c: string }).c).toBe("aa\naa\ncc");
  });
});

/** run 永不 resolve 的替身（超时/中断臂：观测 shutdown 调用位）。 */
function createSandboxHandleDelay(): SandboxHandle & { shutdownCalled: boolean } {
  const h = {
    tier: "workspace-write" as const,
    policy: () => ({ fs: { kind: "restricted" as const, writable_roots: [], carveouts: [], metadata: { protected_names: [], read_only_subpaths: [] } }, net: "denied" as const }),
    run: () => new Promise<SandboxRunResult>(() => {}),
    writeViaSandbox: async () => {},
    livePid: () => 1,
    root: () => "/",
    setRoot: () => {},
    shutdown: () => {
      h.shutdownCalled = true;
    },
    close: async () => {},
    shutdownCalled: false,
  };
  return h;
}
