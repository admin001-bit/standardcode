// WP-08（M3）checkpoint 写入持锁（DoD④）：file-history 快照经 SessionLock.acquireIn 复用（M2 WP-08 头注
// "checkpoint 加锁同构"的清偿位）。判据自足：①持锁期写入拒绝（互斥为真）②写毕锁释放③跨实例锁内重读 seq 单调。
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileHistoryStoreImpl, FILE_HISTORY_LOCK_FILE } from "../src/file-history.ts";
import { SessionLock } from "../src/session-store.ts";

function tmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `sc-wp08-${label}-`));
}

describe("WP-08 checkpoint 写入持锁（DoD④）", () => {
  it("持锁期 snapshot 拒绝（session lock held）；释放后成功；写毕锁文件不在", async () => {
    const base = tmp("base");
    const proj = tmp("proj");
    try {
      const a = join(proj, "a.txt");
      writeFileSync(a, "v0");
      const store = await FileHistoryStoreImpl.create(proj, base);
      const held = await SessionLock.acquireIn(store.dir, FILE_HISTORY_LOCK_FILE);
      await expect(store.snapshot("Write", a)).rejects.toThrow(/session lock held/);
      await held.release();
      expect(await store.snapshot("Write", a)).toBe(1);
      expect(existsSync(join(store.dir, FILE_HISTORY_LOCK_FILE))).toBe(false); // 释放归位（finally）
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("跨实例 seq 单调：实例 A 落快照后，创建在先的第二实例锁内重读索引续号（不撞车）", async () => {
    const base = tmp("base2");
    const proj = tmp("proj2");
    try {
      const a = join(proj, "a.txt");
      writeFileSync(a, "v0");
      const s1 = await FileHistoryStoreImpl.create(proj, base);
      const s2 = await FileHistoryStoreImpl.create(proj, base); // 此刻索引空——s2.seq=0
      await s1.snapshot("Write", a); // s1: seq1
      expect(await s2.snapshot("Edit", a)).toBe(2); // 锁内重读 → 2（旧实现=1 撞车）
      const recs = await s1.records();
      expect(recs.map((r) => r.seq)).toEqual([1, 2]);
      expect(recs.map((r) => r.tool)).toEqual(["Write", "Edit"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("并发争锁 fail-closed：同目录两快照竞逐 → 恰一成、一拒（ADR-0032 决策 5 同口径=工具 error）", async () => {
    const base = tmp("base3");
    const proj = tmp("proj3");
    try {
      const a = join(proj, "a.txt");
      const b = join(proj, "b.txt");
      writeFileSync(a, "va");
      writeFileSync(b, "vb");
      const s1 = await FileHistoryStoreImpl.create(proj, base);
      const s2 = await FileHistoryStoreImpl.create(proj, base);
      const settled = await Promise.allSettled([s1.snapshot("Write", a), s2.snapshot("Write", b)]);
      const ok = settled.filter((r) => r.status === "fulfilled");
      const bad = settled.filter((r) => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(bad.length).toBe(1);
      expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      // 成者落盘、锁释放；败者内存 seq 未越界写索引（索引仅一条）
      const recs = await s1.records();
      expect(recs.length).toBe(1);
      expect(existsSync(join(s1.dir, FILE_HISTORY_LOCK_FILE))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
