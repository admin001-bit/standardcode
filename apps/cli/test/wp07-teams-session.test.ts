// WP-07（M6）Teams 会话装配单测：工具面真注册（WP-06 遗留五随本卡落地）+ DoD⑤ 默认关=零文件零副作用。
// 判据自足（板 WP-07 DoD④⑤ + 承接 WP-06 未解决②④）：
//   ④"main" 恒路由主对话——to:"main" 投递进会话 drain 缓冲（repl runPromptTurn 消费）；agentId 不向用户暴露面
//     =spawnAddressingNote 逐字（roster 件已锁，此处不重复）
//   ⑤flag 默认关=零文件零副作用：gate 关（缺席/总闸关/白名单未含 teams）→ SendMessage 零注册 + teams 目录零创建
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession } from "../src/session.ts";
import { SEND_MESSAGE_TOOL_NAME, TEAMMATE_DEFAULT_LEAD_NAME } from "@standardcode/capabilities";
import type { ProviderAdapter } from "@standardcode/providers";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in WP-07 session tests");
    },
    countTokens: async () => 0,
  };
}

const GATE_TEAMS_ON = { enabled: true, flags: ["teams"] as const, notices: [] };
const GATE_WORKFLOW_ONLY = { enabled: true, flags: ["workflow"] as const, notices: [] };

function makeHome(): string {
  return process.env.TEMP ? path.join(process.env.TEMP!, `wp07-home-${Date.now()}-${Math.random().toString(36).slice(2)}`) : path.join(tmpdir(), `wp07-home-${Date.now()}`);
}

describe("DoD⑤ flag 默认关=零注册零文件零副作用", () => {
  it("gate 缺席（默认关）：SendMessage 零注册、drain 恒空、teams 目录零创建", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home });
    expect(session.tools.some((t) => t.name === SEND_MESSAGE_TOOL_NAME)).toBe(false);
    expect(session.teamRoster).toBeUndefined();
    expect(session.drainTeammateMessages()).toEqual([]);
    expect(existsSync(path.join(home, ".standardcode", "projects"))).toBe(false); // 零触盘
  });

  it("总闸开但白名单未含 teams：SendMessage 仍零注册", () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: GATE_WORKFLOW_ONLY });
    expect(session.tools.some((t) => t.name === SEND_MESSAGE_TOOL_NAME)).toBe(false);
    expect(existsSync(path.join(home, ".standardcode", "projects"))).toBe(false);
  });
});

describe("teams flag 活跃：工具面真注册 + main 路由 + mailbox 持久化", () => {
  it("SendMessage 注册进 session.tools；roster 在位；既有工具面零回归（只增不删）", () => {
    const home = makeHome();
    const off = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home });
    const on = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: GATE_TEAMS_ON });
    expect(on.tools.some((t) => t.name === SEND_MESSAGE_TOOL_NAME)).toBe(true);
    expect(on.teamRoster).toBeDefined();
    expect(on.tools.filter((t) => t.name !== SEND_MESSAGE_TOOL_NAME).map((t) => t.name).sort())
      .toEqual(off.tools.map((t) => t.name).sort()); // 既有面零变化（只增 SendMessage 一件）
  });

  it('to:"main" 恒路由主对话：投递进 drain 缓冲（once-only），渲染为 lead 前缀 user turn 文本', async () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: GATE_TEAMS_ON });
    const tool = session.tools.find((t) => t.name === SEND_MESSAGE_TOOL_NAME)!;
    await tool.execute({ to: "main", message: "check the build" }, { } as never);
    const drained = session.drainTeammateMessages();
    expect(drained).toEqual([`${TEAMMATE_DEFAULT_LEAD_NAME}: check the build`]); // A 级 §4.1 j3({from,text}) 同构
    expect(session.drainTeammateMessages()).toEqual([]); // once-only
  });

  it("to=成员 → 文件 mailbox 落盘（BLK-07=① 跨 teammate 载体）；重名成员自动去重后各自收信", async () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: GATE_TEAMS_ON });
    const tool = session.tools.find((t) => t.name === SEND_MESSAGE_TOOL_NAME)!;
    const roster = session.teamRoster!;
    const m1 = roster.addMember("researcher");
    roster.addMember("researcher");
    await tool.execute({ to: m1.name, message: "first" }, {} as never);
    await tool.execute({ to: m1.agentId, message: "by-id" }, {} as never); // agentId 寻址同成员
    // 目录形状：<home>/.standardcode/projects/<enc cwd>/teams/<team>/<member>.inbox.json——从落盘侧全枚举
    const projectsDir = path.join(home, ".standardcode");
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else all.push(p);
      }
    };
    walk(projectsDir);
    const inboxFiles = all.filter((p) => p.endsWith(".inbox.json"));
    expect(inboxFiles.length).toBeGreaterThanOrEqual(1); // 重名去重后 researcher 与 researcher-2 各一文件
    for (const f of inboxFiles) {
      const parsed = JSON.parse(readFileSync(f, "utf8"));
      expect(Array.isArray(parsed)).toBe(true); // 顶层数组（A 级 §5）
      for (const entry of parsed) {
        expect(typeof entry.text).toBe("string");
        expect(entry.from).toBe(TEAMMATE_DEFAULT_LEAD_NAME);
      }
    }
    const flat = inboxFiles.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).map((e: { text: string }) => e.text));
    expect(flat.filter((t) => t === "first" || t === "by-id").sort()).toEqual(["by-id", "first"]);
  });

  it("未知收件人 → not_reachable 失败文案（经 WP-06 失败归一）；lead 自发 team-lead → invalid_target", async () => {
    const home = makeHome();
    const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", home, cwd: home, experimental: GATE_TEAMS_ON });
    const tool = session.tools.find((t) => t.name === SEND_MESSAGE_TOOL_NAME)!;
    await expect(tool.execute({ to: "ghost", message: "x" }, {} as never)).resolves.toContain("not_reachable");
    await expect(tool.execute({ to: TEAMMATE_DEFAULT_LEAD_NAME, message: "x" }, {} as never)).resolves.toContain("invalid_target");
  });
});
