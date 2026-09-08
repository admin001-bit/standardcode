// WP-02（M2）session 记忆接线测试（判据自足：板 WP-02 DoD①——消费面接线）。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-sess-mem-"));
}
function wf(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content, "utf8");
}

describe("createSession 记忆装载（WP-02）", () => {
  it("项目 AGENTS.md 进 session.memory；MEM-043 检测生效（.standardcode 存在→项目层读取）", () => {
    const root = tmp();
    const home = tmp();
    wf(root, "AGENTS.md", "SESSION-MEM-MARKER");
    mkdirSync(path.join(root, ".git")); // 触发项目工作区检测
    const s = createSession({
      cwd: root,
      projectRoot: root,
      home,
      programData: tmp(),
      env: { ANTHROPIC_API_KEY: "sk-x" },
    });
    expect(s.memory.text).toContain("SESSION-MEM-MARKER");
    expect(s.memory.files.some((f) => f.scope === "project")).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("memory.precedence=agents-first 经 settings 生效（ADR-0030 键）", () => {
    const root = tmp();
    const home = tmp();
    // 主文件在目录根（[CC] 同构：CLAUDE.md/AGENTS.md 于项目根；.standardcode/ 只承载 rules/settings）
    wf(root, "CLAUDE.md", "P-CLAUDE");
    wf(root, "AGENTS.md", "P-AGENTS");
    mkdirSync(path.join(root, ".git"));
    const s = createSession({
      cwd: root,
      projectRoot: root,
      home,
      programData: tmp(),
      env: { ANTHROPIC_API_KEY: "sk-x" },
    });
    // 无 settings 键 → 默认 claude-first
    expect(s.memory.text.indexOf("P-CLAUDE")).toBeLessThan(s.memory.text.indexOf("P-AGENTS"));
    wf(path.join(root, ".standardcode"), "settings.json", JSON.stringify({ memory: { precedence: "agents-first" } }));
    const s2 = createSession({
      cwd: root,
      projectRoot: root,
      home,
      programData: tmp(),
      env: { ANTHROPIC_API_KEY: "sk-x" },
    });
    expect(s2.memory.text.indexOf("P-AGENTS")).toBeLessThan(s2.memory.text.indexOf("P-CLAUDE"));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
