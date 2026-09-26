// M8-WP-03 判据（DoD③）：deny 规则覆盖缺省类型的**双通道端到端**——/subtask 与 /fork 各一（生产路径，非纯函数面）。
// 另含：判别力阳性对照（deny 其它类型＝照常派发）／显式类型通道例（既有语义零改）／不波及显式（缺省被禁不封显式）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

function fakeProvider(): ProviderAdapter & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      for (const ev of [
        { type: "message_start", id: "m", model: "test" },
        { type: "text_delta", text: "sub answer" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-m8wp03-"));
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

/** 每例独立 project（settings.local.json 写 deny 规则；trusted＝真读项目层）＋首轮种子消息（/subtask 门）。 */
function makeSession(name: string, deny: string[]): Session {
  const proj = path.join(root, name);
  mkdirSync(path.join(proj, ".standardcode"), { recursive: true });
  writeFileSync(path.join(proj, ".standardcode", "settings.local.json"), JSON.stringify({ schemaVersion: 1, permissions: { deny } }), "utf8");
  const s = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home: path.join(root, `home-${name}`), trusted: true });
  s.messages.push({ role: "user", content: [{ type: "text", text: "seed parent turn" }] });
  return s;
}

function ctxOf(s: Session, name: string) {
  const deps: ReplDeps = { session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, `repl-${name}`) };
  return createCommandContext(deps);
}

describe("M8-WP-03 DoD③ 缺省类型×deny 双通道端到端", () => {
  it("/subtask（类型缺省）× deny Agent(general-purpose) → refused（生效类型判定；消息带 (default)）", async () => {
    const s = makeSession("subtask-deny", ["Agent(general-purpose)"]);
    const r = await ctxOf(s, "subtask-deny").subtask("inspect the repo");
    expect(r.text).toContain("[subtask] refused:");
    expect(r.text).toContain("Agent type 'general-purpose' (default) has been denied by permission rule 'Agent(general-purpose)'");
    expect(s.messages).toHaveLength(1); // refused 零结果注入
  });

  it("/fork（类型缺省）× deny Agent(general-purpose) → refused（同判定源）", async () => {
    const s = makeSession("fork-deny", ["Agent(general-purpose)"]);
    const r = await ctxOf(s, "fork-deny").fork("inspect the state");
    expect(r.text).toContain("[fork] refused:");
    expect(r.text).toContain("permission rule 'Agent(general-purpose)'");
    expect(s.taskRegistry.list()).toHaveLength(0); // refused 零后台任务注册
  });

  it("阳性对照（判别力）：deny Agent(risky) 不命中生效类型 → /subtask 照常派发并返结果", async () => {
    const s = makeSession("control", ["Agent(risky)"]);
    const r = await ctxOf(s, "control").subtask("inspect the repo");
    expect(r.text).not.toContain("refused");
    expect(r.text).toContain("sub answer");
  });

  it("显式类型通道例（既有语义零改）：deny Agent(Explore) ＋ /subtask Explore … → refused", async () => {
    const s = makeSession("explicit-deny", ["Agent(Explore)"]);
    const r = await ctxOf(s, "explicit-deny").subtask("Explore inspect the repo");
    expect(r.text).toContain("[subtask] refused:");
    expect(r.text).toContain("Agent type 'Explore' has been denied by permission rule 'Agent(Explore)'");
    expect(r.text).not.toContain("(default)");
  });

  it("不波及显式：缺省类型被禁（deny general-purpose）时显式 Explore 仍照常派发", async () => {
    const s = makeSession("explicit-ok", ["Agent(general-purpose)"]);
    const r = await ctxOf(s, "explicit-ok").subtask("Explore inspect the repo");
    expect(r.text).not.toContain("refused");
    expect(r.text).toContain("sub answer");
  });
});
