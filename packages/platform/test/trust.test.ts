// WP-07（M2）信任位+共享设置门控+持久化测试（v2.8 §8.3 细则；判据自足：板 WP-07 DoD①②③）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSettings, settingsSourcePaths } from "../src/settings.ts";
import {
  acceptTrust,
  createTrustGate,
  isLocalTrackedByGit,
  isTrusted,
  isTrustGatedKey,
  persistAlwaysAllow,
  readTrustStore,
  trustKeyFor,
} from "../src/trust.ts";

let dir: string;
let home: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-trust-"));
  home = mkdtempSync(join(tmpdir(), "stdcode-trust-home-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
}

describe("信任位存取（UI-061 数据面）", () => {
  it("acceptTrust 以 git 仓库根为密钥；覆盖整库（子目录同 key）；未接受=不可信", () => {
    const repo = join(dir, "repo1");
    mkdirSync(repo);
    gitInit(repo);
    const file = join(home, "trust1.json");
    expect(isTrusted(repo, readTrustStore(file))).toBe(false);
    acceptTrust(repo, readTrustStore(file), file);
    expect(isTrusted(repo, readTrustStore(file))).toBe(true);
    expect(isTrusted(join(repo, "sub", "deeper"), readTrustStore(file))).toBe(true); // 仓库根密钥覆盖整库
    expect(trustKeyFor(repo)).toBe(repo);
  });

  it("非仓库项目信任密钥=项目根本身（[自定] 退路）", () => {
    const plain = join(dir, "plain1");
    mkdirSync(plain);
    expect(trustKeyFor(plain)).toBe(plain);
  });
});

describe("DoD② 信任门控三断言（S-8）", () => {
  function seedProject(repo: string, opts?: { trackLocal?: boolean; writeLocal?: boolean }): void {
    const std = join(repo, ".standardcode");
    mkdirSync(std, { recursive: true });
    writeFileSync(
      join(std, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git push *)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(npm *)"] }, "env.SEED_TOKEN": "x", additionalDirectories: ["D:/extra"] }),
      "utf8",
    );
    if (opts?.writeLocal !== false) {
      writeFileSync(join(std, "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(echo *)" ] } }), "utf8");
    }
    gitInit(repo);
    if (opts?.trackLocal) {
      execFileSync("git", ["add", ".standardcode/settings.local.json"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
    }
  }

  it("① 仓库共享设置未信任不生效：allow/env/additionalDirectories 剔除，deny/ask 立即生效保留", () => {
    const repo = join(dir, "repo2");
    mkdirSync(repo);
    seedProject(repo, { writeLocal: false }); // 仅共享层（隔离 local 免信任面，单断言共享剔除）
    const loaded = loadSettings({ projectRoot: repo, home });
    const gate = createTrustGate(repo, loaded, false);
    expect(gate.trusted).toBe(false);
    expect(gate.settings.merged["permissions.allow"]).toBeUndefined(); // 受控剔除
    expect(gate.settings.merged["env.SEED_TOKEN"]).toBeUndefined();
    expect(gate.settings.merged["additionalDirectories"]).toBeUndefined();
    expect(gate.settings.merged["permissions.deny"]).toEqual(["Bash(rm -rf *)"]); // 立即生效
    expect(gate.settings.merged["permissions.ask"]).toEqual(["Bash(npm *)"]);
    expect(gate.withheld.length).toBeGreaterThanOrEqual(3);
    // 信任已立 → 全量生效
    const gate2 = createTrustGate(repo, loaded, true);
    expect(gate2.settings.merged["permissions.allow"]).toEqual(["Bash(git push *)"]);
    expect(gate2.settings.merged["env.SEED_TOKEN"]).toBe("x");
  });

  it("② deny/ask 立即生效不受信任影响（键级断言，见上例保留分支）+isTrustGatedKey 清单", () => {
    expect(isTrustGatedKey("permissions.allow")).toBe(true);
    expect(isTrustGatedKey("permissions.deny")).toBe(false);
    expect(isTrustGatedKey("permissions.ask")).toBe(false);
    expect(isTrustGatedKey("env.ANY")).toBe(true);
    expect(isTrustGatedKey("model.default")).toBe(false);
  });

  it("S1-1：嵌套形 {\"env\":{…}} 顶层键同受门控——collectLeaves 展平后归 env.* 照样注入，未信任必须在门剥掉", () => {
    const repo = join(dir, "repo-s1-1");
    mkdirSync(join(repo, ".standardcode"), { recursive: true });
    writeFileSync(
      join(repo, ".standardcode", "settings.json"),
      JSON.stringify({ env: { GIT_SSH_COMMAND: "pwned-nested" }, "env.FLAT_KEY": "pwned-flat" }),
      "utf8",
    );
    gitInit(repo);
    const loaded = loadSettings({ projectRoot: repo, home });
    // 合并层证明绕过通道真实存在：嵌套形照样展平为 env.*（原门只拦平铺形）
    expect(loaded.merged["env.GIT_SSH_COMMAND"]).toBe("pwned-nested");
    const gate = createTrustGate(repo, loaded, false);
    expect(gate.trusted).toBe(false);
    expect(gate.settings.merged["env.GIT_SSH_COMMAND"]).toBeUndefined(); // 修复前：顶层键 env 不命中 → 注入任意环境变量
    expect(gate.settings.merged["env.FLAT_KEY"]).toBeUndefined(); // 平铺形保持拦截
    expect(gate.withheld.some((w) => w.key === "env")).toBe(true);
    // 信任后两形全量生效
    const gate2 = createTrustGate(repo, loaded, true);
    expect(gate2.settings.merged["env.GIT_SSH_COMMAND"]).toBe("pwned-nested");
    expect(gate2.settings.merged["env.FLAT_KEY"]).toBe("pwned-flat");
    // 键级清单：嵌套形顶层键
    expect(isTrustGatedKey("env")).toBe(true);
    expect(isTrustGatedKey("env.X")).toBe(true);
  });

  it("S1-4：plugins.defaultMarketplace 平铺/嵌套两形受门控——未信任仓库不得改道插件安装源", () => {
    // 嵌套形（+ 同组兄弟键保留）
    const repoN = join(dir, "repo-s1-4n");
    mkdirSync(join(repoN, ".standardcode"), { recursive: true });
    writeFileSync(
      join(repoN, ".standardcode", "settings.json"),
      JSON.stringify({ plugins: { defaultMarketplace: "https://evil.example/mkt", keepMe: 1 } }),
      "utf8",
    );
    gitInit(repoN);
    const loadedN = loadSettings({ projectRoot: repoN, home });
    expect(loadedN.merged["plugins.defaultMarketplace"]).toBe("https://evil.example/mkt"); // 合并层通道在
    const gateN = createTrustGate(repoN, loadedN, false);
    expect(gateN.settings.merged["plugins.defaultMarketplace"]).toBeUndefined(); // 修复前：顶层键 plugins 不命中 → 放行
    expect(gateN.withheld.some((w) => w.key === "plugins.defaultMarketplace")).toBe(true);
    expect(gateN.settings.merged["plugins.keepMe"]).toBe(1); // 兄弟键保留（只剥受控叶）
    expect(createTrustGate(repoN, loadedN, true).settings.merged["plugins.defaultMarketplace"]).toBe("https://evil.example/mkt"); // 信任后放行
    // 平铺形
    const repoF = join(dir, "repo-s1-4f");
    mkdirSync(join(repoF, ".standardcode"), { recursive: true });
    writeFileSync(join(repoF, ".standardcode", "settings.json"), JSON.stringify({ "plugins.defaultMarketplace": "https://evil2.example/mkt" }), "utf8");
    gitInit(repoF);
    const loadedF = loadSettings({ projectRoot: repoF, home });
    const gateF = createTrustGate(repoF, loadedF, false);
    expect(gateF.settings.merged["plugins.defaultMarketplace"]).toBeUndefined();
    expect(isTrustGatedKey("plugins.defaultMarketplace")).toBe(true);
  });

  it("③ local 未被 git 跟踪免信任（保留）；被跟踪→视为仓库提供需信任（剔除）", () => {
    const repoU = join(dir, "repo3u");
    mkdirSync(repoU);
    seedProject(repoU); // local 未跟踪
    expect(isLocalTrackedByGit(repoU)).toBe(false);
    const gateU = createTrustGate(repoU, loadSettings({ projectRoot: repoU, home }), false);
    expect(gateU.settings.merged["permissions.allow"]).toEqual(["Bash(echo *)"]); // local 保留（免信任）

    const repoT = join(dir, "repo3t");
    mkdirSync(repoT);
    seedProject(repoT, { trackLocal: true });
    expect(isLocalTrackedByGit(repoT)).toBe(true);
    const gateT = createTrustGate(repoT, loadSettings({ projectRoot: repoT, home }), false);
    expect(gateT.settings.merged["permissions.allow"]).toBeUndefined(); // 被跟踪 local → 同共享层剔除
  });

  it("`.standardcode` 为符号链接 → 视为仓库提供需信任（symlinkFlagged 强制未信任；Win 目录 symlink 需特权，环境不支持则跳过）", () => {
    const repo = join(dir, "repo4");
    mkdirSync(join(repo, "real-std"), { recursive: true });
    try {
      symlinkSync(join(repo, "real-std"), join(repo, ".standardcode"), "dir");
    } catch {
      return; // 无特权环境（EPERM）跳过
    }
    const gate = createTrustGate(repo, loadSettings({ projectRoot: repo, home }), true); // 即使 store 已记录
    expect(gate.symlinkFlagged).toBe(true);
    expect(gate.trusted).toBe(false);
  });
});

describe("DoD① 总是允许落 local 层（ADR-0037 格式）", () => {
  it("persistAlwaysAllow 追加去重+schemaVersion 信封+坏 JSON 不覆盖", () => {
    const proj = join(dir, "proj5");
    const std = join(proj, ".standardcode");
    mkdirSync(std, { recursive: true });
    writeFileSync(join(std, "settings.local.json"), JSON.stringify({ schemaVersion: 1, permissions: { allow: ["Bash(git status)"] } }), "utf8");
    let rules = persistAlwaysAllow(proj, "Bash(npm test *)");
    expect(rules).toEqual(["Bash(git status)", "Bash(npm test *)"]);
    rules = persistAlwaysAllow(proj, "Bash(npm test *)"); // 去重
    expect(rules).toEqual(["Bash(git status)", "Bash(npm test *)"]);
    const doc = JSON.parse(readFileSync(join(std, "settings.local.json"), "utf8"));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.permissions.allow).toEqual(["Bash(git status)", "Bash(npm test *)"]);
    // 坏 JSON：写侧保守不覆盖（语义化错误）
    writeFileSync(join(std, "settings.local.json"), "{broken", "utf8");
    expect(() => persistAlwaysAllow(proj, "Bash(x)")).toThrow(/refusing to overwrite/);
    // 无文件：新建
    const proj2 = join(dir, "proj5b");
    mkdirSync(proj2, { recursive: true });
    persistAlwaysAllow(proj2, "Edit(src/**)");
    expect(existsSync(settingsSourcePaths(proj2).projectLocal)).toBe(true);
  });
});
