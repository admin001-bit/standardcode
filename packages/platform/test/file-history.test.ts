// WP-09（M2）file-history 测试（v2.8 §10 EXE-030/040/041；判据自足：板 WP-09 DoD①-④）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileHistoryStoreImpl, bashWriteTargets } from "../src/file-history.ts";
import { readTranscript } from "../src/transcripts.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-fh-"));
}

describe("WP-09 file-history", () => {
  it("DoD① 写盘前快照三类：Write/Edit 捕获前态；Bash 重定向启发式解析目标", async () => {
    const base = tmp();
    const proj = tmp();
    const a = path.join(proj, "a.txt");
    writeFileSync(a, "v0");
    const store = await FileHistoryStoreImpl.create(proj, base);
    await store.snapshot("Write", a); // seq1: 捕获 v0
    writeFileSync(a, "v1");
    await store.snapshot("Edit", a); // seq2: 捕获 v1
    writeFileSync(a, "v2");
    // Bash 重定向启发式（三类中的 Bash 写盘）
    expect(bashWriteTargets("echo hi > out.txt")).toEqual(["out.txt"]);
    expect(bashWriteTargets("echo hi >> log.txt && cmd 2> err.txt")).toEqual(["log.txt"]); // 2> 实为写盘但启发式漏（前缀数字无边界）——偏差②形状外漏示例
    expect(bashWriteTargets("tee -a append.txt")).toEqual(["append.txt"]);
    expect(bashWriteTargets("cat < in.txt")).toEqual([]); // 输入重定向不写盘
    const b = path.join(proj, "b.txt");
    for (const t of bashWriteTargets(`echo x > ${b.replace(/\\/g, "/")}`)) await store.snapshot("Bash", t); // seq3: b 不存在
    expect(store.maxSeq()).toBe(3);
    const recs = await store.records();
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(recs[0]).toMatchObject({ tool: "Write", filePath: a, existed: true });
    expect(recs[2]).toMatchObject({ tool: "Bash", existed: false });
    // 快照内容=写盘前
    const snap1 = recs[0]!.storedAs;
    expect(readFileSync(path.join(store.dir, snap1), "utf8")).toBe("v0");
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("DoD② /rewind N：恢复至第 N 快照前态；新建文件回滚=删除；索引只追加", async () => {
    const base = tmp();
    const proj = tmp();
    const a = path.join(proj, "a.txt");
    writeFileSync(a, "v0");
    const store = await FileHistoryStoreImpl.create(proj, base);
    await store.snapshot("Write", a); // 1: v0
    writeFileSync(a, "v1");
    await store.snapshot("Edit", a); // 2: v1
    await store.snapshot("Bash", path.join(proj, "new.txt")); // 3: 不存在（将被新建）
    writeFileSync(path.join(proj, "new.txt"), "created");
    // transcript 一致性（DoD②伴生）：rewind 不触碰转录
    const tfile = path.join(base, "t.jsonl");
    writeFileSync(tfile, '{"schemaVersion":1,"seq":1}\n', "utf8");
    const before = await readTranscript(tfile);

    const r3 = await store.rewindTo(3); // 撤 seq3：new.txt 删除（LIFO≥N 语义）
    expect(r3.undone).toBe(1);
    expect(existsSync(path.join(proj, "new.txt"))).toBe(false);
    const r2 = await store.rewindTo(2); // LIFO≥N：撤 3、2 → a←seq3 存档(v1)、new.txt 删（无存档 existed=false）
    expect(r2.undone).toBe(2);
    expect(existsSync(path.join(proj, "new.txt"))).toBe(false);
    expect(readFileSync(a, "utf8")).toBe("v1");
    const r1 = await store.rewindTo(1); // LIFO≥N：撤 3、2、1（seq≥1 全集——索引不消费，重复撤销幂等）
    expect(r1.undone).toBe(3);
    expect(readFileSync(a, "utf8")).toBe("v0");
    expect(existsSync(path.join(proj, "new.txt"))).toBe(false);
    const after = await readTranscript(tfile);
    expect(after.records).toEqual(before.records); // transcript 未被破坏
    // 索引只追加：rewind 后继续快照 seq 单调
    writeFileSync(a, "v9");
    const seq = await store.snapshot("Write", a);
    expect(seq).toBe(4);
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("DoD② 正路径（V 复现缺陷回归）：单写后 /rewind 1 恢复写前值；交叉写回第 N 时点", async () => {
    const base = tmp();
    const proj = tmp();
    const a = path.join(proj, "a.txt");
    writeFileSync(a, "v0");
    const store = await FileHistoryStoreImpl.create(proj, base);
    await store.snapshot("Write", a); // seq1 存档 v0
    writeFileSync(a, "v1"); // 真实写盘
    const r1 = await store.rewindTo(1);
    expect(r1.undone).toBe(1); // 此前 LIFO 口径=0（缺陷）
    expect(readFileSync(a, "utf8")).toBe("v0");
    // 场景2：a 写于 1、3，b 写于 2；/rewind 2 → a=第 2 时点值 v1、b=b0
    writeFileSync(a, "v1");
    const b = path.join(proj, "b.txt");
    writeFileSync(b, "b0");
    await store.snapshot("Edit", b); // seq2 存档 b0
    writeFileSync(b, "b1");
    await store.snapshot("Bash", a); // seq3 存档 v1（真实流程每写必有快照，此处不插入未跟踪写盘）
    writeFileSync(a, "a3");
    const r2 = await store.rewindTo(2); // 撤 3、2：a←seq3 存档 v1，b←seq2 存档 b0
    expect(r2.undone).toBe(2);
    expect(readFileSync(a, "utf8")).toBe("v1");
    expect(readFileSync(b, "utf8")).toBe("b0");
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("DoD④ 索引带 schemaVersion=1 且坏行容忍（ENG-080）", async () => {
    const base = tmp();
    const proj = tmp();
    const store = await FileHistoryStoreImpl.create(proj, base);
    writeFileSync(path.join(proj, "x.txt"), "x");
    await store.snapshot("Write", path.join(proj, "x.txt"));
    const index = readFileSync(store.indexFile, "utf8");
    expect(JSON.parse(index.trim()).schemaVersion).toBe(1);
    // 坏行容忍：插入手工坏行后仍可恢复
    const { appendFileSync } = await import("node:fs");
    appendFileSync(store.indexFile, "{broken\n", "utf8");
    const store2 = await FileHistoryStoreImpl.create(proj, base);
    expect(store2.maxSeq()).toBe(1); // 坏行不计、好行恢复
    expect((await store2.records()).length).toBe(1);
    rmSync(base, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });
});
