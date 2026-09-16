// WP-04（M5）集成：安全首三件 fail-open→fail-closed 翻转对质（DoD⑤；M4 §G 移交清单卡化）。
// ①disableAllHooks 总闸 OR 形延伸覆盖 agent 级引擎（M4 WP-10 核验 O1 清偿：合并引擎=全会话源集+def.hooks 追加）
// ②allowed-tools 串形端到端收窄（单元两形解析见 capabilities skills.test.ts；此处会话收窄链零变对质）
// ③父会话 hooks 传播至子代理工具调用（tut :62093 集内四面；每层恰一次+Notification 超出集抑制 [自定]）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createCommandContext } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

const AGENTS_DIR = ".standardcode/agents";

const FIXTURE = `import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const a = process.argv[2] ?? "ok";
  if (a === "deny") { console.log(JSON.stringify({ decision: "block", reason: "hook-says-no" })); process.exit(0); }
  if (a === "mark") { appendFileSync(process.argv[3], process.argv[4] + "\\n"); process.exit(0); }
  process.exit(0);
});
`;

function writeAgent(proj: string, file: string, text: string): void {
  const p = path.join(proj, AGENTS_DIR, file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}

function agentWithHooks(name: string, command: string): string {
  // JSON 串内转义：反斜杠+双引号（wp10 hookbot 模板同形制——引号不转义=非法 JSON=def.hooks 静默解析失败）
  const jsonEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---
schemaVersion: 1
name: ${name}
description: hook holder
hooks: {"PreToolUse":[{"hooks":[{"type":"command","command":"${jsonEsc(command)}"}]}]}
---
hook body
`;
}

let root: string;
let fixturePath: string;
let projDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp04m5-"));
  fixturePath = path.join(root, "hook-fixture.mjs");
  writeFileSync(fixturePath, FIXTURE, "utf8");
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
  // def hooks 件（deny 形=① 控制组；mark 形=③ 每层一次断言，测试内按用例落 marks 文件后重写）
  writeAgent(projDir, "hookbot.md", agentWithHooks("hookbot", `node "${fixturePath}" deny`));
  // 串形 allowed-tools 技能（②端到端）
  const skillDir = path.join(projDir, ".standardcode", "skills", "narrow-str");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), '---\nname: narrow-str\ndescription: narrows via string form\nallowed-tools: "Read, Glob"\n---\nbody', "utf8");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function marks(name: string): string {
  const f = path.join(root, `${name}.marks.txt`);
  writeFileSync(f, "", "utf8");
  return f;
}
const markHook = (file: string, tag: string): { type: "command"; command: string } => ({ type: "command", command: `node "${fixturePath}" mark "${file}" "${tag}"` });

function makeSession(opts: { flagOverrides?: Record<string, unknown>; provider?: ProviderAdapter } = {}): Session {
  return createSession({
    provider: opts.provider ?? fakeProvider(),
    catalog: ["m"],
    model: "m",
    cwd: projDir,
    projectRoot: projDir,
    trusted: true,
    ...(opts.flagOverrides !== undefined ? { flagOverrides: opts.flagOverrides } : {}),
  });
}

function fakeProvider(rounds: LLMEvent[][] = []): ProviderAdapter & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  const TOOL_ROUND: LLMEvent[] = [
    { type: "tool_start", id: "t1", name: "Bash" },
    { type: "tool_input_delta", id: "t1", jsonPartial: '{"command":"echo hi"}' },
    { type: "tool_end", id: "t1" },
    { type: "finish", reason: "tool_calls", raw: "tool_use" },
  ];
  const TEXT: LLMEvent[] = [
    { type: "message_start", id: "m", model: "test" },
    { type: "text_delta", text: "reply" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
    { type: "finish", reason: "completed", raw: "end_turn" },
  ];
  return {
    requests,
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      for (const ev of rounds[Math.min(i, rounds.length - 1)] ?? [TOOL_ROUND, TEXT][Math.min(i, 1)]!) yield ev;
      i++;
    },
    countTokens: async () => 0,
  };
}

describe("①disableAllHooks 总闸 OR 形延伸（agent 级引擎，M4 WP-10 核验 O1 翻转）", () => {
  it("控制组（无总闸）：已确认 def.hooks 在子代理执行面生效（PreToolUse deny）", async () => {
    const s = makeSession();
    await s.agents.loadProjectAgents({ confirm: async () => true });
    const d = await s.agents.prepareSpawn("hookbot").hooks.preToolUse("Read", { file_path: "x.txt" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toContain("hook-says-no");
  });
  it("disableAllHooks=true（flag 源任一来源）→def.hooks 与 settings hooks 同轮关闭（fail-closed）", async () => {
    const f = marks("master");
    const s = makeSession({ flagOverrides: { disableAllHooks: true, hooks: { PreToolUse: [{ hooks: [markHook(f, "never")] }] } } });
    await s.agents.loadProjectAgents({ confirm: async () => true });
    const d = await s.agents.prepareSpawn("hookbot").hooks.preToolUse("Read", { file_path: "x.txt" });
    expect(d).toBeNull(); // def.hooks 同轮关闭（翻转前=deny）
    expect(readFileSync(f, "utf8")).toBe(""); // settings hooks 同轮关闭
  });
});

describe("②allowed-tools 串形端到端（收窄链零变）", () => {
  it("串形技能激活后 toolFace 收窄与数组形同链（Skill 恒保留）", async () => {
    const s = makeSession();
    expect(s.skills.all().map((x) => x.name)).toContain("narrow-str");
    expect(s.skills.all().find((x) => x.name === "narrow-str")!.allowedTools).toEqual(["Read", "Glob"]);
    const skillTool = s.tools.find((t) => t.name === "Skill")!;
    await skillTool.execute({ skill: "narrow-str" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(s.skills.active()?.name).toBe("narrow-str");
    const face = s.skills.toolFace(s.tools).map((t) => t.name);
    expect(face).toContain("Skill");
    expect(face).toContain("Read");
    expect(face).toContain("Glob");
    expect(face).not.toContain("Bash");
  });
});

describe("③父→子传播（tut :62093 集内四面）", () => {
  it("settings PreToolUse deny 在子代理循环生效（deny 先于仲裁，/subtask 端到端）", async () => {
    const provider = fakeProvider();
    const s = makeSession({ provider, flagOverrides: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node "${fixturePath}" deny` }] }] } } });
    await s.agents.loadProjectAgents();
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, "store1") });
    await ctx.subtask("run a tool");
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const round2 = JSON.stringify(provider.requests[1]!.messages);
    expect(round2).toContain("PreToolUse hook denied: hook-says-no"); // 父 settings 源 deny 在子代理工具链生效
  }, 30_000);

  it("每层恰一次：settings mark+def.hooks mark 各一行（单工具调用零重复触发）", async () => {
    const parentFile = marks("parent");
    writeAgent(projDir, "dualbot.md", agentWithHooks("dualbot", `node "${fixturePath}" mark "${parentFile}" agent-pre`));
    const provider = fakeProvider();
    const s = makeSession({ provider, flagOverrides: { hooks: { PreToolUse: [{ hooks: [markHook(parentFile, "parent-pre")] }] } } });
    await s.agents.loadProjectAgents({ confirm: async () => true });
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, "store2") });
    await ctx.subtask("dualbot run a tool");
    const lines = readFileSync(parentFile, "utf8").split("\n").filter((x) => x !== "");
    expect(lines.filter((l) => l === "parent-pre")).toHaveLength(1); // 父层恰一次
    expect(lines.filter((l) => l === "agent-pre")).toHaveLength(1); // def 层恰一次（确认后实体追加执行）
  }, 30_000);

  it("Notification 超出集不传播：子代理 ask 路触发 PermissionRequest 而非 Notification（[自定] 抑制）", async () => {
    const f = marks("notif");
    const provider = fakeProvider();
    const s = makeSession({ provider, flagOverrides: { hooks: { PermissionRequest: [{ hooks: [markHook(f, "perm-req")] }], Notification: [{ hooks: [markHook(f, "notif")] }] } } });
    await s.agents.loadProjectAgents();
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, "store3") });
    await ctx.subtask("run a tool");
    const end = Date.now() + 5000;
    while (Date.now() < end && !readFileSync(f, "utf8").includes("perm-req")) await new Promise((r) => setTimeout(r, 50)); // fire 异步落盘轮询（wp04 先例形制）
    const text = readFileSync(f, "utf8");
    expect(text).toContain("perm-req"); // 集内：PermissionRequest 传播
    expect(text).not.toContain("notif"); // 超出集：Notification 不传播
  }, 30_000);
});
