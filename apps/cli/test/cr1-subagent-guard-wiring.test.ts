// S3-2 接线回归（全仓审查 2026-10-01 批1）：subtask spawn 面把 guard/fileHistory 传入
// SubagentRunContext——子代理 Write 过 guard-path 硬闸（.git 写入被 stop，文件零落盘）＋写盘前
// 进 file-history 快照。判别性：修复前三个 spawn 面无此两字段 → guard 用例 evil 文件会被真写出、
// snapshot 用例 beforeTool 零调用（两断言均红）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import type { FileHistoryStore, SnapshotRecord } from "@standardcode/platform";
import { createCommandContext } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";

let root: string;
let homeDir: string;
let projDir: string;

// bypassPermissions agent：权限面放行，判别面只剩 guard（否则 default 模式 ask→fail-closed 掩蔽）
const BYPASS_MD = `---
schemaVersion: 1
name: bypassbot
description: writes files
permissionMode: bypassPermissions
---
bypass body
`;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-cr1-"));
  homeDir = path.join(root, "home");
  projDir = path.join(root, "proj");
  mkdirSync(path.join(projDir, ".standardcode", "agents"), { recursive: true });
  writeFileSync(path.join(projDir, ".standardcode", "agents", "bypassbot.md"), BYPASS_MD, "utf8");
  mkdirSync(path.join(projDir, ".git"), { recursive: true }); // guard 元数据判定的祖先段
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 句柄残留忽略 */
  }
});

/** 第 1 页 tool_use Write，第 2 页收尾；捕获每轮请求（断言 tool_result 面）。 */
function writeThenTextProvider(input: Record<string, unknown>, reqs: LLMRequest[]): ProviderAdapter {
  let round = 0;
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      reqs.push({ ...req, messages: structuredClone(req.messages) });
      yield { type: "message_start", id: "m", model: "test" } as LLMEvent;
      if (round++ === 0) {
        yield { type: "tool_start", id: "t1", name: "Write" } as LLMEvent;
        yield { type: "tool_input_delta", id: "t1", jsonPartial: JSON.stringify(input) } as LLMEvent;
        yield { type: "tool_end", id: "t1" } as LLMEvent;
        yield { type: "finish", reason: "tool_calls", raw: "tool_use" } as LLMEvent;
      } else {
        yield { type: "text_delta", text: "sub done" } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
      }
    },
  };
}

function makeSession(provider: ProviderAdapter): Session {
  return createSession({ provider, catalog: ["m"], model: "m", cwd: projDir, projectRoot: projDir, home: homeDir, trusted: true });
}

function fakeFileHistory(rec: { tools: SnapshotRecord["tool"][]; paths: string[] }): FileHistoryStore {
  return {
    dir: path.join(root, "fh"),
    indexFile: path.join(root, "fh", "index.json"),
    maxSeq: () => 0,
    records: async () => [],
    snapshot: async (tool: SnapshotRecord["tool"], filePath: string) => {
      rec.tools.push(tool);
      rec.paths.push(filePath);
      return 1;
    },
    rewindTo: async () => ({ undone: 0, files: [] }),
  };
}

describe("S3-2 接线：subtask spawn 面传 guard/fileHistory", () => {
  it("guard 接线：子代理 Write <proj>/.git/evil.txt 被 guard stop 硬拦——文件零落盘，tool_result 见 guard-path stop", async () => {
    const reqs: LLMRequest[] = [];
    const provider = writeThenTextProvider({ file_path: ".git/evil.txt", content: "pwn" }, reqs);
    const s = makeSession(provider);
    await s.agents.loadProjectAgents({ confirm: async () => true }); // 提权字段保留（bypassPermissions）
    expect(s.agents.names()).toContain("bypassbot");
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] }); // /subtask 守卫
    const ctx = createCommandContext({ session: s, io: { lines: (async function* () {})(), write: () => {}, close: () => {} }, baseDir: path.join(root, "repl-store-guard") });
    const r = await ctx.subtask("bypassbot write it");
    expect(r.text).toContain("completed");
    expect(existsSync(path.join(projDir, ".git", "evil.txt"))).toBe(false); // 修复前：guard 缺位 → 真写盘
    expect(JSON.stringify(reqs[1]!.messages)).toContain("guard-path stop"); // 模型可见的拦截 tool_result
  });

  it("fileHistory 接线：子代理 Write 安全路径先 snapshot 后写盘（beforeTool 带 Write 工具名与绝对路径）", async () => {
    const provider = writeThenTextProvider({ file_path: "ok.txt", content: "x" }, []);
    const s = makeSession(provider);
    await s.agents.loadProjectAgents({ confirm: async () => true });
    s.messages.push({ role: "user", content: [{ type: "text", text: "seed" }] });
    const rec = { tools: [] as SnapshotRecord["tool"][], paths: [] as string[] };
    const fh = fakeFileHistory(rec);
    const ctx = createCommandContext({
      session: s,
      io: { lines: (async function* () {})(), write: () => {}, close: () => {} },
      fileHistory: fh,
      baseDir: path.join(root, "repl-store-fh"),
    });
    const r = await ctx.subtask("bypassbot write it");
    expect(r.text).toContain("completed");
    expect(existsSync(path.join(projDir, "ok.txt"))).toBe(true); // 安全路径真写（权限 bypass 生效）
    expect(rec.tools).toContain("Write"); // 修复前：spawn 面无 fileHistory → 快照零发生
    expect(rec.paths[0]).toBe(path.join(projDir, "ok.txt")); // 绝对路径=s.cwd 拼接（与主循环同源）
  });
});
