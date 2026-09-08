// DoD：命令注册与行为（M1 五命令+/rewind /diff=M2 WP-09；§8.2 分期，B-03 之外不注册）。
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@standardcode/providers";
import { CLI_COMMANDS } from "../src/commands.ts";
import { createSession, PERMISSION_CYCLE, PERMISSION_LABEL } from "../src/session.ts";
import { createCommandContext, type ReplDeps } from "../src/repl.ts";
import { FileHistoryStoreImpl } from "@standardcode/platform";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

describe("/diff（WP-09 rework：自实现引擎 over file-history）", () => {
  it("有变更→unified 输出含 ±行；无快照→提示（S-10 脱敏保留）", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "sc-diffcmd-"));
    const proj = mkdtempSync(path.join(tmpdir(), "sc-diffproj-"));
    try {
      const f = path.join(proj, "a.txt");
      writeFileSync(f, "v0\n", "utf8");
      const store = await FileHistoryStoreImpl.create(proj, base);
      await store.snapshot("Write", f);
      writeFileSync(f, "my key sk-abc123def456ghij\nv1\n", "utf8");
      const session = createSession({ provider: fakeProvider(), catalog: ["m-a"], model: "m-a", cwd: proj });
      const out: string[] = [];
      const deps: ReplDeps = { session, io: { lines: (async function* () {})(), write: (x) => out.push(x), close: () => {} }, fileHistory: store };
      const ctx = createCommandContext(deps);
      const diffCmd = CLI_COMMANDS.find((c) => c.name === "diff")!;
      await diffCmd.execute("", ctx);
      const joined = out.join("\n");
      expect(joined).toContain("-v0");
      expect(joined).toContain("+v1");
      expect(joined).toContain("[REDACTED]"); // S-10
      expect(joined).not.toContain("sk-abc123def456ghij");
      // 无快照会话
      const store2 = await FileHistoryStoreImpl.create(mkdtempSync(path.join(tmpdir(), "sc-diffcmd2-")), mkdtempSync(path.join(tmpdir(), "sc-diffproj2-")));
      const out2: string[] = [];
      const deps2: ReplDeps = { session, io: { lines: (async function* () {})(), write: (x) => out2.push(x), close: () => {} }, fileHistory: store2 };
      await createCommandContext(deps2).sessionDiff();
      await diffCmd.execute("", createCommandContext(deps2));
      expect(out2.join("\n")).toContain("no file-history snapshots");
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
