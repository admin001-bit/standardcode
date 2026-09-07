// WP-06 测试：schema 落盘/读回/恢复重建/坏行容忍/路径编码；偏差⑥回归（中断终态无孤儿 result）。
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "@standardcode/harness";
import type { LLMEvent, Tool } from "@standardcode/harness";
import { encodeProjectPath, rebuildMessages, readTranscript, resumeFrom, TranscriptWriter } from "../src/transcripts.ts";

async function tmpBase() {
  return mkdtemp(path.join(tmpdir(), "stdc-tr-"));
}

function echoTool(): Tool {
  return { name: "echo", description: "", inputSchema: { type: "object" }, execute: async () => "ok" };
}

describe("路径编码（ADR-0028 决策 2）", () => {
  it("分隔符与冒号折叠；空格同样折叠", () => {
    expect(encodeProjectPath("D:\\projects\\standardcode")).toBe("D--projects-standardcode");
    expect(encodeProjectPath("D:\\a b\\c")).toBe("D--a-b-c");
    expect(encodeProjectPath("/tmp/x")).toBe("-tmp-x");
    expect(encodeProjectPath("D:\\中文")).toBe("D----");
  });
});

describe("TranscriptWriter/readTranscript（schema v1）", () => {
  it("逐记录追加→读回等价；seq 连续；done 带 reason+usage", async () => {
    const base = await tmpBase();
    const w = await TranscriptWriter.create("D:\\proj\\demo", "s1", base);
    await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "q" }] } });
    await w.append({ kind: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } });
    await w.append({ kind: "done", reason: "interrupted", usage: { inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } });

    const { records, skippedMalformed } = await readTranscript(w.file);
    expect(skippedMalformed).toBe(0);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records.map((r) => r.schemaVersion)).toEqual([1, 1, 1]);
    expect(records[2]).toMatchObject({ kind: "done", reason: "interrupted" });
    expect(records[2].usage).toEqual({ inputTokens: 9, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 });
    // NDJSON：三行
    const raw = await readFile(w.file, "utf8");
    expect(raw.trim().split("\n").length).toBe(3);
  });

  it("半截尾行（崩溃容忍）跳过并计数", async () => {
    const base = await tmpBase();
    const w = await TranscriptWriter.create("D:\\proj\\demo", "s2", base);
    await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "q" }] } });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(w.file, '{"schemaVersion":1,"seq":2,"kind":"assistant_mess', "utf8"); // 模拟写一半
    const { records, skippedMalformed } = await readTranscript(w.file);
    expect(records.length).toBe(1);
    expect(skippedMalformed).toBe(1);
    // resume 仍可用：重建出 q
    const r = await resumeFrom(w.file);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].content[0]).toMatchObject({ type: "text", text: "q" });
  });

  it("rebuildMessages 只取消息记录、保序", async () => {
    const records = [
      { schemaVersion: 1 as const, seq: 1, ts: "t", kind: "user_message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "q1" }] } },
      { schemaVersion: 1 as const, seq: 2, ts: "t", kind: "interrupt" as const, phase: "stream" as const },
      { schemaVersion: 1 as const, seq: 3, ts: "t", kind: "assistant_message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "a1" }] } },
      { schemaVersion: 1 as const, seq: 4, ts: "t", kind: "done" as const, reason: "interrupted" as const },
    ];
    const msgs = rebuildMessages(records);
    expect(msgs.length).toBe(2);
    expect((msgs[0].content as Array<{ text: string }>)[0].text).toBe("q1");
    expect((msgs[1].content as Array<{ text: string }>)[0].text).toBe("a1");
  });

  it("文件不存在 → 空转录（不抛）", async () => {
    const base = await tmpBase();
    const r = await resumeFrom(path.join(base, "nope.jsonl"));
    expect(r.messages).toEqual([]);
    expect(r.skippedMalformed).toBe(0);
  });
});

describe("E2E③ 形状：主循环中断 → 落盘 → 程序化 resume 等价重建", () => {
  it("挂起流中断后：终态消息序列不变量通过且转录可恢复", async () => {
    const base = await tmpBase();
    const w = await TranscriptWriter.create("D:\\proj\\demo", "s3", base);
    const ctl = new AbortController();
    const p = {
      capabilities: () => {
        throw new Error();
      },
      countTokens: async () => 0,
      async *stream() {
        yield { type: "text_delta", text: "par" } as LLMEvent;
        await new Promise((r) => setTimeout(r, 8000));
      },
    };
    const gen = runAgentLoop({
      provider: p,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      tools: [echoTool()],
      signal: ctl.signal,
      stateRef: undefined,
    }) as AsyncGenerator<import("@standardcode/harness").AgentEvent, import("@standardcode/harness").TurnState>;
    setTimeout(() => ctl.abort(), 100);
    // 消费事件并逐条落盘（接线形态 = WP-13 E2E③ 的简化版）
    let r = await gen.next();
    while (!r.done) {
      const e = r.value;
      if (e.type === "turn_start") await w.append({ kind: "user_message", message: { role: "user", content: [{ type: "text", text: "q" }] } });
      if (e.type === "interrupted") await w.append({ kind: "interrupt", phase: e.phase });
      r = await gen.next();
    }
    const finalState = r.value;
    for (const m of finalState.messages.slice(1)) {
      await w.append({ kind: m.role === "assistant" ? "assistant_message" : "user_message", message: m });
    }
    await w.append({ kind: "done", reason: "interrupted", usage: finalState.usage ?? undefined });

    const resumed = await resumeFrom(w.file);
    expect(resumed.lastReason).toBe("interrupted");
    expect(resumed.skippedMalformed).toBe(0);
    // 等价性：重建历史与终态 messages 一致（首条 user 由 turn_start 落盘）
    expect(resumed.messages).toEqual(finalState.messages);
  });
});
