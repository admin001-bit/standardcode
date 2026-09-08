// WP-09 rework（ADR-0032 决策 1 勘误：自实现 diff 引擎）测试。
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diffLines, unifiedDiff, sessionDiff } from "../src/diff.ts";
import { FileHistoryStoreImpl } from "../src/file-history.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-diff-"));
}

describe("diffLines（LCS）", () => {
  it("纯增/纯删/相同→空差异；交错变更 hunk 正确", () => {
    expect(diffLines([], ["a"])).toEqual([{ op: "add", text: "a", bIdx: 0 }]);
    expect(diffLines(["a"], [])).toEqual([{ op: "del", text: "a", aIdx: 0 }]);
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([
      { op: "ctx", text: "a", aIdx: 0, bIdx: 0 },
      { op: "ctx", text: "b", aIdx: 1, bIdx: 1 },
    ]);
    const d = diffLines(["a", "x", "c"], ["a", "y", "c"]);
    expect(d).toEqual([
      { op: "ctx", text: "a", aIdx: 0, bIdx: 0 },
      { op: "del", text: "x", aIdx: 1 },
      { op: "add", text: "y", bIdx: 1 },
      { op: "ctx", text: "c", aIdx: 2, bIdx: 2 },
    ]);
  });

  it("公共前后缀削减：中间变更不影响首尾 ctx", () => {
    const d = diffLines(["h1", "h2", "old", "t1"], ["h1", "h2", "new", "t1"]);
    expect(d[0]).toMatchObject({ op: "ctx", text: "h1", aIdx: 0, bIdx: 0 });
    expect(d[d.length - 1]).toMatchObject({ op: "ctx", text: "t1", aIdx: 3, bIdx: 3 });
  });
});

describe("unifiedDiff", () => {
  it("无差异→空串；有差异→---/+++头+@@ hunk+±行", () => {
    expect(unifiedDiff("f", "a\nb\n", "f", "a\nb\n")).toBe("");
    const out = unifiedDiff("f.txt", "a\nold\nc\n", "f.txt", "a\nnew\nc\n");
    expect(out).toContain("--- a/f.txt");
    expect(out).toContain("+++ b/f.txt");
    expect(out).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(out).toContain("-old");
    expect(out).toContain("+new");
    expect(out).toContain(" a");
  });

  it("新建文件（基线空）与删除文件（当前空）", () => {
    const add = unifiedDiff("n.txt", "", "n.txt", "l1\nl2\n");
    expect(add).toContain("+l1");
    const del = unifiedDiff("d.txt", "x\n", "d.txt", "");
    expect(del).toContain("-x");
  });
});

describe("unifiedDiff hunk 组装回归（V 第二轮退回三形态）", () => {
  it("T8 常见形态：20 行文件改末行 → 单 hunk @@ -17,4 +17,4 @@", () => {
    const a = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    const b = a.replace("L20", "XX");
    const out = unifiedDiff("f.txt", a, "f.txt", b);
    expect(out).toContain("@@ -17,4 +17,4 @@");
    expect(out).not.toContain("@@ -29"); // 行号越界（初版缺陷）
    expect((out.match(/^@@/gm) ?? []).length).toBe(1); // 单 hunk（初版 5 个伪 hunk）
    expect(out).toContain("-L20");
    expect(out).toContain("+XX");
    expect(out).toContain(" L17");
  });

  it("M1 变更间恰 7 行 ctx → 两 hunk 无重叠（各含 3 行边界 ctx）", () => {
    const a = ["c1", "old", ...Array.from({ length: 7 }, (_, i) => `g${i + 1}`), "old2", "c9"].join("\n");
    const b = a.replace("old", "new").replace("old2", "new2");
    const out = unifiedDiff("f.txt", a, "f.txt", b);
    const heads = (out.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g) ?? []);
    expect(heads.length).toBe(2);
    // 行号解析无重叠：hunk2 起点在 hunk1 终点之后
    const [h1a, h2a] = heads.map((h) => Number(/@@ -(\d+)/.exec(h)![1]!));
    const [h1n] = [Number(/@@ -\d+,(\d+)/.exec(heads[0]!)![1]!)];
    expect(h2a).toBeGreaterThanOrEqual(h1a + h1n);
  });

  it("T2 尾随 ctx >3 → 保留恰 3 行（初版整段丢失）", () => {
    const a = ["old", "l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const b = ["new", "l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const out = unifiedDiff("f.txt", a, "f.txt", b);
    expect(out).toContain(" l1");
    expect(out).toContain(" l2");
    expect(out).toContain(" l3");
    expect(out).not.toContain(" l4"); // 尾随 ctx cap=3（l1..l3）：l4..l7 丢弃
  });

  it("git --no-index oracle 对质（三形态 body 一致；无 git 环境跳过）", () => {
    const g = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (g.status !== 0) return; // 无 git 环境跳过
    const dir = tmp();
    const NL = String.fromCharCode(10);
    try {
      const cases: Array<{ name: string; a: string; b: string }> = [
        { name: "t8", a: Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join(NL) + NL, b: Array.from({ length: 20 }, (_, i) => (i === 19 ? "XX" : `L${i + 1}`)).join(NL) + NL },
        { name: "gap7", a: ["c1", "old", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "old2", "c9"].join(NL) + NL, b: ["c1", "new", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "new2", "c9"].join(NL) + NL },
        { name: "tail3", a: ["old", "l1", "l2", "l3", "l4", "l5", "l6", "l7"].join(NL) + NL, b: ["new", "l1", "l2", "l3", "l4", "l5", "l6", "l7"].join(NL) + NL },
      ];
      for (const c of cases) {
        const fa = path.join(dir, `${c.name}-a.txt`);
        const fb = path.join(dir, `${c.name}-b.txt`);
        writeFileSync(fa, c.a, "utf8");
        writeFileSync(fb, c.b, "utf8");
        const r = spawnSync("git", ["diff", "--no-index", "--", fa, fb], { encoding: "utf8" });
        const gitBody = (r.stdout ?? "").split(NL).map((l) => l.replace(/\r$/, "")).filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join(NL).trim();
        const ours = unifiedDiff(fa, c.a, fb, c.b).split(NL).slice(2).join(NL).trim();
        // git 的 hunk 头带"变更前一行"函数上下文（@@ ... @@ L16）；[CC] 口径，我们无此前缀——对质剥 git 的函数上下文
        const gitNorm = gitBody.replace(/^(@@ [^@]*@@).*$/gm, "$1");
        expect(ours).toBe(gitNorm); // 逐字对质（@@ 头剥函数上下文后 + body）
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionDiff（/diff 数据面）", () => {
  it("会话文件变更面：基线=首快照存档；新建=空基线；未变更不计", async () => {
    const base = tmp();
    const proj = tmp();
    const a = path.join(proj, "a.txt");
    writeFileSync(a, "v0");
    const store = await FileHistoryStoreImpl.create(proj, base);
    await store.snapshot("Write", a); // a 基线 v0
    writeFileSync(a, "v1");
    const b = path.join(proj, "b.txt");
    await store.snapshot("Write", b); // b 新建（existed=false）
    writeFileSync(b, "b1");
    const unchanged = path.join(proj, "c.txt");
    writeFileSync(unchanged, "same");
    await store.snapshot("Write", unchanged); // c 快照后未再写
    const r = await sessionDiff(store);
    expect(r.changed).toBe(2); // a、b
    expect(r.output).toContain("a.txt");
    expect(r.output).toContain("-v0");
    expect(r.output).toContain("+v1");
    expect(r.output).toContain("+b1"); // 新建文件全为 +
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("存档缺失→跳过不猜；空索引→零扫描", async () => {
    const base = tmp();
    const proj = tmp();
    const store = await FileHistoryStoreImpl.create(proj, base);
    const empty = await sessionDiff(store);
    expect(empty.scanned).toBe(0);
    expect(empty.changed).toBe(0);
    // 损坏存档
    const f = path.join(proj, "f.txt");
    writeFileSync(f, "v0");
    await store.snapshot("Write", f);
    rmSync(path.join(store.dir, (await store.records())[0]!.storedAs), { force: true });
    const r = await sessionDiff(store);
    expect(r.skipped).toEqual([f]);
    expect(r.changed).toBe(0);
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });
});
