// WP-08（M3）SEC-080 工具子进程 env 清洗（DoD①②，executor 层）。
// 判据自足（板 WP-08 DoD）：①STANDARD_CODE_*/_KEY/_TOKEN/_SECRET/BASH_ENV/ENV/GIT_CONFIG_*/NODE_OPTIONS 逐键剔除
// ②API key 不进子进程 env（真子进程回读实证）。规格=§11 SEC-080 原文。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, sanitizeToolEnv } from "../src/index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-wp08-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sanitizeToolEnv 规则面（DoD① 逐键剔除）", () => {
  it("八类键逐一剔除；PATH/HOME/普通键保留；removed/strippedBy 归因可查", () => {
    const snap = sanitizeToolEnv({
      STANDARD_CODE_MODEL: "m-a",
      STANDARD_CODE_AUTO_COMPACT_WINDOW: "150000",
      ANTHROPIC_API_KEY: "sk-ant-probe",
      OPENAI_API_KEY: "sk-probe",
      GITHUB_TOKEN: "ghp_probe",
      AWS_SECRET_ACCESS_KEY: "wJal-probe", // 尾 _KEY 命中 key-suffix（先于 secret 规则——归因顺序=规则表序）
      CLIENT_SECRET: "sec-probe",
      BASH_ENV: "/tmp/evil",
      ENV: "evil",
      GIT_CONFIG_GLOBAL: "/tmp/gitcfg",
      GIT_CONFIG_COUNT: "1",
      NODE_OPTIONS: "--require evil.js",
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      KEEP_ME: "v",
    });
    expect(Object.keys(snap.env).sort()).toEqual(["HOME", "KEEP_ME", "PATH"]);
    for (const name of [
      "STANDARD_CODE_MODEL", "STANDARD_CODE_AUTO_COMPACT_WINDOW", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "CLIENT_SECRET", "BASH_ENV", "ENV",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "NODE_OPTIONS",
    ]) {
      expect(snap.removed).toContain(name);
    }
    const ruleOf = (name: string) => snap.strippedBy[snap.removed.indexOf(name)];
    expect(ruleOf("STANDARD_CODE_MODEL")).toBe("standardcode-channel");
    expect(ruleOf("ANTHROPIC_API_KEY")).toBe("key-suffix");
    expect(ruleOf("GITHUB_TOKEN")).toBe("token-suffix");
    expect(ruleOf("CLIENT_SECRET")).toBe("secret-suffix");
    expect(ruleOf("BASH_ENV")).toBe("bash-injection");
    expect(ruleOf("ENV")).toBe("bash-injection");
    expect(ruleOf("GIT_CONFIG_GLOBAL")).toBe("git-config");
    expect(ruleOf("NODE_OPTIONS")).toBe("node-options");
    expect(snap.removed.length).toBe(12);
  });

  it("大小写不敏感剔除（Windows env 名语义，取严 fail-closed）；undefined 值键不入下发 env 亦不算剔除", () => {
    const snap = sanitizeToolEnv({ node_options: "--x", Env: "y", BASH_env: "z", Path: "/p", EMPTY: undefined });
    expect(snap.env).toEqual({ Path: "/p" });
    expect(snap.removed.sort()).toEqual(["BASH_env", "Env", "node_options"]);
  });
});

describe("runProcess 下发面（DoD② 真子进程实证）", () => {
  it("隐式缺省=现场清洗：API key/STANDARD_CODE_*/注入键不进子进程 env；快照 debug 通道归因在位", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedProbe = process.env.STANDARD_CODE_WP08_PROBE;
    process.env.ANTHROPIC_API_KEY = "sk-ant-wp08-probe";
    process.env.STANDARD_CODE_WP08_PROBE = "probe";
    try {
      const r = await runProcess({
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.env))"],
        cwd: dir,
      });
      expect(r.code).toBe(0);
      const child = JSON.parse(r.stdout.trim()) as Record<string, string>;
      // API key 绝不下沉（SEC-080"提示注入诱导 printenv 即可外传的裸奔面"闭合）
      expect(child.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child.STANDARD_CODE_WP08_PROBE).toBeUndefined();
      expect(child.NODE_OPTIONS).toBeUndefined();
      expect(child.BASH_ENV).toBeUndefined();
      expect(Object.keys(child).some((k) => /^STANDARD_CODE_/i.test(k))).toBe(false);
      expect(Object.keys(child).some((k) => /_(KEY|TOKEN|SECRET)$/i.test(k))).toBe(false);
      expect(Object.keys(child).some((k) => /^GIT_CONFIG_/i.test(k))).toBe(false);
      // 保留面：PATH 类基底在（cmd/rg/node 可解析）
      expect(child.PATH ?? child.Path).toBeTruthy();
      // debug 快照通道：剔除归因可查（removed 含探针键；规则 id 对应）
      expect(r.envSnapshot.removed).toContain("ANTHROPIC_API_KEY");
      expect(r.envSnapshot.strippedBy[r.envSnapshot.removed.indexOf("STANDARD_CODE_WP08_PROBE")]).toBe("standardcode-channel");
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedProbe === undefined) delete process.env.STANDARD_CODE_WP08_PROBE;
      else process.env.STANDARD_CODE_WP08_PROBE = savedProbe;
    }
  }, 30_000);

  it("显式 env 覆盖下发（显式 > 隐式）；快照按现状记录", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({probe: process.env.WP08_EXPLICIT ?? '', hasPath: !!(process.env.PATH ?? process.env.Path)}))"],
      env: { WP08_EXPLICIT: "kept", PATH: process.env.PATH ?? process.env.Path },
      cwd: dir,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ probe: "kept", hasPath: true });
    expect(r.envSnapshot.removed).toEqual([]);
  }, 30_000);
});
