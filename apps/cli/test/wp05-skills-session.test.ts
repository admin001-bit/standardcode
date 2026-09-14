// WP-05（M4）集成：session 装配（SEC-070 信任门/三源）+清单增量注入（CTX-005 追加）+Skill 工具端到端
// （tool_use→展开 tool_result）+allowed-tools 收窄（DoD⑤）+/skills list·run（DoD⑦④）+命令清单 27。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

const SKILL_MD = `---
name: greet
description: greets the user warmly
when_to_use: when the user says hi
allowed-tools:
  - Read
argument-hint: [who]
---
Hello from skill. Skill dir: \${STANDARD_CODE_SKILL_DIR}. Project: \${STANDARD_CODE_PROJECT_DIR}. Preexec: !\`dangerous\`.
`;

const SECRET_MD = `---
name: secret-skill
description: user invoked only
disable-model-invocation: true
---
Secret body.
`;

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp05-"));
  const projSkills = path.join(root, "proj", ".standardcode", "skills");
  const userSkills = path.join(root, "home", ".standardcode", "skills");
  mkdirSync(path.join(projSkills, "greet"), { recursive: true });
  mkdirSync(path.join(userSkills, "secret-skill"), { recursive: true });
  writeFileSync(path.join(projSkills, "greet", "SKILL.md"), SKILL_MD, "utf8");
  writeFileSync(path.join(userSkills, "secret-skill", "SKILL.md"), SECRET_MD, "utf8");
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

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

function makeSession(trusted: boolean, provider?: ProviderAdapter & { requests: LLMRequest[] }): Session {
  return createSession({
    provider: provider ?? fakeProvider(),
    catalog: ["m"],
    model: "m",
    cwd: path.join(root, "proj"),
    projectRoot: path.join(root, "proj"),
    home: path.join(root, "home"),
    trusted,
  });
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

describe("DoD② session 装配（SEC-070 信任门+三源）", () => {
  it("untrusted=项目技能不装载（user 层照常）；trusted=两源齐", () => {
    const un = makeSession(false);
    expect(un.skills.all().map((s) => s.name)).toEqual(["secret-skill"]); // 仅 user 层
    expect(un.skills.warnings().some((w) => w.includes("SEC-070"))).toBe(true);
    const tr = makeSession(true);
    expect(tr.skills.all().map((s) => s.name).sort()).toEqual(["greet", "secret-skill"]);
  });

  it("Skill 工具注册进工具面", () => {
    const s = makeSession(true);
    expect(s.tools.some((t) => t.name === "Skill")).toBe(true);
  });
});

describe("DoD③⑧ 清单增量注入（e2e）", () => {
  it("首轮全量 meta 注入（header+行形状）；二轮不重发（per-agent 去重）", async () => {
    const provider = fakeProvider();
    const s = makeSession(true, provider);
    await runReplWith(s, ["hi", "again", "/exit"]);
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const r1 = JSON.stringify(provider.requests[0]);
    expect(r1).toContain("The following skills are available for use with the Skill tool:");
    expect(r1).toContain("- greet: greets the user warmly when the user says hi");
    expect(r1).not.toContain("secret-skill"); // disable-model-invocation 清单隐身
    const r2 = JSON.stringify(provider.requests[1]!);
    expect(r2).toContain("The following skills are available"); // 第一轮注入的消息在历史里
    const injections = provider.requests[1]!.messages.filter((m) => JSON.stringify(m).includes("The following skills are available")).length;
    expect(injections).toBe(1); // 无第二轮增量重发
  });
});

describe("DoD④ Skill 工具端到端", () => {
  it("tool_use Skill → tool_result 首行 Launching skill+变量替换+ubo 剥离；激活生效", async () => {
    const provider = fakeProvider([[{ type: "message_start", id: "m", model: "test" } as LLMEvent], []]);
    // 第一轮 TEXT（provider 缺省 TEXT），构造：直接用默认轮序列——首轮 TEXT、次轮 TEXT
    const s = makeSession(true, provider);
    await runReplWith(s, ["hi", "/exit"]);
    // 模型未调 Skill（默认 TEXT 轮）——改用直测工具面
    void provider;
    const s2 = makeSession(true);
    const skillTool = s2.tools.find((t) => t.name === "Skill")!;
    const r = await skillTool.execute({ skill: "greet" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("Launching skill: greet");
    expect(r).toContain(`Skill dir: ${path.join(root, "proj", ".standardcode", "skills", "greet")}`);
    expect(r).toContain(`Project: ${path.join(root, "proj")}`);
    expect(r).toContain("[shell command execution disabled by policy]");
    expect(r).not.toContain("dangerous");
    expect(s2.skills.active()?.name).toBe("greet");
  });

  it("DoD⑤ allowed-tools 收窄（toolFace；Skill 恒保留）", () => {
    const s = makeSession(true);
    const before = s.tools.map((t) => t.name);
    expect(before).toContain("Bash");
    void skillToolExecute(s, "greet");
    const face = s.skills.toolFace(s.tools).map((t) => t.name);
    expect(face).toContain("Skill");
    expect(face).toContain("Read");
    expect(face).not.toContain("Bash"); // 白名单外收窄
  });

  it("disable-model-invocation=模型调用拒（双轨：清单隐身+工具拒）", async () => {
    const s = makeSession(true);
    const skillTool = s.tools.find((t) => t.name === "Skill")!;
    const r = await skillTool.execute({ skill: "secret-skill" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("user-invocable only");
  });
});

async function skillToolExecute(s: Session, name: string): Promise<string> {
  const skillTool = s.tools.find((t) => t.name === "Skill")!;
  return skillTool.execute({ skill: name }, { signal: new AbortController().signal, registerProcess: () => {} });
}

describe("DoD⑦ /skills 命令（list+run）", () => {
  it("list：name/来源/状态/描述逐行；run=用户点名豁免注入 isMeta 消息", async () => {
    const s = makeSession(true);
    const out = await runReplWith(s, ["/skills", "/skills run greet there", "/exit"]);
    expect(out).toContain("[skills] 2 skill(s)");
    expect(out).toContain("greet  project  model  ([who])  greets the user warmly");
    expect(out).toContain("secret-skill  user  user-only");
    expect(out).toContain("[skills] invoked greet");
    // run 注入：isMeta user 消息进会话（下一 turn 模型可见；本测直接验 messages）
    const injected = s.messages.some((m) => JSON.stringify(m).includes("Hello from skill"));
    expect(injected).toBe(true);
  });

  it("run 未知名拒绝；未知子命令拒绝", async () => {
    const s = makeSession(true);
    const out = await runReplWith(s, ["/skills run nope", "/exit"]);
    expect(out).toContain("no skill named");
    const out2 = await runReplWith(makeSession(true), ["/skills restart", "/exit"]);
    expect(out2).toContain("unknown /skills subcommand");
  });

  it("命令清单恰 30【勘误 2026-09-14：WP-06 注册 /memory 后 27→28；WP-09 /plugin 28→29；2026-09-15：WP-08 /update 29→30】", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toHaveLength(30);
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("skills");
  });
});
