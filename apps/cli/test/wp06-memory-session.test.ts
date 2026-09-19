// WP-06（M4）集成：自动轨装配（autoTrack 开关/SEC 无关）+turn 首索引/互链注入（hash 增量）+纪律段进 system+
// /memory 双轨可视化+接缝⑫（memory 目录经 SessionLock.acquireIn 互斥）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { encodeProjectPath, SessionLock } from "@standardcode/platform";
import { CLI_COMMANDS } from "../src/commands.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

const INDEX_MD = `- [Testing](testing.md) how we run tests, see [[testing]]
`;

let root: string;
let homeDir: string;
let projDir: string;
let memDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp06-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  memDir = path.join(homeDir, ".standardcode", "projects", encodeProjectPath(projDir), "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(path.join(memDir, "MEMORY.md"), INDEX_MD, "utf8");
  writeFileSync(path.join(memDir, "testing.md"), "---\nname: testing\ntype: project\nschemaVersion: 1\n---\nrun bun test", "utf8");
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function fakeProvider(): ProviderAdapter & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      for (const ev of [
        { type: "message_start", id: "m", model: "test" },
        { type: "text_delta", text: "reply" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[])
        yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

function makeSession(over: Record<string, unknown> = {}): { session: Session; provider: ReturnType<typeof fakeProvider> } {
  const provider = fakeProvider();
  const session = createSession({
    provider,
    catalog: ["m"],
    model: "m",
    cwd: projDir,
    projectRoot: projDir,
    home: homeDir,
    trusted: true,
    ...over,
  });
  return { session, provider };
}

async function runReplWith(session: Session, lines: string[]): Promise<string> {
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir: root });
  return out;
}

describe("自动轨装配（DoD①②④）", () => {
  it("autoTrack 缺省开：autoMemory 视图+纪律段非空；memory.autoTrack=false→双关", () => {
    const { session } = makeSession();
    expect(session.autoMemory).not.toBeNull();
    expect(session.memoryDiscipline).toContain("How to save a memory");
    const off = makeSession({ flagOverrides: { "memory.autoTrack": false } }).session;
    expect(off.autoMemory).toBeNull();
    expect(off.memoryDiscipline).toBe("");
  });

  it("turn 首：索引+互链全文 meta 注入（hash 未变二轮不重发）；system 含纪律段", async () => {
    const { session, provider } = makeSession();
    await runReplWith(session, ["hi", "again", "/exit"]);
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const r1 = JSON.stringify(provider.requests[0]!);
    expect(r1).toContain("## Project memory index (MEMORY.md)");
    expect(r1).toContain("[Testing](testing.md)");
    expect(r1).toContain("## Memory: testing");
    expect(r1).toContain("run bun test");
    expect(r1).toContain("How to save a memory"); // 纪律段进 system
    const count = provider.requests[1]!.messages.filter((m) => JSON.stringify(m).includes("## Project memory index")).length;
    expect(count).toBe(1); // hash 未变不重发
  });
});

describe("DoD⑥ /memory 双轨可视化", () => {
  it("list：用户轨来源与顺序+自动轨索引摘要", async () => {
    const { session } = makeSession();
    const out = await runReplWith(session, ["/memory", "/exit"]);
    expect(out).toContain("[memory] 用户编写轨");
    expect(out).toContain("[memory] 自动轨（§9.1 ②；enabled）");
    expect(out).toContain("1 行 / ");
    expect(out).toContain("记忆文件: 1 个");
  });

  it("命令清单恰 31【勘误链至 30；2026-09-19：M7-WP-01 /goal 30→31】", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toHaveLength(31);
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("memory");
  });
});

describe("接缝⑫：memory 目录并发写经 SessionLock（DoD⑦ 最小断言）", () => {
  it("acquireIn(memDir) 互斥：已持锁第二次抛错，释放后可再取", async () => {
    const lock1 = await SessionLock.acquireIn(memDir, "memory.lock");
    await expect(SessionLock.acquireIn(memDir, "memory.lock")).rejects.toThrow();
    await lock1.release();
    const lock2 = await SessionLock.acquireIn(memDir, "memory.lock");
    await lock2.release();
  });
});
