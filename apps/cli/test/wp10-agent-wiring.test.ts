// M4-WP-10 集成（生产路径断言，非纯函数面）：SEC-070 生产闭环（isTrusted→load→gate(confirm UI)→registry
// sources.project 注入；未信任=仅内置可用）+DoD② /subtask 类型首词端到端（names() 真消费）+DoD③ requiredMCP
// 真接投影+超时拒绝+DoD④ initialPrompt 首轮预热+DoD⑤ def.hooks 执行面（确认/留痕后生效）+DoD⑥ 禁用位
//+DoD⑦ 跨轮装载新对象（gate mutation 不携带）+runRepl 首轮自动补装（ADR-0043 决策 1）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { validateSpawn, type SpawnValidationResult } from "@standardcode/harness";
import { createCommandContext } from "../src/repl.ts";
import { splitSubtaskType } from "../src/commands.ts";
import { createSession, type Session } from "../src/session.ts";
import type { ConfirmPrompt } from "../src/confirm.ts";

const AGENTS_DIR = ".standardcode/agents";

function writeAgent(proj: string, file: string, text: string): void {
  const p = path.join(proj, AGENTS_DIR, file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}

const BOT_MD = `---
schemaVersion: 1
name: wp10-bot
description: project agent
initialPrompt: warm boot first
---
You are the wp10 project agent.
`;
const RISKY_MD = `---
schemaVersion: 1
name: risky
description: escalates
permissionMode: bypassPermissions
---
risky body
`;
const MCPBOT_MD = `---
schemaVersion: 1
name: mcpbot
description: needs mcp
mcpServers:
  - ghost-srv
---
mcp body
`;

let root: string;
let homeDir: string;
let projDir: string;
let denyScript: string;
let hookProjDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp10-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
  writeAgent(projDir, "wp10-bot.md", BOT_MD);
  writeAgent(projDir, "risky.md", RISKY_MD);
  writeAgent(projDir, "mcpbot.md", MCPBOT_MD);
  denyScript = path.join(root, "hook-fixture.js");
  writeFileSync(denyScript, 'if (process.argv[2] === "deny") { process.stderr.write("hookbot-denied"); process.exit(2); }\n', "utf8");
  hookProjDir = path.join(root, "hookproj");
  mkdirSync(hookProjDir, { recursive: true });
  writeAgent(hookProjDir, "wp10-bot.md", BOT_MD);
  writeAgent(hookProjDir, "risky.md", RISKY_MD);
  writeAgent(hookProjDir, "hookbot.md", `---
schemaVersion: 1
name: hookbot
description: hook holder
hooks: {"PreToolUse":[{"hooks":[{"type":"command","command":"node \\"${denyScript.replace(/\\/g, "\\\\")}\\" deny"}]}]}
---
hook body
`);
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function fakeProvider(): ProviderAdapter & { requests: LLMRequest[] } {
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
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

function makeSession(opts: { home?: string; projectRoot: string; trusted: boolean; provider?: ProviderAdapter; settings?: Record<string, unknown> }): Session {
  const home = opts.home ?? homeDir;
  if (opts.settings) {
    const dir = path.join(home, ".standardcode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ schemaVersion: 1, ...opts.settings }), "utf8");
  }
  return createSession({ provider: opts.provider ?? fakeProvider(), catalog: ["m"], model: "m", cwd: opts.projectRoot, projectRoot: opts.projectRoot, home, trusted: opts.trusted });
}

function ctxOf(s: Session, confirm?: ConfirmPrompt) {
  return createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, ...(confirm ? { confirm } : {}), baseDir: path.join(root, "repl-store") });
}

describe("DoD①⑦：SEC-070 生产闭环（信任门/二次确认/留痕/跨轮新对象）", () => {
  it("未信任=仅内置+plugin 可用：project 层零装载、confirm 零调用（生产路径端到端）", async () => {
    const calls: string[] = [];
    const s = makeSession({ projectRoot: projDir, trusted: false });
    const st = await s.agents.loadProjectAgents({ confirm: async (n) => { calls.push(n); return true; } });
    expect(st.layerWithheld).toBe(true);
    expect(calls).toEqual([]); // 未信任先于一切确认（gate 零泄漏形制）
    expect(s.agents.names()).not.toContain("wp10-bot");
    expect(s.agents.registry().get("risky")).toBeUndefined();
    expect(s.agents.names()).toContain("general-purpose"); // 内置仍在位
  });
  it("信任+确认通过=提权字段保留+agentTrust 落盘留痕；拒绝=剥离字段保留定义（fail-closed）", async () => {
    const asked: { name: string; fields: string[] }[] = [];
    const s = makeSession({ projectRoot: hookProjDir, trusted: true });
    const st = await s.agents.loadProjectAgents({
      confirm: async (n, f) => {
        asked.push({ name: n, fields: f });
        return true; // once/always 语义等价批准（映射在 repl 层，本层直给 boolean）
      },
    });
    expect(st.layerWithheld).toBe(false);
    expect(asked.map((a) => a.name).sort()).toEqual(["hookbot", "risky"]); // 无提权字段件零打扰
    expect(asked.find((a) => a.name === "risky")!.fields).toEqual(["permissionMode=bypassPermissions"]);
    expect(asked.find((a) => a.name === "hookbot")!.fields).toEqual(["hooks"]);
    expect(st.stripped).toEqual([]);
    expect(s.agents.registry().get("risky")!.permissionMode).toBe("bypassPermissions");
    expect(s.agents.registry().get("hookbot")!.hooks).toBeDefined();
    // 留痕=proj/.standardcode/settings.local.json agentTrust 映射（ADR-0037 形制）
    const local = JSON.parse(readFileSync(path.join(hookProjDir, ".standardcode", "settings.local.json"), "utf8"));
    expect(local.schemaVersion).toBe(1);
    expect(local.agentTrust.risky).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(local.agentTrust.hookbot).toMatchObject({ hooks: true });
    expect(local.agentTrust.risky.confirmedAt).toMatch(/^\d{4}-/);
    // 二次装载留痕在位=零打扰（确认只问一次）
    const asked2: string[] = [];
    await s.agents.loadProjectAgents({ confirm: async (n) => { asked2.push(n); return false; } });
    expect(asked2).toEqual([]);
    expect(s.agents.registry().get("risky")!.permissionMode).toBe("bypassPermissions");
  });
  it("拒绝路：剥离提权字段保留定义本体；第二轮装载新对象提权字段完整复现（DoD⑦ gate mutation 不携带）", async () => {
    const s = makeSession({ projectRoot: projDir, trusted: true });
    const st1 = await s.agents.loadProjectAgents({ confirm: async () => false });
    expect(st1.stripped.map((x) => x.name).sort()).toEqual(["risky"]);
    expect(s.agents.names()).toContain("risky"); // 定义本体保留可注册
    expect(s.agents.registry().get("risky")!.permissionMode).toBeUndefined(); // 提权剥离
    // 同轮磁盘不动，第二次装载重新解析（若携带第一轮 delete mutation，此处将永无 permissionMode）
    const st2 = await s.agents.loadProjectAgents({ confirm: async () => true });
    expect(st2.stripped).toEqual([]);
    expect(s.agents.registry().get("risky")!.permissionMode).toBe("bypassPermissions");
  });
});

describe("DoD②：/subtask 类型首词端到端（custom agent 经注册表 names() 真消费 spawn 成功）", () => {
  it("splitSubtaskType：首词命中（大小写不敏感）/不命中整段 prompt/单 token 不拆", () => {
    expect(splitSubtaskType("WP10-Bot do the thing", ["wp10-bot", "general-purpose"])).toEqual({ type: "wp10-bot", prompt: "do the thing" });
    expect(splitSubtaskType("please explore", ["wp10-bot"])).toEqual({ prompt: "please explore" });
    expect(splitSubtaskType("wp10-bot", ["wp10-bot"])).toEqual({ prompt: "wp10-bot" });
  });
  it("custom def 端到端：类型首词→prepareSpawn→/subtask spawn 成功；def.systemPrompt 进子代理装配（system 面）", async () => {
    const provider = fakeProvider();
    const s = makeSession({ projectRoot: projDir, trusted: true, provider });
    await s.agents.loadProjectAgents(); // 无提权字段件零 confirm
    expect(s.agents.names()).toContain("wp10-bot"); // built-in+plugin+project 全集（硬编码 general-purpose 退役）
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] }); // /subtask 守卫（既有行为）
    const ctx = ctxOf(s);
    const r = await ctx.subtask("wp10-bot inspect repo");
    expect(r.text).toContain("completed");
    const req = provider.requests[provider.requests.length - 1]!;
    expect(req.system).toContain("You are the wp10 project agent."); // def 体经注册表进运行面
    expect(req.system).not.toContain("general-purpose agent that can use all tools"); // 非缺省壳
  });
  it("runRepl 首轮自动补装（ADR-0043 决策 1）：仅 /exit 会话后 state().loaded=true 且 custom 名在位", async () => {
    const out: string[] = [];
    const s = makeSession({ projectRoot: projDir, trusted: true });
    const queue = ["/exit"];
    await (await import("../src/repl.ts")).runRepl({
      session: s,
      io: { lines: (async function* () { for (const l of queue) yield l; })(), write: (x) => out.push(x), close: () => {} },
      baseDir: path.join(root, "repl-store2"),
    });
    expect(s.agents.state().loaded).toBe(true);
    expect(s.agents.names()).toContain("wp10-bot");
  });
});

describe("DoD③：requiredMCP 真接（名称引用→连接态投影→30s 超时拒绝，段序不弱化）", () => {
  it("session 投影：ghost-srv 未连接=pending 恒含之（含 failed/缺席）；validateSpawn 经注入时钟超时拒绝", async () => {
    const s = makeSession({ projectRoot: projDir, trusted: true });
    await s.agents.loadProjectAgents();
    const { ctx } = s.agents.prepareSpawn("mcpbot");
    expect(ctx.pendingRequiredMcp!(["ghost-srv"])).toEqual(["ghost-srv"]); // mcpConnections 空=未连接
    expect(ctx.pendingRequiredMcp!(["ghost-srv", "ghost-srv"])).toEqual(["ghost-srv", "ghost-srv"]);
    let polls = 0;
    const v: SpawnValidationResult = await validateSpawn({ prompt: "t", subagentType: "mcpbot", description: "d" }, {
      ...ctx,
      concurrentSubagents: 0,
      sleep: async () => { polls++; },
      now: () => polls * 31_000,
    });
    expect(v).toMatchObject({ ok: false, code: "mcp_required_missing" });
    if (!v.ok) {
      expect(v.message).toContain("ghost-srv");
      expect(v.trace.join(">")).toMatch(/type>requiredMcp/); // ORC-022:294 段序：类型解析之后
    }
    // trace 完整性：无 mcpServers 声明件恒直通（requiredMcp 段仍在序内）
    const v2 = await validateSpawn({ prompt: "t", subagentType: "wp10-bot", description: "d" }, { ...ctx, concurrentSubagents: 0 });
    expect(v2.ok && v2.trace).toContain("requiredMcp");
  });
  it("Agent(X) deny 规则供给：settings permissions.deny 的 Agent(risky) 提取→校验段③拒绝", async () => {
    const proj3 = path.join(root, "denyproj");
    mkdirSync(path.join(proj3, ".standardcode"), { recursive: true });
    writeFileSync(path.join(proj3, ".standardcode", "settings.local.json"), JSON.stringify({ schemaVersion: 1, permissions: { deny: ["Agent(risky)", "Bash(rm *)"] } }), "utf8");
    writeAgent(proj3, "risky.md", RISKY_MD);
    const s = makeSession({ home: path.join(root, "home-deny"), projectRoot: proj3, trusted: true });
    await s.agents.loadProjectAgents({ confirm: async () => true });
    const { ctx } = s.agents.prepareSpawn("risky");
    expect(ctx.deniedAgentTypes).toEqual(["risky"]);
    const v = await validateSpawn({ prompt: "t", subagentType: "risky", description: "d" }, { ...ctx, concurrentSubagents: 0 });
    expect(v).toMatchObject({ ok: false, code: "agent_denied" });
  });
});

describe("DoD⑤⑥：def.hooks 执行面注入+禁用位", () => {
  it("确认后的 def.hooks：agent 级 ToolHooks 真子进程 PreToolUse exit2=deny（blockingError 回灌）", async () => {
    const s = makeSession({ projectRoot: hookProjDir, trusted: true });
    await s.agents.loadProjectAgents({ confirm: async () => true });
    const { hooks } = s.agents.prepareSpawn("hookbot");
    expect(hooks).toBeDefined();
    const d = await hooks!.preToolUse("Read", { file_path: "x.txt" });
    expect(d).toMatchObject({ decision: "deny" });
    expect((d as { reason: string }).reason).toContain("hookbot-denied");
    // 无 hooks 定义=不注入（undefined 直通父面）
    expect(s.agents.prepareSpawn("wp10-bot").hooks).toBeUndefined();
  });
  it("未确认路：hooksRequested/hooks 被 gate 剥离=执行面零注入（SEC-070 生产闭环断言）", async () => {
    const s = makeSession({ home: path.join(root, "home-hk2"), projectRoot: path.join(root, "hk2proj"), trusted: true });
    mkdirSync(path.join(root, "hk2proj"), { recursive: true });
    writeAgent(path.join(root, "hk2proj"), "hookbot.md", `---
schemaVersion: 1
name: hookbot
description: hook holder
hooks: {"PreToolUse":[{"hooks":[{"type":"command","command":"node \\"${denyScript.replace(/\\/g, "\\\\")}\\" deny"}]}]}
---
hook body
`);
    await s.agents.loadProjectAgents({ confirm: async () => false });
    expect(s.agents.registry().get("hookbot")!.hooks).toBeUndefined();
    expect(s.agents.prepareSpawn("hookbot").hooks).toBeUndefined();
  });
  it("禁用位（DoD⑥ [自定] 键位 agents.projectDisabled，ADR-0043 决策 7）：true=整层不加载+confirm 零调用+留痕零写", async () => {
    const proj4 = path.join(root, "disproj");
    mkdirSync(proj4, { recursive: true });
    writeAgent(proj4, "risky.md", RISKY_MD);
    const asked: string[] = [];
    const s = makeSession({ home: path.join(root, "home-dis"), projectRoot: proj4, trusted: true, settings: { agents: { projectDisabled: true } } });
    const st = await s.agents.loadProjectAgents({ confirm: async (n) => { asked.push(n); return true; } });
    expect(st.disabled).toBe(true);
    expect(st.layerWithheld).toBe(true);
    expect(asked).toEqual([]);
    expect(s.agents.names()).not.toContain("risky");
    expect(s.agents.names()).toContain("general-purpose"); // built-in 层不受禁用位影响
    expect(st.warnings.join("\n")).toContain("agents.projectDisabled=true");
    // 禁用路不触碰留痕（先于读盘）
    expect(existsSync(path.join(proj4, ".standardcode", "settings.local.json"))).toBe(false);
  });
});
