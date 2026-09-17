// WP-08（M5）分发网络面标定测试：DoD① 代理族透传+本地桩 CONNECT 断言（零真实网络）+
// DoD② 认证注入面（token 走 -c 参数面不进 env 不落盘）+URL 内嵌凭据脱敏（SEC-030 链/S-3）。
// 判据自足：板 WP-08 DoD①②；规格=v2.8 §7.7 MDL-020/021 行 353"代理族全出站生效；默认不开启"。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripEnvBaseline } from "../src/env-baseline.ts";
import { installPlugin, redactUrlCredentials, GIT_TOKEN_ENV_KEY, type GitRunner } from "../src/plugin/installer.ts";

const dirs: string[] = [];
const stubs: { kill(): void; logPath: string }[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-wp08net-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const s of stubs.splice(0)) s.kill(); // 先杀 stub 子进程（其 cwd 在临时目录内）
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * DoD① 本地桩代理（独立子进程——spawnSync 阻塞本进程事件循环，stub 必须跨进程才能应答）：
 * 记录 CONNECT 目标行到日志文件并立即 403（零真实网络）。
 */
function startProxyStub(workDir: string): { logPath: string; waitPort(): Promise<number> } {
  const logPath = join(workDir, "proxy-connects.log");
  const portFile = join(workDir, "proxy-port.txt");
  const script = join(workDir, "proxy-stub.mjs");
  writeFileSync(
    script,
    [
      "import net from 'node:net';",
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const log = process.argv[2];",
      "const portFile = process.argv[3];",
      "const srv = net.createServer((c) => {",
      "  let buf = '';",
      "  c.on('data', (d) => {",
      "    buf += d.toString();",
      "    if (buf.includes('\\r\\n\\r\\n')) {",
      "      appendFileSync(log, 'CONNECT ' + (buf.split('\\r\\n')[0] ?? '') + '\\n');",
      "      c.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');",
      "    }",
      "  });",
      "  c.on('error', () => {});",
      "});",
      "srv.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(srv.address().port)));",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script, logPath, portFile], { stdio: "ignore" }); // cwd=继承仓根（不锁临时目录）
  stubs.push({ logPath, kill: () => { child.kill(); } });
  const waitPort = async (): Promise<number> => {
    for (let i = 0; i < 50; i++) {
      if (existsSync(portFile)) return Number(readFileSync(portFile, "utf8").trim());
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("proxy stub did not report port");
  };
  return { logPath, waitPort };
}

function fixtureRepo(root: string): string {
  const repo = join(root, "fixture-plugin");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "plugin.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["add", "."]);
  g(["commit", "-qm", "fixture"]);
  return repo;
}

describe("DoD① 代理面（MDL-020/021 行 353：全出站生效；默认不开启=透传语义）", () => {
  it("stripEnvBaseline 保留代理族（大小写）并剥离 STANDARD_CODE_*：代理键按策略透传", () => {
    const src = {
      HTTP_PROXY: "http://p:1",
      HTTPS_PROXY: "http://p:2",
      ALL_PROXY: "socks5://p:3",
      NO_PROXY: "localhost",
      http_proxy: "http://p:4",
      [GIT_TOKEN_ENV_KEY]: "tok",
      STANDARD_CODE_SESSION_ID: "s",
    };
    const out = stripEnvBaseline(src as unknown as NodeJS.ProcessEnv);
    expect(out.HTTP_PROXY).toBe("http://p:1");
    expect(out.HTTPS_PROXY).toBe("http://p:2");
    expect(out.ALL_PROXY).toBe("socks5://p:3");
    expect(out.NO_PROXY).toBe("localhost");
    expect(out.http_proxy).toBe("http://p:4");
    expect(out[GIT_TOKEN_ENV_KEY]).toBeUndefined(); // token 走 -c 参数面，不进子进程 env
    expect(out.STANDARD_CODE_SESSION_ID).toBeUndefined();
  });
  it("本地桩 server 断言：HTTPS_PROXY 下 clone 实际经代理 CONNECT（真 git 子进程，零真实网络）", { timeout: 30_000 }, async () => {
    const root = tmp();
    const stub = startProxyStub(root);
    const port = await stub.waitPort();
    const outcome = await installPlugin("https://example.invalid/x.git", {
      baseDir: join(root, "base"),
      opts: { env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${port}` }, tmpRoot: root },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("clone-failed");
    // 桩日志收到 CONNECT 隧道请求=git 出站确实经代理（MDL-020"全出站生效"实证）
    const log = readFileSync(stub.logPath, "utf8");
    expect(log).toContain("CONNECT example.invalid:443");
  });
});

describe("DoD② 认证注入面（token 走 -c 参数面；URL 内嵌凭据脱敏）", () => {
  it("STANDARD_CODE_GIT_TOKEN → -c http.extraHeader 注入（参数面在 -- 前）+env 无 token+GIT_TERMINAL_PROMPT=0", { timeout: 30_000 }, async () => {
    const root = tmp();
    const repo = fixtureRepo(root);
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: GitRunner = (args, env) => {
      calls.push({ args: [...args], env: { ...env } });
      const dest = args[args.length - 1]!;
      execFileSync("git", ["clone", "--depth", "1", "--", `file://${repo.replace(/\\/g, "/")}`, dest], { stdio: "pipe" });
      return { status: 0 };
    };
    // 隔离宿主污染（本会话宿主自带 GIT_TERMINAL_PROMPT=0——断言须独立于宿主）
    const installEnv = { ...process.env, [GIT_TOKEN_ENV_KEY]: "tok-123" } as NodeJS.ProcessEnv;
    delete installEnv.GIT_TERMINAL_PROMPT;
    const outcome = await installPlugin("https://github.com/example/fixture.git", {
      baseDir: join(root, "base"),
      opts: { runGit: runner, env: installEnv, tmpRoot: root },
    });
    expect(outcome.ok).toBe(true);
    const cloneCall = calls[0]!;
    const ci = cloneCall.args.indexOf("-c");
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(cloneCall.args[ci + 1]).toBe("http.extraHeader=AUTHORIZATION: bearer tok-123");
    expect(cloneCall.args.indexOf("--")).toBeGreaterThan(ci + 1); // 注入参数在 -- 之前
    expect(cloneCall.env[GIT_TOKEN_ENV_KEY]).toBeUndefined(); // token 不进子进程 env
    expect(cloneCall.env.GIT_TERMINAL_PROMPT).toBe("0"); // 非交互 fail-fast [自定]
  });
  it("无 token env=零注入（-c 缺席）+clone 成功=零干扰通路（credential helper 场景等价）", { timeout: 30_000 }, async () => {
    const root = tmp();
    const repo = fixtureRepo(root);
    const calls: { args: string[] }[] = [];
    const runner: GitRunner = (args) => {
      calls.push({ args: [...args] });
      const dest = args[args.length - 1]!;
      execFileSync("git", ["clone", "--depth", "1", "--", `file://${repo.replace(/\\/g, "/")}`, dest], { stdio: "pipe" });
      return { status: 0 };
    };
    const outcome = await installPlugin("https://github.com/example/fixture.git", {
      baseDir: join(root, "base"),
      opts: { runGit: runner, env: { ...process.env }, tmpRoot: root },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.manifest?.name).toBe("fixture");
    expect(calls[0]!.args.join(" ")).not.toContain("http.extraHeader"); // 无 token=零注入（helper 原生路不受扰）
  });
  it("URL 内嵌凭据：clone 失败消息脱敏（不含密钥值）", async () => {
    const root = tmp();
    const runner: GitRunner = () => ({ status: 128, stderr: "fatal: unable to access 'https://user:secret123@example.com/repo.git/': error" });
    const outcome = await installPlugin("https://user:secret123@example.com/repo.git", {
      baseDir: join(root, "base"),
      opts: { runGit: runner, env: { ...process.env }, tmpRoot: root },
    });
    expect(outcome.ok).toBe(false);
    const joined = JSON.stringify(outcome.warnings);
    expect(joined).not.toContain("secret123");
  });
  it("URL 内嵌凭据：安装成功路 sourceLabel 脱敏落盘（plugins.json 不含密钥值）", { timeout: 30_000 }, async () => {
    const root = tmp();
    const repo = fixtureRepo(root);
    const runner: GitRunner = (args) => {
      const dest = args[args.length - 1]!;
      execFileSync("git", ["clone", "--depth", "1", "--", `file://${repo.replace(/\\/g, "/")}`, dest], { stdio: "pipe" });
      return { status: 0 };
    };
    const baseDir = join(root, "base");
    const outcome = await installPlugin("https://user:secret123@example.com/repo.git", {
      baseDir,
      opts: { runGit: runner, env: { ...process.env }, tmpRoot: root },
    });
    expect(outcome.ok).toBe(true);
    const doc = readFileSync(join(baseDir, "plugins.json"), "utf8");
    expect(doc).not.toContain("secret123");
    expect(doc).toContain("user:***@example.com");
  });
  it("redactUrlCredentials：无 userinfo 原样；git@host: 形（scp 式）原样", () => {
    expect(redactUrlCredentials("https://example.com/repo.git")).toBe("https://example.com/repo.git");
    expect(redactUrlCredentials("git@github.com:example/repo.git")).toBe("git@github.com:example/repo.git");
    expect(redactUrlCredentials("https://user:secret@example.com/r.git")).toBe("https://user:***@example.com/r.git");
  });
});
