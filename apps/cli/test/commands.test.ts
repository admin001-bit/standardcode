// DoD②：五命令注册与行为（/help 列全表、/model 经目录切换、/permission EXE-001 循环、/clear、/exit）；B-03 五命令之外不注册。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import { createSession, PERMISSION_CYCLE, PERMISSION_LABEL } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";

function fixture() {
  const session = createSession({ provider: fakeProvider(), catalog: ["m-a", "m-b"], model: "m-a" });
  const out: string[] = [];
  const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (s) => out.push(s), close: () => {} } };
  const ctx = createCommandContext(deps);
  return { session, out, ctx };
}

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("not used in command tests");
    },
    countTokens: async () => 0,
  };
}

describe("命令注册（M1 最小集+M2 WP-09 增量；§8.2 分期，B-03 只注册本里程碑命令）", () => {
  it("registry 恰七命令（M1 五+M2 /rewind /diff；WP-10/11 再增）", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toEqual(["help", "clear", "exit", "model", "permission", "rewind", "diff"]);
  });

  it("/help 列全表", () => {
    const { ctx, out } = fixture();
    CLI_COMMANDS[0]!.execute("", ctx);
    for (const c of CLI_COMMANDS) expect(out.join("\n")).toContain(`/${c.name}`);
  });

  it("/model 无参列目录并标当前；有参切换；未知报错", () => {
    const { ctx, out, session } = fixture();
    CLI_COMMANDS[3]!.execute("", ctx);
    expect(out.join("\n")).toContain("* m-a");
    CLI_COMMANDS[3]!.execute("m-b", ctx);
    expect(session.model).toBe("m-b");
    expect(() => CLI_COMMANDS[3]!.execute("m-nope", ctx)).toThrow(/unknown model: m-nope/);
    expect(session.model).toBe("m-b"); // 切换失败保持原值
  });

  it("/permission 无参按 EXE-001 循环；有参直设；非法报错", () => {
    const { ctx, out, session } = fixture();
    expect(session.broker.mode()).toBe("default");
    for (const expected of ["acceptEdits", "plan", "bypassPermissions", "default"]) {
      CLI_COMMANDS[4]!.execute("", ctx);
      expect(session.broker.mode()).toBe(expected);
    }
    expect(out.join("\n")).toContain(PERMISSION_LABEL.plan);
    CLI_COMMANDS[4]!.execute("plan", ctx);
    expect(session.broker.mode()).toBe("plan");
    expect(() => CLI_COMMANDS[4]!.execute("auto", ctx)).toThrow(/unknown mode/);
    expect(PERMISSION_CYCLE).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("/clear 清历史；/exit 置退出标志", () => {
    const { ctx, session } = fixture();
    session.messages.push({ role: "user", content: [{ type: "text", text: "x" }] });
    CLI_COMMANDS[1]!.execute("", ctx);
    expect(session.messages).toHaveLength(0);
    expect(session.exitRequested).toBe(false);
    CLI_COMMANDS[2]!.execute("", ctx);
    expect(session.exitRequested).toBe(true);
  });
});
