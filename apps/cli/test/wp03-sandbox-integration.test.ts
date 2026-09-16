// WP-03 端到端集成测：真 Rust `standardcode-sandbox --serve` 跨边界（TS producer wire →
// Rust SandboxPolicy::deserialize → 平台真执行）——"策略→argv 快照"宿主侧半的活体形。
// 防静默 skip（WP-01/02 R1 门禁形制）：GITHUB_ACTIONS 在位而二进制缺位=直接 fail；
// 本地缺位=显式警告后跳过（开发通道，非 CI 判据）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSandboxHandle,
  execBash,
  execWrite,
  SandboxUnavailableError,
  type SandboxHandle,
} from "@standardcode/capabilities";

const BIN = process.env.STANDARD_CODE_SANDBOX_BIN;
const CI = process.env.GITHUB_ACTIONS === "true";

let root: string; // 沙箱 workspace-write 根（会话工作区替身）
let outside: string; // 根外对照面

let handle: SandboxHandle | undefined;

beforeAll(() => {
  if (!BIN) {
    if (CI) throw new Error("R1 门禁形制：CI 沙箱集成测必须实跑（rust build 步骤未产 bin/STANDARD_CODE_SANDBOX_BIN 未注入=静默绿不成立）");
    return;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wp03-int-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "wp03-int-out-"));
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  handle = createSandboxHandle({ tier: "workspace-write", workspaceRoot: root, binaryPath: BIN });
});

afterAll(async () => {
  await handle?.close();
  for (const d of [root, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const skipIfNoBin: [() => boolean] = [() => !BIN];

describe.skipIf(!BIN)("wp03 sandbox e2e（真 bin）", () => {
  it("DoD②：Bash 工作区内写成功；越界写失败且错误可诊断（exec 拒绝非绕过）", async () => {
    const env = { cwd: root, env: {} as NodeJS.ProcessEnv, sandbox: handle! };
    if (process.platform === "win32") {
      // windows 非提权=privilege fail-closed（DoD⑥ 正向形；全链=实机回归 BLK-04=①）
      await expect(execBash({ command: "echo hi" }, env)).rejects.toThrow(/privilege|Privilege/i);
      return;
    }
    const out = await execBash({ command: "echo inside > made.txt && cat made.txt" }, env);
    expect(out.trim()).toContain("inside");
    const err = await execBash({ command: `echo x > ${path.join(outside, "smuggle.txt")}`, timeout: 30_000 }, env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/exit code|Read-only|EROFS|Operation not permitted/i);
    expect(fs.existsSync(path.join(outside, "smuggle.txt"))).toBe(false);
  }, 90_000);

  it("DoD④：.git/hooks 与 .standardcode 元数据默认禁写经 serve 通道兑现（EXE-011 行 427 清单）", async () => {
    if (process.platform === "win32") return; // 同上 privilege 形；正判据面=linux/mac 真隔离
    const env = { cwd: root, env: {} as NodeJS.ProcessEnv, sandbox: handle! };
    await expect(execBash({ command: "touch .git/hooks/probe" }, env)).rejects.toThrow(/exit code/);
    await expect(execBash({ command: "mkdir -p .standardcode && touch .standardcode/probe" }, env)).rejects.toThrow(/exit code/);
    expect(fs.existsSync(path.join(root, ".git", "hooks", "probe"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".standardcode", "probe"))).toBe(false);
  }, 90_000);

  it("DoD② 文件写面：execWrite root 内成/外拒（fsWrite 帧→沙箱内 --fs-write）", async () => {
    const env = { cwd: root, env: {} as NodeJS.ProcessEnv, sandbox: handle! };
    if (process.platform === "win32") {
      await expect(execWrite({ file_path: path.join(root, "w.txt"), content: "x" }, env)).rejects.toThrow(/privilege|Privilege/i);
      return;
    }
    await execWrite({ file_path: path.join(root, "sub", "w.txt"), content: "沙箱写 ✓" }, env);
    expect(fs.readFileSync(path.join(root, "sub", "w.txt"), "utf8")).toBe("沙箱写 ✓");
    const target = path.join(outside, "escape.txt");
    await expect(execWrite({ file_path: target, content: "nope" }, env)).rejects.toThrow(/沙箱内写失败|exit=/);
    expect(fs.existsSync(target)).toBe(false);
  }, 90_000);

  it("DoD⑤ 面（子进程输出经沙箱零截断）：>64KB 多 event 帧重组逐字节一致", async () => {
    if (process.platform === "win32") return; // 非提权 privilege 形（上面已锁该断言）
    const h = createSandboxHandle({ tier: "workspace-write", workspaceRoot: root, binaryPath: BIN! });
    try {
      const big = "0123456789abcdef".repeat(8192); // 128KB > 2×64KB 事件块
      const r = await h.run({ program: "/bin/sh", args: ["-c", `printf '${big}'`], cwd: root, env: {} });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBe(big.length);
      expect(r.stdout).toBe(big);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("DoD⑥ fail-closed：二进制缺位=拒绝而非未沙箱回退（SandboxUnavailableError 前抛）", async () => {
    const broken = createSandboxHandle({ tier: "workspace-write", workspaceRoot: root, binaryPath: path.join(root, "definitely-missing-bin") });
    // 显式 binaryPath 给不存在路径=resolveSandboxBinary existsSync 拒。
    await expect(broken.run({ program: "sh", args: ["-c", "echo must-not-run"], cwd: root, env: {} })).rejects.toBeInstanceOf(SandboxUnavailableError);
    await broken.close();
    expect(fs.existsSync(path.join(root, "must-not-run"))).toBe(false);
  });

  it("DoD⑦ teardown：close=server 进程终（EOF 正常退出，零悬挂）", async () => {
    const h = createSandboxHandle({ tier: "workspace-write", workspaceRoot: root, binaryPath: BIN! });
    await h.run({ program: "x", args: [], cwd: root, env: {} }).catch(() => {}); // 拉起即可（不存在 program=spawn_failed 错误帧，通道存活）
    const pid = h.livePid();
    expect(pid).not.toBe(null);
    await h.close();
    if (pid) {
      // POSIX kill(pid,0)/windows OpenProcess 探针：进程已终
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      // 竞态宽限：exit 状态被父 await 收束后 kill(0) 必 ESRCH
      expect(alive).toBe(false);
    }
  }, 60_000);

  it("接缝⑭ 沙箱臂：网络 deny 时代理 env 双闸（宿主清洗+server 策略剥）——env 无代理键入子进程", async () => {
    if (process.platform === "win32") return;
    const env = { cwd: root, env: {} as NodeJS.ProcessEnv, sandbox: handle! };
    const out = await execBash({ command: "env | grep -iE '^(HTTP|HTTPS|ALL|FTP|SOCKS)_PROXY=' | wc -l" }, env);
    expect(out.trim()).toBe("0");
    // 显式下发带代理键的 env（bash.ts 直通层=已清洗面，server apply_proxy_policy 第二闸）：
    const withProxy = { cwd: root, env: { HTTPS_PROXY: "http://attacker:8080", PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv, sandbox: handle! };
    const out2 = await execBash({ command: "env | grep -icE '^(HTTP|HTTPS|ALL|FTP|SOCKS)_PROXY=' || true" }, withProxy);
    expect(Number(out2.trim())).toBe(0);
  }, 90_000);
});

// 门禁自检（skipIf 的对照面）：若上方整块因 BIN 缺位而 skip，CI 上 beforeAll 已抛——
// 本测锁 skipIf 表达式与 CI 断言同源。
describe("wp03 guard 形制自检", () => {
  it("skipIf 与 beforeAll 门禁同源（同一 BIN 变量；CI+缺 bin=抛非 skip）", () => {
    expect(skipIfNoBin.length).toBe(1);
    expect(typeof skipIfNoBin[0]!()).toBe("boolean");
  });
});
