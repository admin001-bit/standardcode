// WP-02（M2）记忆用户轨测试（v2.8 §9.1①；判据自足：板 WP-02 DoD①-⑥）。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadMemory,
  detectProjectWorkspace,
  matchGlob,
  MEMORY_IMPORT_MAX_DEPTH,
} from "../src/memory-loader/memory.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-mem-"));
}
function wf(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("WP-02 记忆用户轨", () => {
  it("DoD① 加载序=MEM-011：Managed→User→Project（祖先→cwd）→Local 拼接不覆盖", () => {
    const home = tmp();
    const managed = tmp();
    const root = tmp();
    const cwd = path.join(root, "sub");
    wf(managed, "AGENTS.md", "MANAGED-LAYER");
    wf(path.join(home, ".standardcode"), "AGENTS.md", "USER-LAYER");
    wf(root, "AGENTS.md", "PROJECT-ANCESTOR");
    wf(cwd, "AGENTS.md", "PROJECT-CWD");
    wf(path.join(cwd, ".standardcode"), "AGENTS.local.md", "LOCAL-LAYER");
    const r = loadMemory({ cwd, home, managedDir: managed, inProject: true });
    const order = ["MANAGED-LAYER", "USER-LAYER", "PROJECT-ANCESTOR", "PROJECT-CWD", "LOCAL-LAYER"].map((s) => r.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 拼接顺序保持（不覆盖）
    rmSync(managed, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("DoD② 双读：CLAUDE.md 先 AGENTS.md 后+相同段落去重；precedence 反转", () => {
    const home = tmp();
    const cwd = tmp();
    wf(path.join(home, ".standardcode"), "CLAUDE.md", "Shared para\n\nOnly in claude");
    wf(path.join(home, ".standardcode"), "AGENTS.md", "Shared para\n\nOnly in agents");
    const r1 = loadMemory({ cwd, home, inProject: false });
    expect(r1.text).toContain("Shared para");
    expect(r1.text.indexOf("Only in claude")).toBeLessThan(r1.text.indexOf("Only in agents"));
    expect(r1.text.split("Shared para").length - 1).toBe(1); // 去重
    const r2 = loadMemory({ cwd, home, inProject: false, precedence: "agents-first" });
    expect(r2.text.indexOf("Only in agents")).toBeLessThan(r2.text.indexOf("Only in claude"));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("DoD③ rules paths: glob 过滤（MEM-010）；无 paths 规则始终加载", () => {
    const home = tmp();
    const cwd = tmp();
    wf(path.join(home, ".standardcode", "rules"), "scoped.md", "---\npaths:\n  - \"src/**\"\n---\nSCOPED-RULE");
    wf(path.join(home, ".standardcode", "rules"), "always.md", "ALWAYS-RULE");
    const hit = loadMemory({ cwd, home, inProject: false, relevantPaths: ["src/foo.ts"] });
    expect(hit.text).toContain("SCOPED-RULE");
    expect(hit.text).toContain("ALWAYS-RULE");
    const miss = loadMemory({ cwd, home, inProject: false, relevantPaths: ["docs/x.md"] });
    expect(miss.text).not.toContain("SCOPED-RULE");
    expect(miss.text).toContain("ALWAYS-RULE");
    expect(miss.warnings.some((w) => w.includes("scoped.md"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("DoD④ @import 四规则：fenced 不解析/循环跳过/缺失忽略/深度 5（项目层，import 在 cwd 内）", () => {
    const home = tmp();
    const cwd = tmp();
    // fenced 不解析
    wf(cwd, "CLAUDE.md", "```\n@missing.md\n```\nFENCED-KEEP");
    const rf = loadMemory({ cwd, home, inProject: true });
    expect(rf.text).toContain("FENCED-KEEP");
    expect(rf.text).toContain("@missing.md"); // fence 内原样保留
    // 循环跳过（a→b→a）
    wf(cwd, "CLAUDE.md", "ENTRY\n@cyc-a.md");
    wf(cwd, "cyc-a.md", "CYC-A\n@cyc-b.md");
    wf(cwd, "cyc-b.md", "CYC-B\n@cyc-a.md");
    const rc = loadMemory({ cwd, home, inProject: true });
    expect(rc.warnings.some((w) => w.includes("cycle"))).toBe(true);
    // 缺失忽略
    wf(cwd, "CLAUDE.md", "MISS-TEST\n@no-such-file.md");
    const rm = loadMemory({ cwd, home, inProject: true });
    expect(rm.text).toContain("MISS-TEST");
    expect(rm.warnings.join("\n")).not.toContain("no-such-file"); // 缺失=忽略非告警
    // 深度 5 hops：根文件第 0 层，c1=第 1 跳 … c5=第 5 跳（上限内）、c6 起拒
    expect(MEMORY_IMPORT_MAX_DEPTH).toBe(5);
    for (let i = 1; i <= 7; i++) {
      const next = i < 7 ? `\n@c${i + 1}.md` : "";
      wf(cwd, `c${i}.md`, `LEVEL-${i}${next}`);
    }
    wf(cwd, "CLAUDE.md", "@c1.md");
    const rd = loadMemory({ cwd, home, inProject: true });
    expect(rd.text).toContain("LEVEL-5");
    expect(rd.text).not.toContain("LEVEL-6");
    expect(rd.warnings.some((w) => w.includes("depth limit"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("DoD⑤ 工作目录外 import 无批准→拒绝 fail-closed；批准后注入", () => {
    const home = tmp();
    const cwd = tmp();
    const outside = tmp();
    const ext = wf(outside, "external.md", "EXTERNAL-CONTENT");
    wf(path.join(home, ".standardcode"), "CLAUDE.md", `@${ext}`);
    const denied = loadMemory({ cwd, home, inProject: false });
    expect(denied.text).not.toContain("EXTERNAL-CONTENT");
    expect(denied.deniedImports).toHaveLength(1);
    expect(denied.deniedImports[0].path).toBe(ext);
    const ok = loadMemory({ cwd, home, inProject: false, approvedExternalImports: new Set([ext]) });
    expect(ok.text).toContain("EXTERNAL-CONTENT");
    expect(ok.deniedImports).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("R1 复验回归：用户级 compat 读家目录顶层 ~/.claude ~/.codex（非 ~/.standardcode 内）", () => {
    const home = tmp();
    const cwd = tmp();
    wf(path.join(home, ".standardcode"), "AGENTS.md", "USER-NATIVE");
    wf(path.join(home, ".claude"), "CLAUDE.md", "USER-CLAUDE-COMPAT");
    const r = loadMemory({ cwd, home, inProject: false });
    expect(r.text).toContain("USER-NATIVE");
    expect(r.text).toContain("USER-CLAUDE-COMPAT");
    // 旧错误位置（~/.standardcode/.claude/）不再读取
    wf(path.join(home, ".standardcode", ".claude"), "CLAUDE.md", "WRONG-PLACE");
    const r2 = loadMemory({ cwd, home, inProject: false });
    expect(r2.text).not.toContain("WRONG-PLACE");
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("matchGlob 直测（V O2）：**/**/ 单星/问号/链序缺陷回归", () => {
    expect(matchGlob("src/**", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchGlob("**/x.md", "docs/deep/x.md")).toBe(true);
    expect(matchGlob("**/x.md", "x.md")).toBe(true); // 零段
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false); // 单星不跨段
    expect(matchGlob("a?c.md", "abc.md")).toBe(true);
    expect(matchGlob("a?c.md", "ac.md")).toBe(false);
    expect(matchGlob("docs/**", "docs")).toBe(false); // 无尾内容不匹配（保守）
  });

  it("DoD⑥ MEM-043：inProject=false 跳过项目层；detectProjectWorkspace 标记检测", () => {
    const home = tmp();
    const cwd = tmp();
    wf(cwd, "AGENTS.md", "PROJECT-ONLY");
    expect(loadMemory({ cwd, home, inProject: false }).text).not.toContain("PROJECT-ONLY");
    expect(loadMemory({ cwd, home, inProject: true }).text).toContain("PROJECT-ONLY");
    // 检测器：.git 存在→true；空目录→false
    const withGit = tmp();
    mkdirSync(path.join(withGit, ".git"));
    expect(detectProjectWorkspace(withGit)).toBe(true);
    expect(detectProjectWorkspace(tmp())).toBe(false);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(withGit, { recursive: true, force: true });
  });
});
