// WP-04（M4）集成：13 事件触发面独立用例（DoD⑤）+三裁决序（接缝③：schema→PreToolUse→仲裁）+
// fail-closed（PreToolUse 超时=工具不执行）+Stop 上限 8（:151674）+session.hooks 装配（flag 源+信任门）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createRegistry } from "@standardcode/harness";
import type { ToolHooks } from "@standardcode/harness";
import { createStandardTools } from "@standardcode/capabilities";
import { runTools } from "@standardcode/harness";
import { CLI_COMMANDS } from "../src/commands.ts";
import { runRepl, type ReplDeps, type ReplIo } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

const FIXTURE = `import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const a = process.argv[2] ?? "ok";
  if (a === "deny") { console.log(JSON.stringify({ decision: "block", reason: "hook-says-no" })); process.exit(0); }
  if (a === "exit2") { process.stderr.write("stop-blocking"); process.exit(2); }
  if (a === "mark") { appendFileSync(process.argv[3], process.argv[4] + "\\n"); process.exit(0); }
  if (a === "sleep") { setTimeout(() => process.exit(0), Number(process.argv[3] ?? 5000)); return; }
  process.exit(0);
});
`;

let root: string;
let fixturePath: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp04-"));
  fixturePath = path.join(root, "hook-fixture.mjs");
  writeFileSync(fixturePath, FIXTURE, "utf8");
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 暂存目录泄漏可接受 */
  }
});

function marks(name: string): string {
  const f = path.join(root, `${name}.marks.txt`);
  writeFileSync(f, "", "utf8");
  return f;
}
const markHook = (file: string, tag: string): { type: "command"; command: string } => ({ type: "command", command: `node "${fixturePath}" mark "${file}" "${tag}"` });
const cmdHook = (action: string): { type: "command"; command: string } => ({ type: "command", command: `node "${fixturePath}" ${action}` });

function makeSession(hooks: Record<string, unknown>, over: Partial<Parameters<typeof createSession>[0]> = {}): Session {
  return createSession({
    provider: fakeProvider(),
    catalog: ["m"],
    model: "m",
    cwd: root,
    projectRoot: root,
    trusted: true,
    flagOverrides: { hooks } as Record<string, unknown>,
    ...over,
  });
}

function fakeProvider(rounds: LLMEvent[][] = []): ProviderAdapter & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const TEXT: LLMEvent[] = [
        { type: "message_start", id: "m", model: "test" },
        { type: "text_delta", text: "reply" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ];
      for (const ev of rounds[Math.min(i, rounds.length - 1)] ?? TEXT) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
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
  await runRepl({ session, io, baseDir: root }); // baseDir 隔离：锁/转录不落真实 home（CI detectProjectWorkspace 竞速源消除）
  return out;
}

describe("工具链三裁决序+Pre/Post 面（runTools 直测）", () => {
  it("PreToolUse deny=工具不执行（JSON decision:block 归一）", async () => {
    const s = makeSession({ PreToolUse: [{ matcher: "Bash", hooks: [cmdHook("deny")] }] });
    const tools = createStandardTools({ cwd: root });
    const outcomes = await runTools([{ id: "t1", name: "Bash", input: { command: "echo hi" } }], { registry: createRegistry(tools), hooks: s.hooks.toolAdapter() });
    expect(outcomes[0]!.isError).toBe(true);
    expect(outcomes[0]!.content).toContain("PreToolUse hook denied: hook-says-no");
  });

  it("接缝③序：schema 校验先于 PreToolUse（坏输入=hook 不触发）", async () => {
    const f = marks("schema");
    const s = makeSession({ PreToolUse: [{ hooks: [markHook(f, "pre")] }] });
    const tools = createStandardTools({ cwd: root });
    const outcomes = await runTools([{ id: "t1", name: "Bash", input: {} }], { registry: createRegistry(tools), hooks: s.hooks.toolAdapter() });
    expect(outcomes[0]!.content).toContain("input failed schema validation");
    expect(readFileSync(f, "utf8")).toBe(""); // hook 未触发
  });

  it("PostToolUse（成功）与 PostToolUseFailure（抛错）触发面", async () => {
    const f = marks("post");
    const s = makeSession({ PostToolUse: [{ hooks: [markHook(f, "post-use")] }], PostToolUseFailure: [{ hooks: [markHook(f, "post-fail")] }] });
    const registry = createRegistry([
      { name: "Ok", inputSchema: { type: "object" }, description: "test", execute: async () => "fine", isConcurrencySafe: true },
      { name: "Boom", inputSchema: { type: "object" }, description: "test", execute: async () => { throw new Error("exploded"); }, isConcurrencySafe: true },
    ]);
    const outcomes = await runTools([{ id: "1", name: "Ok", input: {} }, { id: "2", name: "Boom", input: {} }], { registry, hooks: s.hooks.toolAdapter() });
    expect(outcomes[0]!.isError).toBe(false);
    expect(outcomes[1]!.content).toContain("tool error: exploded");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("post-use");
    expect(text).toContain("post-fail");
  });

  it("PermissionRequest+Notification 触发面（ask 判定点）；ask fail-closed 不执行", async () => {
    const f = marks("perm");
    const s = makeSession({ PermissionRequest: [{ hooks: [markHook(f, "perm-req")] }], Notification: [{ hooks: [markHook(f, "notif")] }] });
    const registry = createRegistry([{ name: "Ok", inputSchema: { type: "object" }, description: "test", execute: async () => "fine", isConcurrencySafe: true }]);
    const outcomes = await runTools([{ id: "1", name: "Ok", input: {} }], {
      registry,
      hooks: s.hooks.toolAdapter(),
      permission: { check: async () => "ask" },
    });
    expect(outcomes[0]!.content).toContain("permission required (ask)");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("perm-req");
    expect(text).toContain("notif");
  });

  it("PreToolUse 超时=fail-closed 工具不执行（无旁路，:61919）", async () => {
    const s = makeSession({ PreToolUse: [{ hooks: [{ type: "command", command: `node "${fixturePath}" sleep 5000`, timeout: 1 }] }] });
    const registry = createRegistry([{ name: "Ok", inputSchema: { type: "object" }, description: "test", execute: async () => "should-not-run", isConcurrencySafe: true }]);
    const outcomes = await runTools([{ id: "1", name: "Ok", input: {} }], { registry, hooks: s.hooks.toolAdapter() });
    expect(outcomes[0]!.isError).toBe(true);
    expect(outcomes[0]!.content).toContain("fail-closed");
    expect(outcomes[0]!.content).not.toContain("should-not-run");
  });

  it("未信任=跳全部（:262013；工具照常执行——hooks 面静默）", async () => {
    const f = marks("untrusted");
    const s = makeSession({ PreToolUse: [{ hooks: [markHook(f, "never")] }] }, { trusted: false });
    const registry = createRegistry([{ name: "Ok", inputSchema: { type: "object" }, description: "test", execute: async () => "ran", isConcurrencySafe: true }]);
    const outcomes = await runTools([{ id: "1", name: "Ok", input: {} }], { registry, hooks: s.hooks.toolAdapter() });
    expect(outcomes[0]!.content).toBe("ran");
    expect(readFileSync(f, "utf8")).toBe("");
  });
});

describe("repl 生命周期触发面（e2e：Session/Stop/PromptSubmit/Compact/Subagent）", () => {
  it("SessionStart（turn 前）+SessionEnd（/exit）触发", async () => {
    const f = marks("session");
    const s = makeSession({ SessionStart: [{ hooks: [markHook(f, "sess-start")] }], SessionEnd: [{ hooks: [markHook(f, "sess-end")] }] });
    await runReplWith(s, ["/exit"]);
    expect(readFileSync(f, "utf8")).toBe("sess-start\nsess-end\n");
  });

  it("UserPromptSubmit exit2=提示词不进轮次（provider 零请求）", async () => {
    const s = makeSession({ UserPromptSubmit: [{ hooks: [cmdHook("exit2")] }] });
    const provider = fakeProvider();
    const out = await runReplWith(s, ["blocked prompt", "/exit"]);
    expect(out).toContain("prompt blocked by UserPromptSubmit hook: stop-blocking");
    expect(provider.requests).toHaveLength(0);
  });

  it("Stop 阻断回灌续轮；连续 8 次后交还用户（:151674 上限）", async () => {
    const provider = fakeProvider();
    const s = makeSession({ Stop: [{ hooks: [cmdHook("exit2")] }] }, { provider });
    const out = await runReplWith(s, ["hello", "/exit"]);
    expect(out).toContain("[hooks] Stop hook blocked 8 times");
    expect(provider.requests.length).toBeGreaterThanOrEqual(9); // 1 初始+8 续轮
    // 反馈消息回灌：第 2 轮请求含 [Stop hook] 前缀 user 消息
    const second = provider.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(second)).toContain("[Stop hook] stop-blocking");
  }, 60_000);

  it("PreCompact/PostCompact 触发（/compact 手动通道）", async () => {
    const f = marks("compact");
    const s = makeSession({ PreCompact: [{ hooks: [markHook(f, "pre-compact")] }], PostCompact: [{ hooks: [markHook(f, "post-compact")] }] });
    await runReplWith(s, ["hello", "/compact", "/exit"]);
    const text = readFileSync(f, "utf8");
    expect(text).toContain("pre-compact");
    expect(text).toContain("post-compact");
  });

  it("SubagentStart/SubagentStop 触发（/subtask 同步通道；fire 异步落盘轮询等待）", async () => {
    const f = marks("subagent");
    const s = makeSession({ SubagentStart: [{ hooks: [markHook(f, "sub-start")] }], SubagentStop: [{ hooks: [markHook(f, "sub-stop")] }] });
    await runReplWith(s, ["hello", "/subtask do things", "/exit"]);
    const end = Date.now() + 5000;
    while (Date.now() < end && !(readFileSync(f, "utf8").includes("sub-start") && readFileSync(f, "utf8").includes("sub-stop"))) await new Promise((r) => setTimeout(r, 50));
    const text = readFileSync(f, "utf8");
    expect(text).toContain("sub-start");
    expect(text).toContain("sub-stop");
  }, 30_000);

  it("命令清单恰 31【勘误链至 30；2026-09-19：M7-WP-01 /goal 30→31】", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toHaveLength(31);
  });
});
