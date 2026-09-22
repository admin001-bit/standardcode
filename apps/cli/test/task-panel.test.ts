// WP-05（M3）/tasks /background 命令测试（ORC-032 面板语义；判据自足：板 WP-05 DoD①+Tab）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS, parseTasksArgs } from "../src/commands.ts";
import { createSession } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { completeInput } from "../src/tab-complete.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("not used");
    },
    async *stream() {
      throw new Error("nope");
    },
    countTokens: async () => 0,
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "sc-wp05-"));
  const session = createSession({ provider: fakeProvider(), catalog: ["m"], model: "m", cwd: root, projectRoot: root });
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: () => {}, close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("DoD① /tasks 参数语义（active_only/limit 边界 1–100）", () => {
  it("parseTasksArgs：缺省 activeOnly=true limit=20；all/数字组合；越界与多数字抛错", () => {
    expect(parseTasksArgs("")).toEqual({ activeOnly: true, limit: 20 });
    expect(parseTasksArgs("all")).toEqual({ activeOnly: false, limit: 20 });
    expect(parseTasksArgs("50")).toEqual({ activeOnly: true, limit: 50 });
    expect(parseTasksArgs("all 100")).toEqual({ activeOnly: false, limit: 100 });
    expect(() => parseTasksArgs("0")).toThrow(/1,100/);
    expect(() => parseTasksArgs("101")).toThrow(/1,100/);
    expect(() => parseTasksArgs("2.5")).toThrow(/1,100/);
    expect(() => parseTasksArgs("5 10")).toThrow(/multiple numbers/);
  });

  it("/tasks 默认仅列活跃；all 含终态；limit 截断", () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const reg = session.taskRegistry;
      const a = reg.register({ agentId: "a", agentType: "general-purpose", description: "task a", isBackgrounded: true });
      reg.takeConcurrencySlot(a.taskId);
      reg.complete(a.taskId, { content: "r", totalTokens: 7, totalToolUseCount: 2, totalDurationMs: 3, doneReason: "end" });
      const b = reg.register({ agentId: "b", agentType: "general-purpose", description: "task b", isBackgrounded: false });
      reg.takeConcurrencySlot(b.taskId);
      const t1 = ctx.tasks("").text;
      expect(t1).toContain(b.taskId);
      expect(t1).not.toContain(`${a.taskId} [`);
      const t2 = ctx.tasks("all").text;
      expect(t2).toContain(a.taskId);
      expect(t2).toContain(b.taskId);
      const t3 = ctx.tasks("1").text;
      expect(t3).toContain("1/1");
      expect(() => ctx.tasks("999")).toThrow(/1,100/);
    } finally {
      cleanup();
    }
  });

  it("/background 挂后台清单（isBackgrounded 过滤）", () => {
    const { session, ctx, cleanup } = fixture();
    try {
      const reg = session.taskRegistry;
      const a = reg.register({ agentId: "a", agentType: "general-purpose", description: "bg task", isBackgrounded: true });
      reg.register({ agentId: "b", agentType: "general-purpose", description: "sync task", isBackgrounded: false });
      const r = ctx.background().text;
      expect(r).toContain(a.taskId);
      expect(r).toContain("bg task");
      expect(r).not.toContain("sync task");
    } finally {
      cleanup();
    }
  });
});

describe("命令全集与 Tab 补全（UI-001）", () => {
  it("registry 恰三十二（M2 十八+M3 七+M4 五件+M7 /goal【M7-WP-01，2026-09-19：30→31】）", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toEqual([
      "help", "clear", "exit", "model", "permission", "rewind", "context", "diff", "new", "resume", "rename",
      "compact", "config", "provider", "doctor", "cd", "add-dir", "reload",
      "tasks", "background", "subtask", "effort", "init", "status", "usage", "mcp", "skills", "memory", "plugin", "update", "goal", "theme", "keybindings",
    ]);
    expect(completeInput("/ta", CLI_COMMANDS).insert).toBe("/tasks ");
    expect(completeInput("/back", CLI_COMMANDS).insert).toBe("/background ");
  });
});
