// WP-08（M2）测试：transcripts 接线+多开加锁+S-10+磁盘满降级（判据自足：板 WP-08 DoD①-⑤）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import {
  redactSecrets,
  SECRET_PLACEHOLDER,
  SessionLock,
  listSessions,
  ResilientTranscriptWriter,
  LOCK_STALE_MS,
} from "../src/session-store.ts";
import { transcriptsDir, readTranscript } from "../src/transcripts.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sc-ss-"));
}

describe("WP-08 transcripts 路径（DoD①）", () => {
  it("落盘路径=§2 行 M2 原文：~/.standardcode/projects/<encoded>/transcripts/；编码回归含中文", () => {
    const base = tmp();
    expect(transcriptsDir("D:\\proj\\a", base)).toBe(path.join(base, "projects", "D--proj-a", "transcripts"));
    expect(transcriptsDir("D:\\中文 目录", base)).toBe(path.join(base, "projects", "D-------", "transcripts")); // 中文逐字折叠（ADR-0028）：D+7 折叠
    rmSync(base, { recursive: true, force: true });
  });
});

describe("WP-08 多开加锁（DoD②）", () => {
  it("同项目双会话互斥：第二把锁 EEXIST 拒绝；释放后可再取", async () => {
    const base = tmp();
    const l1 = await SessionLock.acquire("D:\\p", "s1", base);
    expect(l1.isLocked).toBe(true);
    await expect(SessionLock.acquire("D:\\p", "s1", base)).rejects.toThrow(/session lock held/);
    await l1.release();
    const l2 = await SessionLock.acquire("D:\\p", "s1", base);
    expect(l2.isLocked).toBe(true);
    await l2.release();
    rmSync(base, { recursive: true, force: true });
  });

  it("陈旧锁（ts 超 30s、pid 非本进程）→ 抢占", async () => {
    const base = tmp();
    const dir = transcriptsDir("D:\\p", base);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "s1.lock"), `pid=999999\nts=${Date.now() - LOCK_STALE_MS - 1000}\n`, "utf8");
    const l = await SessionLock.acquire("D:\\p", "s1", base); // 不抛=抢占成功
    expect(l.isLocked).toBe(true);
    await l.release();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("WP-08 S-10（DoD③）", () => {
  it("密钥脱敏：sk-/ghp_/AKIA/Bearer 形状替换；普通文本不动；幂等", () => {
    expect(redactSecrets("key sk-abc123def456ghijk and done")).toBe(`key ${SECRET_PLACEHOLDER} and done`);
    expect(redactSecrets("token ghp_0123456789abcdefghij end")).toBe(`token ${SECRET_PLACEHOLDER} end`);
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE end")).toBe(`aws ${SECRET_PLACEHOLDER} end`);
    expect(redactSecrets("Bearer abcdefghijklmnopqrst1234")).toContain(SECRET_PLACEHOLDER);
    expect(redactSecrets("plain words with sk- in middle")).toBe("plain words with sk- in middle"); // 形状不足不误伤
    expect(redactSecrets(redactSecrets("sk-abcdefghijklmnop"))).toBe(redactSecrets("sk-abcdefghijklmnop")); // 幂等
  });

  it("ResilientTranscriptWriter 落盘已脱敏+权限收紧可调用（Windows no-op 不报错）", async () => {
    const base = tmp();
    const w = await ResilientTranscriptWriter.create("D:\\p", "s1", base);
    await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "my key is sk-abc123def456ghij" }] } });
    const { records } = await readTranscript(w.file!);
    expect(JSON.stringify(records)).not.toContain("sk-abc123def456ghij");
    expect(JSON.stringify(records)).toContain(SECRET_PLACEHOLDER);
    rmSync(base, { recursive: true, force: true });
  });

  it("S1-2：块级/记录级脱敏盲区——tool_use.input（含嵌套字符串叶子）、thinking、compact.summary 均落盘前脱敏", async () => {
    const base = tmp();
    const w = await ResilientTranscriptWriter.create("D:\\p", "s-s1-2", base);
    await w.append({
      kind: "assistant_message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -H 'Bearer abcdefghijklmnopqrst1234' https://x", timeout: 1000 } },
          { type: "tool_use", id: "t2", name: "Write", input: { file_path: "a.txt", content: "nested sk-abc123def456ghij end", meta: { deep: ["sk-abcdef0123456789"] } } },
          { type: "thinking", thinking: "model saw key sk-abc123def456ghij in logs" },
          { type: "text", text: "plain reply" },
        ],
      },
    });
    await w.append({
      kind: "compact",
      mode: "auto",
      preTokens: 10,
      postTokens: 5,
      keptCount: 0,
      summary: "history mentioned ghp_0123456789abcdefghij once",
    });
    const { records } = await readTranscript(w.file!);
    const raw = JSON.stringify(records);
    expect(raw).not.toContain("sk-abc123def456ghij"); // tool_use.input/thinking（修复前明文入盘）
    expect(raw).not.toContain("abcdefghijklmnopqrst1234");
    expect(raw).not.toContain("sk-abcdef0123456789"); // 嵌套数组叶子
    expect(raw).not.toContain("ghp_0123456789abcdefghij"); // compact.summary（修复前整条早退绕过）
    expect(raw).toContain(SECRET_PLACEHOLDER);
    // 结构保真：非字符串值与非密钥文本原样
    const rec0 = records[0]!;
    const tu = rec0.message!.content.find((b) => b.type === "tool_use");
    expect(tu && tu.type === "tool_use" && tu.input).toMatchObject({ command: expect.stringContaining("curl"), timeout: 1000 });
    const txt = rec0.message!.content.find((b) => b.type === "text");
    expect(txt && txt.type === "text" && txt.text).toBe("plain reply");
    expect(records[1]!.summary).toContain(SECRET_PLACEHOLDER);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("WP-08 磁盘满降级（DoD④）", () => {
  it("ENOSPC → degraded=true、记录入内存缓冲、不抛；会话继续", async () => {
    const base = tmp();
    const w = await ResilientTranscriptWriter.create("D:\\p", "s1", base);
    // 模拟磁盘满：关闭 inner 的文件句柄路径——直接替换 append 抛 ENOSPC
    (w as any).inner = {
      file: (w as any).inner.file,
      append: async () => {
        const e = new Error("no space") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      },
    };
    const r = await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "after full" }] } });
    expect(w.degraded).toBe(true);
    expect(w.degradeReason).toContain("ENOSPC");
    expect(r.seq).toBe(1);
    expect(w.buffered).toHaveLength(1);
    const r2 = await w.append({ kind: "done", reason: "interrupted" });
    expect(r2.seq).toBe(2);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("WP-08 会话索引（DoD⑤）", () => {
  it("枚举同项目转录：标题/起止/消息数/终态；坏文件跳过计数", async () => {
    const base = tmp();
    const w1 = await ResilientTranscriptWriter.create("D:\\p", "s1", base);
    await w1.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "hello world task" }] } });
    await w1.append({ kind: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    await w1.append({ kind: "done", reason: "end" });
    const w2 = await ResilientTranscriptWriter.create("D:\\p", "s2", base);
    await w2.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "second" }] } });
    // 坏文件
    const { mkdirSync } = await import("node:fs");
    mkdirSync(transcriptsDir("D:\\p", base), { recursive: true });
    writeFileSync(path.join(transcriptsDir("D:\\p", base), "bad.jsonl"), "{ half\n", "utf8");
    const { sessions, skippedMalformed } = await listSessions("D:\\p", base);
    expect(skippedMalformed).toBeGreaterThanOrEqual(1);
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    const s1 = sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.title).toBe("hello world task");
    expect(s1.messageCount).toBe(2);
    expect(s1.lastReason).toBe("end");
    expect(s1.startedAt).not.toBeNull();
    expect(s1.lastActivityAt).not.toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});
