// WP-09 rework（ADR-0032 决策 1 勘误：自实现 diff 引擎）测试。
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diffLines, unifiedDiff, sessionDiff } from "../src/diff.ts";
import { FileHistoryStoreImpl } from "../src/file-history.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-diff-"));
}

describe("diffLines（LCS）", () => {
  it("纯增/纯删/相同→空差异；交错变更 hunk 正确", () => {
    expect(diffLines([], ["a"])).toEqual([{ op: "add", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ op: "del", text: "a" }]);
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([
      { op: "ctx", text: "a" },
      { op: "ctx", text: "b" },
    ]);
    const d = diffLines(["a", "x", "c"], ["a", "y", "c"]);
    expect(d).toEqual([
      { op: "ctx", text: "a" },
      { op: "del", text: "x" },
      { op: "add", text: "y" },
      { op: "ctx", text: "c" },
    ]);
  });

  it("公共前后缀削减：中间变更不影响首尾 ctx", () => {
    const d = diffLines(["h1", "h2", "old", "t1"], ["h1", "h2", "new", "t1"]);
    expect(d[0]).toEqual({ op: "ctx", text: "h1" });
    expect(d[d.length - 1]).toEqual({ op: "ctx", text: "t1" });
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
