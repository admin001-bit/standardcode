// WP-07（M5）平台侧测试：ADR-0045 更新原子性（层一锁错重试/层二装后校验/层三明确引导）+runNpmUninstall。
// 判据自足：板 WP-07 DoD③（updater 行为对位 0045）+ADR-0045 决策 1-2；全离线 runner 桩零网络（M4 WP-08 注入面先例）。
import { describe, expect, it } from "vitest";
import {
  ATOMIC_MAX_RETRIES,
  LOCK_ERROR_SIGNATURES,
  NPM_UNINSTALL_ARGS,
  runNpmUninstall,
  runNpmUpdateAtomic,
  verifyInstalledVersion,
  type NpmRunner,
  type NpmRunResult,
} from "../src/updater.ts";

const INSTALL_ARGS = ["i", "-g", "@standardcode-oss/cli@latest"];
const LS_ARGS = ["ls", "-g", "@standardcode-oss/cli", "--json"];

/** 序列桩：按调用序弹出响应；记录 (cmd,args,env) 供断言。 */
function seqRunner(responses: NpmRunResult[]) {
  const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: NpmRunner = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    const r = responses.shift();
    if (r === undefined) throw new Error("runner exhausted");
    return Promise.resolve(r);
  };
  return { runner, calls };
}

const LS_OK_0101: NpmRunResult = { status: 0, stdout: JSON.stringify({ dependencies: { "@standardcode-oss/cli": { version: "0.1.1" } } }) };
const LS_OK_0100: NpmRunResult = { status: 0, stdout: JSON.stringify({ dependencies: { "@standardcode-oss/cli": { version: "0.1.0" } } }) };
const INSTALL_OK: NpmRunResult = { status: 0 };
const INSTALL_EBUSY: NpmRunResult = { status: 1, stderrTail: "npm error code EBUSY\nnpm errorEM file busy" };

describe("DoD③ ADR-0045 层一·锁错重试", () => {
  it("EBUSY 一次→重试成功：attempts=2+verified=true+installedVersion", async () => {
    const { runner, calls } = seqRunner([INSTALL_EBUSY, INSTALL_OK, LS_OK_0101]);
    const sleepes: number[] = [];
    const r = await runNpmUpdateAtomic({ runner, expectedVersion: "0.1.1", sleep: async (ms) => void sleepes.push(ms) });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.verified).toBe(true);
    expect(r.installedVersion).toBe("0.1.1");
    expect(calls[0]!.args).toEqual(INSTALL_ARGS);
    expect(calls[2]!.args).toEqual(LS_ARGS);
    expect(sleepes).toEqual([1500]);
  });
  it("重试耗尽（默认 1+2 次）→ok:false+guidance 含关闭实例与手动命令", async () => {
    const { runner, calls } = seqRunner([INSTALL_EBUSY, INSTALL_EBUSY, INSTALL_EBUSY]);
    const r = await runNpmUpdateAtomic({ runner, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1 + ATOMIC_MAX_RETRIES);
    expect(calls.length).toBe(3);
    expect(r.guidance).toContain("关闭正在运行的 standardcode 实例");
    expect(r.guidance).toContain(`npm i -g @standardcode-oss/cli@latest`);
    expect(r.guidance).toContain("post-retries");
  });
  it("重试命令与首试一致（同 args 同 env 剥离面）——ADR-0045 决策 3", async () => {
    const { runner, calls } = seqRunner([INSTALL_EBUSY, INSTALL_OK, LS_OK_0100]);
    await runNpmUpdateAtomic({ runner, env: { STANDARD_CODE_API_KEY: "sk-test", PATH: "x" }, sleep: async () => {} });
    expect(calls[0]!.args).toEqual(calls[1]!.args);
    expect(calls[0]!.env.STANDARD_CODE_API_KEY).toBeUndefined(); // SEC-080 剥离面共用
  });
  it("锁签名族在位（EBUSY/EPERM/ENOTEMPTY/EACCES）", () => {
    expect(LOCK_ERROR_SIGNATURES).toEqual(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
  });
});

describe("DoD③ ADR-0045 层一·非锁错误 fail-fast（决策 2）", () => {
  it("网络类失败不消耗重试预算：attempts=1", async () => {
    const { runner, calls } = seqRunner([{ status: 1, stderrTail: "npm error network ECONNRESET" }]);
    const r = await runNpmUpdateAtomic({ runner, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(calls.length).toBe(1);
    expect(r.guidance).toContain("npm i -g @standardcode-oss/cli@latest");
  });
});

describe("DoD③ ADR-0045 层二·装后校验", () => {
  it("status=0 但 npm ls 失败→ok:false+guidance post-verify", async () => {
    const { runner } = seqRunner([INSTALL_OK, { status: 1, stderrTail: "npm error missing" }]);
    const r = await runNpmUpdateAtomic({ runner, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.guidance).toContain("post-verify");
    expect(r.verified).toBeUndefined();
  });
  it("实装版本与 expectedVersion 不一致→ok:false+guidance 含两版本", async () => {
    const { runner } = seqRunner([INSTALL_OK, LS_OK_0100]);
    const r = await runNpmUpdateAtomic({ runner, expectedVersion: "0.2.0", sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.installedVersion).toBe("0.1.0");
    expect(r.guidance).toContain("installed 0.1.0 but expected 0.2.0");
  });
  it("无 expectedVersion=仅校验存在性→ok:true", async () => {
    const { runner } = seqRunner([INSTALL_OK, LS_OK_0101]);
    const r = await runNpmUpdateAtomic({ runner, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
  });
  it("verifyInstalledVersion：坏 JSON/缺条目/非零退出→结构化失败", async () => {
    const a = seqRunner([{ status: 0, stdout: "not-json" }]);
    expect((await verifyInstalledVersion({ runner: a.runner })).ok).toBe(false);
    const b = seqRunner([{ status: 0, stdout: JSON.stringify({ dependencies: {} }) }]);
    expect((await verifyInstalledVersion({ runner: b.runner })).ok).toBe(false);
    const c = seqRunner([{ status: 1, stderrTail: "empty" }]);
    expect((await verifyInstalledVersion({ runner: c.runner })).ok).toBe(false);
  });
});

describe("WP-07 uninstall runner（ADR-0044 决策 5）", () => {
  it("runNpmUninstall：args 全硬编码 rm -g + win32→npm.cmd + env 剥离", async () => {
    const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: NpmRunner = (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return Promise.resolve({ status: 0 });
    };
    const r = await runNpmUninstall({ runner, env: { STANDARD_CODE_SESSION_ID: "s", PATH: "x" }, platform: "win32" });
    expect(r.status).toBe(0);
    expect(calls[0]!.cmd).toBe("npm.cmd");
    expect(calls[0]!.args).toEqual(NPM_UNINSTALL_ARGS);
    expect(NPM_UNINSTALL_ARGS).toEqual(["rm", "-g", "@standardcode-oss/cli"]);
    expect(calls[0]!.env.STANDARD_CODE_SESSION_ID).toBeUndefined();
  });
});
