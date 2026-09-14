// M4-WP-09 集成：session 四注入面生效断言（DoD④：agents 注册表 plugin 层链位/skills plugin 源/
// hooks plugin 配置源受信任门/mcpServers loader plugin 合并位）+/plugin install·list·remove 端到端
// （DoD③ S-5 确认对话框：once=落、非 once=零落地、无确认 UI=fail-closed）+命令清单 29 适配（DoD⑥）。
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { installPlugin } from "@standardcode/platform";
import { createAgentRegistry } from "@standardcode/harness";
import { CLI_COMMANDS } from "../src/commands.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";
import type { ConfirmChoice, ConfirmPrompt } from "../src/confirm.ts";

const SKILL_MD = `---
name: wp09-hello
description: plugin-provided greeter skill
---
Plugin skill body.
`;

const AGENT_MD = `---
name: wp09-bot
description: plugin-provided agent
schemaVersion: 1
---
You are a plugin agent.
`;

let root: string;
let homeDir: string;
let projDir: string;
let srcDir: string; // 待装插件源
let denyScript: string; // hook 夹具（exit 2 + stderr）

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp09-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(projDir, { recursive: true });
  denyScript = path.join(root, "hook-fixture.js");
  writeFileSync(denyScript, 'if (process.argv[2] === "deny") { process.stderr.write("blocked-by-wp09-plugin"); process.exit(2); }\n', "utf8");
  srcDir = path.join(root, "suite-src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    path.join(srcDir, "plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: "wp09-suite",
        version: "1.2.0",
        commands: ["cmd-a"],
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${denyScript}" deny` }] }] },
        mcpServers: { "wp09-srv": { type: "stdio", command: "node", args: [path.join(root, "no-such-mcp-server.js")] } },
      },
      null,
      2,
    ),
    "utf8",
  );
  mkdirSync(path.join(srcDir, "skills", "wp09-hello"), { recursive: true });
  writeFileSync(path.join(srcDir, "skills", "wp09-hello", "SKILL.md"), SKILL_MD, "utf8");
  mkdirSync(path.join(srcDir, "agents"), { recursive: true });
  writeFileSync(path.join(srcDir, "agents", "wp09-bot.md"), AGENT_MD, "utf8");
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
      requests.push(req);
      for (const ev of [
        { type: "message_start", id: "m", model: "test" },
        { type: "text_delta", text: "ok" },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

function makeSession(): Session {
  return createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir, trusted: true });
}

async function installSuite(): Promise<void> {
  const out = await installPlugin(srcDir, { baseDir: path.join(homeDir, ".standardcode") });
  if (!out.ok && out.error !== "exists") throw new Error(`fixture install failed: ${out.error} ${out.warnings.join("; ")}`);
}

async function runLines(s: Session, lines: string[], confirm?: ConfirmPrompt): Promise<string> {
  const out: string[] = [];
  const queue = [...lines];
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of queue) yield l;
    })(),
    write: (x) => out.push(x),
    close: () => {},
  };
  await runRepl({ session: s, io, ...(confirm ? { confirm } : {}), baseDir: path.join(root, "repl-store") });
  return out.join("\n");
}

describe("DoD③④：装好插件后的会话装配=四注入面生效", () => {
  it("skills→WP-05 plugin 源：清单含 source=plugin 件", async () => {
    await installSuite();
    const s = makeSession();
    const sk = s.skills.all().find((x) => x.name === "wp09-hello");
    expect(sk).toBeDefined();
    expect(sk!.source).toBe("plugin");
  });
  it("agents→注册表 plugin 层（链位 built-in<plugin<user）：session.plugins.agents() 直喂 createAgentRegistry", async () => {
    await installSuite();
    const s = makeSession();
    const defs = s.plugins.agents();
    expect(defs.map((d) => d.name)).toContain("wp09-bot");
    const reg = createAgentRegistry({ sources: { plugin: defs } });
    expect(reg.get("wp09-bot")!.source).toBe("plugin"); // plugin 层位（注册表内建链=注记"消费位就绪"）
    const userOverride = createAgentRegistry({ sources: { plugin: defs, user: [{ name: "wp09-bot", description: "user wins" }] } });
    expect(userOverride.get("wp09-bot")!.source).toBe("user"); // 链位：user>plugin
    const beatsBuiltIn = createAgentRegistry({ sources: { plugin: [{ name: "Explore", description: "plugin shadow" }] } });
    expect(beatsBuiltIn.get("explore")!.source).toBe("plugin"); // 链位：plugin>built-in
  });
  it("hooks→WP-04 配置源：PreToolUse 插件 hook 真子进程 exit2 阻断+decisionReason 来源=plugin", async () => {
    await installSuite();
    const s = makeSession();
    const o = await s.hooks.gate("PreToolUse", { toolName: "Read" }, { tool_name: "Read", tool_input: {} });
    expect(o.verdict).toBe("deny");
    expect(o.blockingError).toContain("blocked-by-wp09-plugin");
    expect(o.decisionReason?.hookSource).toBe("plugin");
  });
  it("mcpServers→WP-01 loader plugin 合并位：raw 全集含 origin=plugin 件；非 projectShared 无 S-3 门=approved", async () => {
    await installSuite();
    const s = makeSession();
    await s.mcpReady;
    const raw = s.mcpRawServers.find((x) => x.name === "wp09-srv");
    expect(raw).toBeDefined();
    expect(raw!.origin).toBe("plugin");
    expect(s.mcpGateStates.find((x) => x.name === "wp09-srv")!.state).toBe("approved");
    await Promise.allSettled(s.mcpConnections.map((c) => c.close()));
  });
  it("未信任会话：插件 hooks 仍受引擎信任门（安装确认≠信任确认，两门都要=卡边界）", async () => {
    await installSuite();
    const s = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir, trusted: false });
    const o = await s.hooks.gate("PreToolUse", { toolName: "Read" }, { tool_name: "Read", tool_input: {} });
    expect(o.verdict).toBeNull(); // 信任门跳全部（:262013 形状）——插件组不豁免
  });
});

describe("DoD③ S-5 安装确认对话框（once=落盘/非 once=零落地/无 UI=fail-closed）", () => {
  const seen: { toolLabel: string; detail: string }[] = [];
  const confirmWith = (choice: ConfirmChoice): ConfirmPrompt => ({
    async confirm(toolLabel, detail) {
      seen.push({ toolLabel, detail });
      return choice;
    },
  });

  it("once：对话框展示组件清单（N commands/agents/skills+hooks 事件+MCP 逐名）→安装成功+留痕", async () => {
    const s = makeSession();
    seen.length = 0;
    const src2 = path.join(root, "confirm-once-src");
    mkdirSync(src2, { recursive: true });
    writeFileSync(path.join(src2, "plugin.json"), JSON.stringify({ schemaVersion: 1, name: "confirm-once", version: "0.1.0", commands: ["cc"], mcpServers: { "cc-srv": { command: "node" } } }), "utf8");
    const out = await runLines(s, [`/plugin install ${src2}`, "/plugin list", "/exit"], confirmWith("once"));
    const ask = seen[0]!;
    expect(ask.toolLabel).toBe("plugin:confirm-once");
    expect(ask.detail).toContain("1 command(s)");
    expect(ask.detail).toContain("0 agent(s)");
    expect(ask.detail).toContain("0 skill(s)");
    expect(ask.detail).toContain("MCP servers: [cc-srv]");
    expect(out).toContain("[plugin] installed confirm-once v0.1.0");
    expect(out).toContain("confirm-once"); // list 即时读盘
    expect(s.plugins.installed().some((v) => v.record.name === "confirm-once")).toBe(true);
  });
  it("deny（含 always 同拒——起步注记裁决 once=安装批准）：零落地无半程状态", async () => {
    const s = makeSession();
    for (const choice of ["deny", "always"] as ConfirmChoice[]) {
      seen.length = 0;
      const src3 = path.join(root, `confirm-${choice}-src`);
      mkdirSync(src3, { recursive: true });
      writeFileSync(path.join(src3, "plugin.json"), JSON.stringify({ schemaVersion: 1, name: `nosettle-${choice}`, version: "0.1.0" }), "utf8");
      const out = await runLines(s, [`/plugin install ${src3}`, "/exit"], confirmWith(choice));
      expect(seen[0]!.toolLabel).toBe(`plugin:nosettle-${choice}`);
      expect(out).toContain("install declined — nothing landed");
      expect(s.plugins.installed().some((v) => v.record.name.startsWith("nosettle"))).toBe(false);
    }
  });
  it("无确认 UI（非交互）=fail-closed 拒绝，不落任何写盘（S-5/SEC-020）", async () => {
    const s = makeSession();
    const src4 = path.join(root, "confirm-noui-src");
    mkdirSync(src4, { recursive: true });
    writeFileSync(path.join(src4, "plugin.json"), JSON.stringify({ schemaVersion: 1, name: "noui", version: "0.1.0" }), "utf8");
    const out = await runLines(s, [`/plugin install ${src4}`, "/exit"]); // deps.confirm 缺席
    expect(out).toContain("requires explicit confirmation");
    expect(s.plugins.installed().some((v) => v.record.name === "noui")).toBe(false);
  });
});

describe("DoD⑤⑥：list/remove+命令清单 29 适配", () => {
  it("remove：目录级清理+留痕删（大小写不敏感）；未知名报错", async () => {
    await installSuite();
    const s = makeSession();
    const dir = s.plugins.installed().find((v) => v.record.name === "wp09-suite")!.record.dir;
    let out = await runLines(s, ["/plugin remove wp09-SUITE", "/plugin list", "/exit"]);
    expect(out).toContain("removed wp09-SUITE");
    expect(existsSync(dir)).toBe(false); // 目录级清理（install dir 实删）
    expect(out).not.toContain("wp09-suite"); // list 不再含该件（大小写敏感面）
    out = await runLines(makeSession(), ["/plugin remove ghost", "/exit"]);
    expect(out).toContain("not found");
  });
  it("子命令面：未知子命令/参数校验（err 键全经 catalog）", async () => {
    const s = makeSession();
    let out = await runLines(s, ["/plugin frobnicate", "/exit"]);
    expect(out).toContain("unknown /plugin subcommand");
    out = await runLines(s, ["/plugin install", "/exit"]);
    expect(out).toContain("target required");
    out = await runLines(s, ["/plugin remove", "/exit"]);
    expect(out).toContain("plugin name required");
    out = await runLines(s, ["/plugin list extra", "/exit"]);
    expect(out).toContain("unexpected argument");
  });
  it("命令清单恰 29（DoD⑥：/plugin 为 M4 第 29 件注册；计划编号 30 含 /update=WP-08 未注册）", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(names).toHaveLength(29);
    expect(names).toContain("plugin");
  });
});
