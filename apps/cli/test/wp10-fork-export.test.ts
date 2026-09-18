// M6-WP-10：fork 型 subagent 与 /fork /export 两命令（DoD①②③④⑤）。
// 判据自足：
//   ① 门组合五态（DoD④ 判据面）：默认关=注册表逐字等于 CLI_COMMANDS 恰 30；workflow 开=31；fork 开=32（fork+export）；
//      三 flag 全开=33；deferred 四件（branch/batch/loop/btw）任何门态零注册；CLI_COMMANDS 仍恰 30 且不含 fork/export/workflows
//      （M6 除名族逐名核对=M5 wp10-milestone 断言零改动的实证面）。
//   ② fork 派生（DoD①）：走 spawnSubagentTask 同一入口=ORC-022 校验序列复用（refused 路=deny 规则实证）；
//      fork 携带父转录（复合形 [自定]）+后台 async_launched（[CC] isAsync:!0）+空会话 fail-closed（[CC] prompt_missing 同构）。
//   ③ /export（DoD③）：落盘 <cwd>/export-<sessionId>.md；已存在=拒绝点名（fail-closed）；writer 缺席=点名；空会话=拒绝。
//   ④ description slug 非缺省形与回落 "fork" 形（[CC] Te 同构）；fork prompt 条数上限非缺省形覆盖。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMMessage, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS, type SlashCommand } from "../src/commands.ts";
import {
  EXPERIMENTAL_DEFERRED_COMMANDS,
  EXPERIMENTAL_FLAG_COMMANDS,
  activeExperimentalCommandNames,
  experimentalCommandImplementations,
  gatedRegistry,
} from "../src/experimental-gate.ts";
import type { ExperimentalGate } from "@standardcode/platform";
import { createCommandContext, runRepl, type ReplDeps } from "../src/repl.ts";
import { DEFAULT_FORK_INSTRUCTION, FORK_HISTORY_MAX_MESSAGES, deriveForkDescription, renderForkContextPrompt } from "../src/fork-command.ts";
import { exportTargetPath, renderSessionMarkdown } from "../src/export-command.ts";
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
        { type: "text_delta", text: "reply" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

let root: string;
let homeDir: string;
let projDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp10-fork-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function makeSession(): Session {
  return createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir });
}

function ctxOf(s: Session, out?: string[]) {
  return createCommandContext({ session: s, io: { lines: (async function* () {})(), write: (x) => out?.push(x), close: () => {} } });
}

const gateWith = (flags: string[]): ExperimentalGate => ({ enabled: true, flags: flags as unknown as ExperimentalGate["flags"], notices: [] });
const closed = { enabled: false, flags: [], notices: [] } as ExperimentalGate;
const workflowOpen = gateWith(["workflow"]);
const forkOpen = gateWith(["fork"]);
const allOpen = gateWith(["workflow", "teams", "fork"]);

describe("DoD④ 门组合五态（注册数 N 与断言一致=M6 除名族逐名核对）", () => {
  it("默认关：注册表逐字（名字+顺序）等于 CLI_COMMANDS 且恰 30，fork/export/workflows 全缺席", () => {
    const reg = gatedRegistry(closed);
    expect(reg.map((c) => c.name)).toEqual(CLI_COMMANDS.map((c) => c.name));
    expect(reg).toHaveLength(30);
    for (const n of ["fork", "export", "workflows"]) expect(reg.find((c) => c.name === n)).toBeUndefined();
  });

  it("workflow 开=31（尾项 workflows）；fork 开=32（fork+export，无 workflows）；三 flag 全开=33", () => {
    const wf = gatedRegistry(workflowOpen);
    expect(wf).toHaveLength(31);
    expect(wf.at(-1)!.name).toBe("workflows");
    const fk = gatedRegistry(forkOpen);
    expect(fk).toHaveLength(32);
    const fkNames = fk.map((c) => c.name);
    expect(fkNames).toContain("fork");
    expect(fkNames).toContain("export");
    expect(fkNames).not.toContain("workflows");
    expect(gatedRegistry(allOpen)).toHaveLength(33);
  });

  it("deferred 四件（branch/batch/loop/btw）在任何门态都不注册（恒不放行）", () => {
    for (const gate of [closed, workflowOpen, forkOpen, allOpen]) {
      const names = gatedRegistry(gate).map((c) => c.name);
      for (const d of EXPERIMENTAL_DEFERRED_COMMANDS) {
        expect(names, `deferred /${d} 在门态 [${gate.flags.join(",")}] 不得注册`).not.toContain(d);
      }
    }
  });

  it("CLI_COMMANDS 守恒恰 30 且不含 M6 三件（除名族逐名核对=workflows/fork/export）；实现面恰三件", () => {
    expect(CLI_COMMANDS).toHaveLength(30);
    for (const n of ["workflows", "fork", "export"]) expect(CLI_COMMANDS.map((c) => c.name)).not.toContain(n);
    expect(EXPERIMENTAL_FLAG_COMMANDS.fork).toEqual(["fork", "export"]);
    expect([...activeExperimentalCommandNames(forkOpen)].sort()).toEqual(["export", "fork"]);
    expect(experimentalCommandImplementations().map((c) => c.name).sort()).toEqual(["export", "fork", "workflows"]);
  });

  it("fork 开态两命令 description 标 experimental（plain 英文，不进 i18n）", () => {
    const reg = gatedRegistry(forkOpen);
    for (const n of ["fork", "export"]) expect(reg.find((c) => c.name === n)!.description).toContain("experimental");
  });
});

describe("DoD① fork 派生（复用 ORC-022 校验序列＋携带父转录＋后台异步）", () => {
  it("fork 派生成功：async_launched 回显 taskId/agentId-internal、注册表在案、prompt 携带 <fork-context> 父消息与 <fork-task> 指令", async () => {
    const provider = fakeProvider();
    const s = createSession({ provider, catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir });
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed message one" }] });
    s.messages.push({ role: "assistant", content: [{ type: "text", text: "parent reply two" }] });
    const deps: ReplDeps = { session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, "repl-store-fk") };
    const r = await createCommandContext(deps).fork("inspect the state");
    const task = s.taskRegistry.list()[0]!;
    expect(task.isBackgrounded).toBe(true);
    expect(["running", "completed"]).toContain(task.status); // 后台注册即返回（完成时点与断言竞速，两态皆合法）
    expect(r.text).toContain(`background task ${task.taskId}`);
    expect(r.text).toContain("internal - do not mention to user");
    expect(r.text).toContain("agent general-purpose"); // 类型缺省形
    await new Promise((res) => setTimeout(res, 80)); // 后台任务跑完（fakeProvider 即返）
    expect(provider.requests.length).toBe(1);
    const firstContent = provider.requests[0]!.messages[0]!.content as { type: string; text: string }[];
    const forkPrompt = firstContent[0]!.text;
    expect(forkPrompt).toContain("<fork-context>");
    expect(forkPrompt).toContain("[user] seed message one");
    expect(forkPrompt).toContain("[assistant] parent reply two");
    expect(forkPrompt).toContain("<fork-task>");
    expect(forkPrompt).toContain("inspect the state");
    expect(task.description).toBe("inspect-the-state"); // slug 非回落形
  });

  it("空会话 fail-closed（[CC] subagent_fork_prompt_missing 同构）：点名报错不 spawn", async () => {
    const s = makeSession();
    const ctx = ctxOf(s);
    await expect(ctx.fork("anything")).rejects.toThrow("cannot fork an empty session");
    expect(s.taskRegistry.list()).toHaveLength(0);
  });

  it("复用 ORC-022 校验序列：Agent(general-purpose) deny 规则 → refused 点名（校验在 fork 通道内真实生效）", async () => {
    const denyProj = path.join(root, "proj-deny");
    const dir = path.join(denyProj, ".standardcode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify({ schemaVersion: 1, permissions: { deny: ["Agent(general-purpose)"] } }), "utf8");
    const s = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: denyProj, projectRoot: denyProj, home: path.join(root, "home-deny2"), trusted: true });
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const r = await ctxOf(s).fork("general-purpose should be refused"); // 显式指定被拒类型（harness 段③只查显式 subagentType=既有校验语义，不改）
    expect(r.text).toContain("[fork] refused:");
    expect(s.taskRegistry.list()).toHaveLength(0); // refused=无任务残留
  });

  it("类型首词非缺省形：args 首词命中注册表类型名=类型解析（splitSubtaskType 语义同族）", async () => {
    const s = makeSession();
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const r = await ctxOf(s).fork("General-Purpose do a thing");
    expect(r.text).toContain("agent general-purpose"); // 大小写不敏感解析到内置类型（非缺省 args 形）
    await new Promise((res) => setTimeout(res, 80));
  });
});

describe("DoD③ /export（落盘+拒绝面）", () => {
  it("runRepl 端到端：导出落 <cwd>/export-<sessionId>.md；二次导出=已存在拒绝点名（不静默覆盖）", async () => {
    const s = makeSession();
    const out: string[] = [];
    await runRepl({
      session: s,
      io: {
        lines: (async function* () {
          for (const l of ["hello fork export", "/export", "/export", "/exit"]) yield l;
        })(),
        write: (x) => out.push(x),
        close: () => {},
      },
      commands: gatedRegistry(forkOpen),
      baseDir: path.join(root, "repl-store-ex"),
    });
    const text = out.join("\n");
    expect(text).toMatch(/\[export\] wrote \d+ message\(s\) to .+export-[0-9a-f-]+\.md/);
    const target = text.match(/to (.+export-[0-9a-f-]+\.md)/)![1]!;
    expect(existsSync(target)).toBe(true);
    const md = readFileSync(target, "utf8");
    expect(md).toContain("# Session export");
    expect(md).toContain("## user");
    expect(md).toContain("hello fork export");
    expect(md).toContain("## assistant");
    expect(text).toContain("target already exists, refusing to overwrite"); // 第二次导出拒绝
  });

  it("writer 缺席=点名报错（转录不可用同族）；带参=点名拒绝", async () => {
    const s = makeSession();
    const ctx = ctxOf(s);
    await expect(ctx.exportSession("")).rejects.toThrow(/transcript/); // en/zh 两文案均含 "transcript"
    await expect(ctx.exportSession("extra args")).rejects.toThrow("takes no arguments");
  });

  it("空会话=拒绝（writer 在位的 runRepl 空会话路径）", async () => {
    const s = makeSession();
    const out: string[] = [];
    await runRepl({
      session: s,
      io: {
        lines: (async function* () {
          for (const l of ["/export", "/exit"]) yield l;
        })(),
        write: (x) => out.push(x),
        close: () => {},
      },
      commands: gatedRegistry(forkOpen),
      baseDir: path.join(root, "repl-store-empty"),
    });
    expect(out.join("\n")).toContain("session is empty: nothing to export");
  });
});

describe("DoD② 命令体薄壳（门内注册可执行）", () => {
  it("/fork 命令体经 gatedRegistry 执行（薄壳→ctx.fork 全链）", async () => {
    const s = makeSession();
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const out: string[] = [];
    const cmd = gatedRegistry(forkOpen).find((c: SlashCommand) => c.name === "fork")!;
    await cmd.execute("from the command body", ctxOf(s, out));
    expect(out.join("\n")).toContain("[fork] dispatched (background task");
    await new Promise((res) => setTimeout(res, 80));
  });

  it("/export 命令体薄壳转发 args（带参=拒绝路径）", async () => {
    const s = makeSession();
    const cmd = gatedRegistry(forkOpen).find((c: SlashCommand) => c.name === "export")!;
    await expect(cmd.execute("bogus", ctxOf(s))).rejects.toThrow("takes no arguments");
  });
});

describe("[CC] Te slug 同构与 fork prompt 上限（非缺省形覆盖）", () => {
  it("deriveForkDescription：3 词 slug/特殊字符清洗/截 24/空回落 fork", () => {
    expect(deriveForkDescription("Fix the login bug")).toBe("fix-the-login");
    expect(deriveForkDescription("A B C D E")).toBe("a-b-c"); // 前 3 词
    expect(deriveForkDescription("Hello, World! & stuff")).toBe("hello-world"); // "&" 清洗后空、尾 "-" 去除（[CC] Te 同构实测）
    expect(deriveForkDescription("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bb")).toBe("aaaaaaaaaaaaaaaaaaaaaaaa"); // slice(0,24)=24 字符
    expect(deriveForkDescription("")).toBe("fork"); // 回落形
    expect(deriveForkDescription("!!! ???")).toBe("fork"); // 清洗后空=回落形
  });

  it("renderForkContextPrompt：条数上限取尾部（非缺省形=超限消息）；非文本块占位", () => {
    const msgs: LLMMessage[] = [];
    for (let i = 0; i < FORK_HISTORY_MAX_MESSAGES + 5; i++) msgs.push({ role: "user", content: [{ type: "text", text: `m${i}` }] });
    const prompt = renderForkContextPrompt(msgs, DEFAULT_FORK_INSTRUCTION);
    expect(prompt).toContain(`(${FORK_HISTORY_MAX_MESSAGES} message(s)`);
    expect(prompt).toContain(`[user] m${FORK_HISTORY_MAX_MESSAGES + 4}`); // 尾部保留
    expect(prompt).not.toContain("[user] m0\n"); // 头部裁剪
    expect(prompt).toContain(DEFAULT_FORK_INSTRUCTION);
    const withTool = renderForkContextPrompt([{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } as unknown as LLMMessage], "go");
    expect(withTool).toContain("[tool_use]");
  });

  it("renderSessionMarkdown 与 exportTargetPath：元数据头与落点形状", () => {
    const md = renderSessionMarkdown({ sessionId: "sid-123", exportedAt: "2026-09-19T00:00:00.000Z", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(md).toContain("- sessionId: sid-123");
    expect(md).toContain("- exportedAt: 2026-09-19T00:00:00.000Z");
    expect(md).toContain("- messages: 1");
    expect(exportTargetPath("/tmp/w", "sid-123")).toBe(path.join("/tmp/w", "export-sid-123.md"));
  });
});
