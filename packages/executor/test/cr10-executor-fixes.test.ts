// 批 10 executor 组回归（全仓审查 2026-10-01）：S4-2 grep EAGAIN 自愈双断、S4-5 glob 根错误上抛、
// S4-6 proc 按流截断标记。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGlob, isEagainStderr, runProcess, singleThreadRetryArgs } from "../src/index.ts";
import { ExecError } from "../src/env.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "cr10-exec-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("S4-2 grep EAGAIN 自愈双断修复", () => {
  it("isEagainStderr：rg 真实 strerror 形可命中（原 /EAGAIN/ 与 rg 输出永不相交）", () => {
    expect(isEagainStderr("rg: foo: os error 11 (Resource temporarily unavailable)")).toBe(true);
    expect(isEagainStderr("spawn failed: Resource temporarily unavailable")).toBe(true);
    expect(isEagainStderr("EAGAIN: try again")).toBe(true);
    expect(isEagainStderr("ripgrep rejected the pattern")).toBe(false);
    expect(isEagainStderr("")).toBe(false);
  });
  it("singleThreadRetryArgs：-j 1 插在 -- 之前（原追加尾部＝被 rg 当搜索路径）", () => {
    const args = ["--no-config", "--json", "--", "pat", "/some/path"];
    const retry = singleThreadRetryArgs(args);
    expect(retry).toEqual(["--no-config", "--json", "-j", "1", "--", "pat", "/some/path"]);
    expect(retry.indexOf("-j")).toBeLessThan(retry.indexOf("--"));
    // 无 -- 分隔符的形（防御）仍附尾
    expect(singleThreadRetryArgs(["--no-config"])).toEqual(["--no-config", "-j", "1"]);
  });
});

describe("S4-5 glob 根目录错误上抛（原内层 catch 吞掉致 path not found 成死代码）", () => {
  it("根路径不存在 → path not found（原：no files found，模型无法区分写错路径与无匹配）", async () => {
    await expect(
      execGlob({ pattern: "*.ts", path: path.join(root, "no-such-dir") }, { cwd: root, env: {} }),
    ).rejects.toThrow(/path not found/);
  });
  it("根路径是文件 → path not found（ENOTDIR 同归可诊断形）", async () => {
    const f = path.join(root, "a-file.txt");
    writeFileSync(f, "x");
    await expect(execGlob({ pattern: "*.ts", path: f }, { cwd: root, env: {} })).rejects.toThrow(/path not found/);
  });
  it("正常目录零回归（有匹配/无匹配语义不变）", async () => {
    writeFileSync(path.join(root, "b.ts"), "export {};");
    const hit = await execGlob({ pattern: "*.ts", path: root }, { cwd: root, env: {} });
    expect(hit).toContain("b.ts");
  });
});

describe("S4-6 proc 按流截断标记（原无差别双打——仅 stderr 越界时完整 stdout 被假标）", () => {
  it("仅 stdout 越界：stdout 带标记、stderr 不带 [output truncated]", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('o'.repeat(500)); process.stderr.write('plain-err')"],
      cwd: root,
      maxOutputChars: 100,
    });
    expect(r.truncated).toBe(true); // 对外单布尔契约保持
    expect(r.stdout).toContain("[output truncated]");
    expect(r.stderr).toBe("plain-err"); // 修复前：被追加 [output truncated] 假标
    expect(r.stderr).not.toContain("[stderr truncated]"); // 未越界不打标
  });
  it("仅 stderr 越界：stderr 带 [stderr truncated]、完整 stdout 零假标", async () => {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('clean-out'); process.stderr.write('e'.repeat(500))"],
      cwd: root,
      maxOutputChars: 100,
    });
    expect(r.truncated).toBe(true);
    expect(r.stderr).toContain("[stderr truncated]");
    expect(r.stdout).toBe("clean-out"); // 修复前：被追加 [output truncated] 假标（缺陷原形）
    expect(r.stdout).not.toContain("[output truncated]");
  });
});

describe("防御：ExecError 导出面（env 层）", () => {
  it("ExecError 可用于前置拒（S4-3 形）", () => {
    expect(new ExecError("interrupted").message).toBe("interrupted");
  });
});
