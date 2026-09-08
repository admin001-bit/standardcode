// WP-09 guard-path 单测：元数据隐式保护/高危路径/S-9 强制确认/祖先禁重命名/无沙箱依赖导入。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIGH_RISK_PATHS,
  PERSISTENCE_PATH_FRAGMENTS,
  PROTECTED_METADATA_NAMES,
  ancestryContainsProtected,
  checkToolInput,
  guardPath,
  isHighRiskPath,
  isPersistencePath,
  isProtectedMetadataName,
} from "../src/guard-path.ts";

const CWD = "D:\\work\\proj";

describe("protected metadata names (Codex PROTECTED_METADATA_PATH_NAMES 同构)", () => {
  it("exact basename match only (.git/.agents/.standardcode)", () => {
    expect(PROTECTED_METADATA_NAMES).toEqual([".git", ".agents", ".standardcode"]);
    expect(isProtectedMetadataName(".git")).toBe(true);
    expect(isProtectedMetadataName(".standardcode")).toBe(true);
    expect(isProtectedMetadataName(".gitignore")).toBe(false); // 非整名，不误伤
    expect(isProtectedMetadataName("my.git")).toBe(false);
  });

  it("write into metadata dir stopped (implicit protection, no explicit allow in M1)", () => {
    expect(guardPath({ target: "D:\\work\\proj\\.standardcode\\settings.json", cwd: CWD, operation: "write" })).toMatchObject({ action: "stop", rule: "protected-metadata" });
    expect(guardPath({ target: "D:\\work\\proj\\.git\\config", cwd: CWD, operation: "write" })).toMatchObject({ action: "stop", rule: "protected-metadata" });
    expect(guardPath({ target: "settings.json", cwd: CWD, operation: "write" })).toMatchObject({ action: "pass" });
  });

  it("ancestor rename stopped (Codex 祖先禁重命名)", () => {
    expect(guardPath({ target: "D:\\work\\renamed-git", cwd: CWD, operation: "rename", source: "D:\\work\\proj\\.git" })).toMatchObject({ action: "stop", rule: "metadata-ancestor-rename" });
    expect(guardPath({ target: "D:\\other\\.standardcode-x", cwd: CWD, operation: "rename", source: "D:\\work\\proj\\.standardcode\\sub" })).toMatchObject({ action: "stop", rule: "metadata-ancestor-rename" });
    expect(guardPath({ target: "D:\\work\\proj\\src", cwd: CWD, operation: "rename", source: "D:\\work\\proj\\lib" })).toMatchObject({ action: "pass" });
  });

  it("ancestryContainsProtected", () => {
    expect(ancestryContainsProtected("D:\\work\\.standardcode\\projects\\x")).toBe(true);
    expect(ancestryContainsProtected("D:\\work\\.standardcode-2\\x")).toBe(false);
  });
});

describe("high-risk paths (EXE-020)", () => {
  it("C:\\Windows 等系统目录 stop；子目录同样 stop", () => {
    expect(HIGH_RISK_PATHS).toContain("C:\\Windows");
    expect(isHighRiskPath("C:\\Windows\\System32\\cmd.exe")).toBe(true);
    expect(isHighRiskPath("C:\\Windows")).toBe(true);
    expect(guardPath({ target: "C:\\Windows\\Temp\\x.txt", cwd: CWD, operation: "write" })).toMatchObject({ action: "stop", rule: "high-risk-path" });
  });

  it("非系统路径 pass（含形似前缀不误伤）", () => {
    expect(isHighRiskPath("C:\\WindowsOVERRIDE\\x")).toBe(false);
    expect(isHighRiskPath("D:\\data\\Windows Notes\\a.txt")).toBe(false);
  });
});

describe("S-9 persistence paths (强制确认且 Auto 不豁免——护栏只产出 confirm 语义)", () => {
  it("清单覆盖 §11 原文类别：shell rc/PowerShell profile/cron/git hooks/系统守护", () => {
    expect(PERSISTENCE_PATH_FRAGMENTS).toContain(".bashrc");
    expect(PERSISTENCE_PATH_FRAGMENTS).toContain("WindowsPowerShell");
    expect(PERSISTENCE_PATH_FRAGMENTS).toContain("crontab");
    expect(PERSISTENCE_PATH_FRAGMENTS).toContain(".git/hooks");
  });

  it("hit → confirm（非 stop/pass），Auto 模式不豁免由 evaluate 侧保证", () => {
    expect(isPersistencePath("C:\\Users\\u\\.bashrc")).toBe(true);
    expect(guardPath({ target: "C:\\Users\\u\\Documents\\WindowsPowerShell\\profile.ps1", cwd: CWD, operation: "write" })).toMatchObject({ action: "confirm", rule: "persistence-path" });
    expect(guardPath({ target: "D:\\repo\\.git\\hooks\\pre-commit", cwd: CWD, operation: "write" })).toMatchObject({ action: "confirm", rule: "persistence-path" });
  });
});

describe("checkToolInput (工具层权威判定适配)", () => {
  it("写面：Write/Edit 落 guardPath；Bash 扫描命令 token（双保险第二层）", () => {
    expect(checkToolInput("Write", { file_path: "D:\\work\\proj\\.standardcode\\s.json", content: "x" }, CWD)).toMatchObject({ action: "stop", rule: "protected-metadata" });
    expect(checkToolInput("Bash", { command: "rm -rf .git" }, CWD)).toMatchObject({ action: "stop", rule: "protected-metadata" });
    expect(checkToolInput("Bash", { command: "echo x > C:\\Windows\\Temp\\evil.txt" }, CWD)).toMatchObject({ action: "stop", rule: "high-risk-path" });
    expect(checkToolInput("Bash", { command: "echo >> ~/.bashrc" }, CWD)).toMatchObject({ action: "confirm", rule: "persistence-path" });
  });

  it("读面不拦（EXE-020 针对写/执行面）；能力外工具 pass", () => {
    expect(checkToolInput("Read", { file_path: "D:\\work\\.git\\config" }, CWD)).toMatchObject({ action: "pass" });
    expect(checkToolInput("Mcp__x__y", {}, CWD)).toMatchObject({ action: "pass" });
  });
});

describe("independence (DoD④): no sandbox imports", () => {
  it("guard-path.ts imports only node builtins", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/guard-path.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/sandbox/i);
    expect(src).not.toMatch(/@standardcode\/(executor|capabilities|harness|providers)/);
  });
});

// WP-07：S-9"PATH 内脚本"并入 EXE-020 清单（M1 WP-09 跑偏②闭环）。
describe("S-9 PATH 内脚本（WP-07）", () => {
  it("写入目标落在 PATH 目录内 → confirm（Auto 不豁免语义不变）", () => {
    const pathDir = join(tmpdir(), "stdcode-pathprobe");
    mkdirSync(pathDir, { recursive: true });
    const v = guardPath({ target: join(pathDir, "evil.cmd"), cwd: tmpdir(), operation: "write", env: { PATH: pathDir } });
    expect(v.action).toBe("confirm");
    expect(v.rule).toBe("persistence-path");
    // 大小写/斜杠形态归一命中（Windows）
    const v2 = guardPath({ target: join(pathDir, "sub", "..", "tool.exe"), cwd: tmpdir(), operation: "write", env: { Path: pathDir } });
    expect(v2.action).toBe("confirm");
  });

  it("非 PATH 目录写入不受新类影响；全局包管理器安装命令按 PATH 脚本类确认", () => {
    const elsewhere = join(tmpdir(), "stdcode-not-in-path");
    expect(guardPath({ target: join(elsewhere, "x.txt"), cwd: tmpdir(), operation: "write" }).action).toBe("pass");
    expect(checkToolInput("Bash", { command: "npm install -g left-pad" }, tmpdir()).action).toBe("confirm");
    expect(checkToolInput("Bash", { command: "npm install" }, tmpdir()).action).toBe("pass");
  });
});
