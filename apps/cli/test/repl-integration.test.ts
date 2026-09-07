// DoD④ + REPL 集成：流式输出上屏（真实 runAgentLoop + 渲染）、!shell 本地直执、@file 注入、五命令经 REPL 派发、/exit 干净退出。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-cli-"));
  await writeFile(join(dir, "note.txt"), "the file body", "utf8");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function scriptedProvider(rounds: LLMEvent[][]): ProviderAdapter & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      // 快照而非引用：loop 会在同一数组上追加块（真实 adapter 在入口编码，等价快照语义）
      requests.push({ ...req, messages: structuredClone(req.messages) });
      for (const ev of rounds[Math.min(i, rounds.length - 1)]) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

const TEXT_ROUND: LLMEvent[] = [
  { type: "message_start", id: "m", model: "test" },
  { type: "text_delta", text: "streamed " },
  { type: "text_delta", text: "reply" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
  { type: "finish", reason: "completed", raw: "end_turn" },
];

async function runReplWith(lines: string[], provider: ProviderAdapter): Promise<{ out: string; provider: ProviderAdapter }> {
  const session = createSession({ provider, catalog: ["m-a"], model: "m-a", cwd: dir });
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io });
  return { out, provider };
}

describe("runRepl (四模式派发 + 流式上屏)", () => {
  it("prompt 流式上屏 + usage 行；/help 列表；/exit 干净退出", async () => {
    const { out } = await runReplWith(["hello there", "/help", "/exit"], scriptedProvider([TEXT_ROUND]));
    expect(out).toContain("streamed reply");
    expect(out).toContain("usage: input=10 output=5 cache_creation=0 cache_read=0");
    expect(out).toContain("/help");
    expect(out).toContain("/exit");
    expect(out).not.toContain("[done: end]"); // concise：正常完成不打印 done 行
  });

  it("@file 读文件注入用户消息（进模型轮次）", async () => {
    const provider = scriptedProvider([TEXT_ROUND]);
    const { out } = await runReplWith([`@note.txt summarize`, "/exit"], provider);
    expect(out).toContain("streamed reply");
    const req = (provider as ReturnType<typeof scriptedProvider>).requests[0]!;
    const text = JSON.stringify(req.messages.at(-1));
    expect(text).toContain("summarize");
    expect(text).toContain("[attached file: note.txt]");
    expect(text).toContain("the file body");
  });

  it("@file 缺文件不进轮次并报错", async () => {
    const provider = scriptedProvider([]);
    const { out } = await runReplWith(["@nope.txt hi", "/exit"], provider);
    expect(out).toContain("[file] not found: nope.txt");
    expect((provider as ReturnType<typeof scriptedProvider>).requests).toHaveLength(0);
  });

  it("!shell 本地直执不进模型轮次", async () => {
    const provider = scriptedProvider([]);
    const { out } = await runReplWith([`!node -e "process.stdout.write('shell-ok')"`, "/exit"], provider);
    expect(out).toContain("shell-ok");
    expect((provider as ReturnType<typeof scriptedProvider>).requests).toHaveLength(0);
  });

  it("未知命令拒绝（B-03）", async () => {
    const { out } = await runReplWith(["/config", "/exit"], scriptedProvider([]));
    expect(out).toContain("[command] unknown: /config");
  });

  it("跨轮历史累积（第二轮请求含第一轮消息）", async () => {
    const provider = scriptedProvider([TEXT_ROUND, TEXT_ROUND]);
    await runReplWith(["first", "second", "/exit"], provider);
    const requests = (provider as ReturnType<typeof scriptedProvider>).requests;
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("first");
    expect(JSON.stringify(requests[1]!.messages)).toContain("second");
  });

  it("真实落盘产物核对（cwd 会话目录）", async () => {
    const provider = scriptedProvider([TEXT_ROUND]);
    const { out } = await runReplWith(["x", "/exit"], provider);
    expect(out).toContain("streamed reply");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("the file body");
  });
});
