// M6-WP-04：workflow journal 续跑与运行目录测试（v2.8 ORC-023/024 行 295「journal 续跑」+ 接缝⑰；
// A 级 claude-code-workflow.md §7.1-§7.4）。逐条覆盖卡 DoD①-⑥ 与边界。
// 形态：包装 WorkflowHooks（不改 kernel.ts）——命中回放/未命中/中断恢复三态 + 端到端（vm 脚本→沙箱→内核→journal）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import type { Tool } from "@standardcode/harness";
import {
  WORKFLOW_CLEANUP_TOLERATED_CODES,
  WORKFLOW_JOURNAL_FILENAME,
  WORKFLOW_JOURNAL_HIT_EVENT,
  cleanupWorkflowRun,
  createWorkflowJournalSession,
  createWorkflowJournalWriter,
  createWorkflowOrchestrator,
  defaultWorkflowAgentKey,
  escapeWorkflowResumeArg,
  isReplayableWorkflowKey,
  parseWorkflowJournal,
  previewWorkflowResult,
  readWorkflowJournal,
  runWorkflowScript,
  workflowJournalAgentId,
  workflowJournalPath,
  workflowResumeRecipe,
  workflowRunDir,
  workflowScriptPath,
  withWorkflowJournal,
  type WorkflowHooks,
  type WorkflowJournalFs,
} from "../src/index.ts";

const created: string[] = [];

async function tmpRunsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stdc-wf-journal-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const USAGE = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 };
const TOOLS: Tool[] = [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "ok" }];

/** 最轻量 fake provider：单轮文本完成；onStart 用于证「确实派生过」。 */
function makeFakeProvider(text: string, hooks?: { onStart?: () => void }): ProviderAdapter {
  return {
    capabilities: () => {
      throw new Error("unused");
    },
    countTokens: async () => 0,
    async *stream(): AsyncGenerator<LLMEvent> {
      hooks?.onStart?.();
      yield { type: "text_delta", text } as LLMEvent;
      yield { type: "usage", usage: USAGE } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

function makeOrchestrator(provider: ProviderAdapter): WorkflowHooks {
  return createWorkflowOrchestrator({ provider, model: "m", tools: TOOLS, availableTypes: ["general-purpose"] });
}

/** 最轻量 stub 编排（回放判定不依赖真派生时用它，避免子代理开销）。 */
function stubHooks(agentImpl: (prompt: string, opts?: unknown) => Promise<unknown>): WorkflowHooks {
  return {
    agent: agentImpl as WorkflowHooks["agent"],
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items) => [...items],
  };
}

/** 从 jsonl 文本逐行 parse 成对象（断言记录字段用）。 */
function journalLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("DoD① 三型记录字段同构 {type, key, agentId, ...result}", () => {
  it("started/failed/result 三型落 jsonl，字段骨架一致（result 型多带 result）", async () => {
    const runsDir = await tmpRunsDir();
    const filePath = workflowJournalPath(runsDir, "run-1");
    const writer = createWorkflowJournalWriter({ filePath });

    await writer.append({ type: "started", key: "k1", agentId: "wfagent-a" });
    await writer.append({ type: "failed", key: "k1", agentId: "wfagent-a" });
    await writer.append({ type: "result", key: "k1", agentId: "wfagent-a", result: { ok: 1 } });
    await writer.flush();

    const lines = journalLines(await readFile(filePath, "utf8"));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.type)).toEqual(["started", "failed", "result"]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toContain("agentId");
      expect(Object.keys(line).sort()).toContain("key");
      expect(Object.keys(line).sort()).toContain("type");
      expect(typeof line.key).toBe("string");
      expect(typeof line.agentId).toBe("string");
    }
    expect(lines[0]).toEqual({ type: "started", key: "k1", agentId: "wfagent-a" });
    expect(lines[1]).toEqual({ type: "failed", key: "k1", agentId: "wfagent-a" });
    expect(lines[2].result).toEqual({ ok: 1 });
  });

  it("并发 append 串行化：N 条全落盘、行不交错、每行可解析", async () => {
    const runsDir = await tmpRunsDir();
    const filePath = workflowJournalPath(runsDir, "run-conc");
    const writer = createWorkflowJournalWriter({ filePath });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writer.append({ type: "result", key: `k${i}`, agentId: `wfagent-${i}`, result: i }),
      ),
    );
    await writer.flush();
    const lines = journalLines(await readFile(filePath, "utf8"));
    expect(lines).toHaveLength(12);
    expect(new Set(lines.map((l) => l.key)).size).toBe(12);
  });

  it("agent 结果为 null → 写 failed（不写 result；DoD①）", async () => {
    const runsDir = await tmpRunsDir();
    const writer = createWorkflowJournalWriter({ filePath: workflowJournalPath(runsDir, "run-null") });
    const journaled = withWorkflowJournal(stubHooks(async () => null), { journal: writer, runId: "run-null" });

    await expect(journaled.hooks.agent("p")).resolves.toBeNull();
    await journaled.flush();

    const lines = journalLines(await readFile(writer.filePath, "utf8"));
    expect(lines.map((l) => l.type)).toEqual(["started", "failed"]);
  });

  it("解析层：坏行/空行/未知 type 跳过（不抛），合法行照常归并", () => {
    const state = parseWorkflowJournal(
      [
        "",
        "not json",
        JSON.stringify({ type: "unknown", key: "k", agentId: "a" }),
        JSON.stringify({ type: "started", key: "k", agentId: "a" }),
        JSON.stringify({ type: "started", key: "k", agentId: "a2" }),
        JSON.stringify({ type: "result", key: "k", agentId: "a2", result: 7 }),
        "  ",
      ].join("\n"),
    );
    expect(state.started.get("k")).toEqual({ agentId: "a2", attempts: 2 });
    expect(state.results.get("k")).toBe(7);
    expect(state.failed.size).toBe(0);
  });
});

describe("DoD② resume：已 started 且无 failed 的 key 回放缓存结果并标 cached:true（不再派生 agent）", () => {
  it("命中回放：第二次运行零派生、结果=缓存值、replays[].cached===true、遥测 attempts", async () => {
    const runsDir = await tmpRunsDir();
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    // run-1：真派生并落 result
    const inner1 = vi.fn(async (prompt: string) => `r:${prompt}`);
    const s1 = await createWorkflowJournalSession({ orchestration: stubHooks(inner1), runsDir, runId: "run-1" });
    await expect(s1.hooks.agent("hello")).resolves.toBe("r:hello");
    await s1.finish();
    expect(inner1).toHaveBeenCalledTimes(1);

    // run-2：resume from run-1
    const inner2 = vi.fn(async (prompt: string) => `r:${prompt}`);
    const s2 = await createWorkflowJournalSession({
      orchestration: stubHooks(inner2),
      runsDir,
      runId: "run-2",
      resumeFromRunId: "run-1",
      onTelemetry: (event, payload) => events.push({ event, payload }),
    });
    await expect(s2.hooks.agent("hello")).resolves.toBe("r:hello");
    await s2.finish();

    expect(inner2).not.toHaveBeenCalled(); // 不再派生 agent
    expect(s2.replays).toHaveLength(1);
    expect(s2.replays[0].cached).toBe(true);
    expect(s2.replays[0].result).toBe("r:hello");
    expect(s2.replays[0].attempts).toBe(1);
    expect(events.map((e) => e.event)).toContain(WORKFLOW_JOURNAL_HIT_EVENT);
    expect(events.find((e) => e.event === WORKFLOW_JOURNAL_HIT_EVENT)?.payload.attempts).toBe(1);
  });

  it("未命中：无 journal 文件 → 全量派生（isReplayable 恒 false）", async () => {
    const runsDir = await tmpRunsDir();
    const inner = vi.fn(async (prompt: string) => `r:${prompt}`);
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "run-fresh",
      resumeFromRunId: "run-missing",
    });
    expect(session.resumeState).toBeNull();
    await expect(session.hooks.agent("p")).resolves.toBe("r:p");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(session.replays).toHaveLength(0);
    expect(isReplayableWorkflowKey(null, "any")).toBe(false);
  });

  it("未命中：key 不同（prompt/opts 变化）→ 各自派生并各自落 result", async () => {
    const runsDir = await tmpRunsDir();
    const inner1 = vi.fn(async (prompt: string) => `r:${prompt}`);
    const s1 = await createWorkflowJournalSession({ orchestration: stubHooks(inner1), runsDir, runId: "run-k1" });
    await s1.hooks.agent("alpha");
    await s1.finish();

    const inner2 = vi.fn(async (prompt: string) => `r:${prompt}`);
    const s2 = await createWorkflowJournalSession({
      orchestration: stubHooks(inner2),
      runsDir,
      runId: "run-k2",
      resumeFromRunId: "run-k1",
    });
    await s2.hooks.agent("beta");
    await s2.finish();

    expect(inner2).toHaveBeenCalledTimes(1);
    expect(s2.replays).toHaveLength(0);
  });

  it("中断后恢复（started 无 result 无 failed）→ 重新派生，不误判为命中", async () => {
    const runsDir = await tmpRunsDir();
    const key = defaultWorkflowAgentKey("half-done");
    const writer = createWorkflowJournalWriter({ filePath: workflowJournalPath(runsDir, "run-cut") });
    await writer.append({ type: "started", key, agentId: "wfagent-cut-1" });
    await writer.flush();

    const inner = vi.fn(async (prompt: string) => `r:${prompt}`);
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "run-resume",
      resumeFromRunId: "run-cut",
    });
    expect(session.resumeState?.started.has(key)).toBe(true);
    expect(session.resumeState?.results.size).toBe(0);
    await expect(session.hooks.agent("half-done")).resolves.toBe("r:half-done");
    expect(inner).toHaveBeenCalledTimes(1); // 未回放 → 真重跑
    expect(session.replays).toHaveLength(0);
    await session.finish();

    // 重跑后 journal 增补 result 记录（下次可命中）
    const state = await readWorkflowJournal(workflowJournalPath(runsDir, "run-resume"));
    expect(isReplayableWorkflowKey(state, defaultWorkflowAgentKey("half-done"))).toBe(true);
    expect(state?.started.get(defaultWorkflowAgentKey("half-done"))?.attempts).toBe(1);
  });

  it("有 failed 记录的 key 不回放（结果为 null 的尝试必须重跑）", async () => {
    const runsDir = await tmpRunsDir();
    const key = defaultWorkflowAgentKey("flaky");
    const writer = createWorkflowJournalWriter({ filePath: workflowJournalPath(runsDir, "run-failed") });
    await writer.append({ type: "started", key, agentId: "a1" });
    await writer.append({ type: "failed", key, agentId: "a1" });
    await writer.append({ type: "result", key, agentId: "a1", result: "stale" });
    await writer.flush();

    const inner = vi.fn(async () => "fresh");
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "run-retry",
      resumeFromRunId: "run-failed",
    });
    await expect(session.hooks.agent("flaky")).resolves.toBe("fresh");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(session.replays).toHaveLength(0);
  });
});

describe("DoD③ 恢复配方：scriptPath + resumeFromRunId 逐字形", () => {
  it("配方文本逐字同 A 级 §7.3 形状", () => {
    const recipe = workflowResumeRecipe({ scriptPath: "/tmp/workflows/run-1/audit.js", runId: "run-1" });
    expect(recipe).toBe(
      "To resume manually: Workflow({scriptPath: '/tmp/workflows/run-1/audit.js', resumeFromRunId: 'run-1'}).",
    );
  });

  it("单引号/反斜杠转义（Windows 路径不破字面量）", () => {
    expect(escapeWorkflowResumeArg("C:\\a\\b'c")).toBe("C:\\\\a\\\\b\\'c");
    expect(workflowResumeRecipe({ scriptPath: "C:\\r\\s.js", runId: "r'1" })).toContain(
      "scriptPath: 'C:\\\\r\\\\s.js', resumeFromRunId: 'r\\'1'",
    );
  });

  it("会话带上 scriptPath → resumeRecipe()/interruptedNotice() 直接可回填工具结果", async () => {
    const runsDir = await tmpRunsDir();
    const scriptPath = workflowScriptPath(runsDir, "run-x", "audit");
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(async () => 1),
      runsDir,
      runId: "run-x",
      scriptPath,
    });
    expect(session.resumeRecipe()).toContain(`scriptPath: '${scriptPath.replace(/\\/g, "\\\\")}'`);
    expect(session.resumeRecipe()).toContain("resumeFromRunId: 'run-x'");
    expect(session.interruptedNotice()).toContain(session.resumeRecipe());
  });
});

describe("DoD④ 运行目录 workflows/<runId>/（复用 script-store 单源）+ 结束清理容错", () => {
  it("journal 路径 = <runsDir>/<runId>/journal.jsonl，与脚本落盘同目录（单源，无第二套编码）", () => {
    const runsDir = path.join(path.sep, "runs");
    expect(workflowJournalPath(runsDir, "r1")).toBe(path.join(runsDir, "r1", WORKFLOW_JOURNAL_FILENAME));
    expect(path.dirname(workflowJournalPath(runsDir, "r1"))).toBe(path.dirname(workflowScriptPath(runsDir, "r1", "audit")));
    expect(path.dirname(workflowJournalPath(runsDir, "r1"))).toBe(workflowRunDir(runsDir, "r1"));
    // 恶意 runId 不越出 runsDir（复用 sanitizeWorkflowRunId）
    expect(path.resolve(workflowJournalPath(runsDir, "../../evil")).startsWith(path.resolve(runsDir) + path.sep)).toBe(true);
  });

  it("会话按需建 run 目录并落 journal；finish({cleanup:true}) 后目录被清理", async () => {
    const runsDir = await tmpRunsDir();
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(async (p) => `r:${p}`),
      runsDir,
      runId: "run-clean",
    });
    await session.hooks.agent("p");
    const result = await session.finish({ cleanup: true });

    expect(result?.journalRemoved).toBe(true);
    expect(result?.dirRemoved).toBe(true);
    expect(result?.tolerated).toEqual([]);
    await expect(readFile(session.journalPath, "utf8")).rejects.toThrow();
  });

  it("清理容错 ENOENT：目录本就不存在 → 不抛，容错码可观察", async () => {
    const runsDir = await tmpRunsDir();
    const result = await cleanupWorkflowRun(runsDir, "never-created");
    expect(result.journalRemoved).toBe(false);
    expect(result.dirRemoved).toBe(false);
    expect(result.tolerated).toEqual(["journal:ENOENT", "dir:ENOENT"]);
    expect(WORKFLOW_CLEANUP_TOLERATED_CODES).toContain("ENOENT");
    expect(WORKFLOW_CLEANUP_TOLERATED_CODES).toContain("ENOTEMPTY");
  });

  it("清理容错 ENOTEMPTY：递归删目录报 ENOTEMPTY → 吞掉不抛；非容错码（EPERM）原样抛", async () => {
    const runsDir = await tmpRunsDir();
    const failWith = (code: string): WorkflowJournalFs => ({
      appendFile: async () => undefined,
      readFile: async () => "",
      mkdir: async () => undefined,
      rm: async (target, options) => {
        if (!options.recursive) return; // 删 journal 文件成功
        throw Object.assign(new Error(`simulated ${code}`), { code });
      },
    });

    const tolerated = await cleanupWorkflowRun(runsDir, "run-notempty", failWith("ENOTEMPTY"));
    expect(tolerated.journalRemoved).toBe(true);
    expect(tolerated.dirRemoved).toBe(false);
    expect(tolerated.tolerated).toEqual(["dir:ENOTEMPTY"]);

    await expect(cleanupWorkflowRun(runsDir, "run-perm", failWith("EPERM"))).rejects.toThrow(/simulated EPERM/);
  });
});

describe("DoD⑤ 接缝⑰：注入时间/随机源 → resume 缓存必不命中（禁项是命中前提）", () => {
  it("对照组：确定性 key → 同一调用跨 run 命中回放", async () => {
    const runsDir = await tmpRunsDir();
    const s1 = await createWorkflowJournalSession({
      orchestration: stubHooks(async (p) => `r:${p}`),
      runsDir,
      runId: "ctl-1",
    });
    await s1.hooks.agent("stable");
    await s1.finish();

    const inner = vi.fn(async (p: string) => `r:${p}`);
    const s2 = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "ctl-2",
      resumeFromRunId: "ctl-1",
    });
    await expect(s2.hooks.agent("stable")).resolves.toBe("r:stable");
    expect(inner).not.toHaveBeenCalled();
    expect(s2.replays).toHaveLength(1);
  });

  it("注入日期源（key 含 Date.now()）→ 必不命中：原 journal 有 result 也照常重跑", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const runsDir = await tmpRunsDir();
    const withTimeKey = (prompt: string, opts?: Parameters<typeof defaultWorkflowAgentKey>[1]) =>
      `${defaultWorkflowAgentKey(prompt, opts)}:t${Date.now()}`;

    const s1 = await createWorkflowJournalSession({
      orchestration: stubHooks(async (p) => `r:${p}`),
      runsDir,
      runId: "t-1",
      keyDerivation: withTimeKey,
    });
    await s1.hooks.agent("clocked");
    await s1.finish();

    vi.spyOn(Date, "now").mockReturnValue(2_000); // 「下一次运行」时间不同
    const inner = vi.fn(async (p: string) => `r:${p}`);
    const s2 = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "t-2",
      resumeFromRunId: "t-1",
      keyDerivation: withTimeKey,
    });
    await expect(s2.hooks.agent("clocked")).resolves.toBe("r:clocked");
    expect(inner).toHaveBeenCalledTimes(1); // 未被回放
    expect(s2.replays).toHaveLength(0);

    // 反向确证：同一个时间源取值下（同 key）才命中——命中与否完全由 key 稳定性决定
    const innerSame = vi.fn(async (p: string) => `r:${p}`);
    const s3 = await createWorkflowJournalSession({
      orchestration: stubHooks(innerSame),
      runsDir,
      runId: "t-3",
      resumeFromRunId: "t-2",
      keyDerivation: withTimeKey,
    });
    await expect(s3.hooks.agent("clocked")).resolves.toBe("r:clocked");
    expect(innerSame).not.toHaveBeenCalled();
    expect(s3.replays[0].cached).toBe(true);
  });

  it("注入随机源（key 含 Math.random()）→ 必不命中；沙箱禁 Math.random 是命中前提（DoD⑤）", async () => {
    const runsDir = await tmpRunsDir();
    const withRandomKey = (prompt: string, opts?: Parameters<typeof defaultWorkflowAgentKey>[1]) =>
      `${defaultWorkflowAgentKey(prompt, opts)}:r${Math.random()}`;

    vi.spyOn(Math, "random").mockReturnValue(0.111);
    const s1 = await createWorkflowJournalSession({
      orchestration: stubHooks(async (p) => `r:${p}`),
      runsDir,
      runId: "rnd-1",
      keyDerivation: withRandomKey,
    });
    await s1.hooks.agent("dicey");
    await s1.finish();

    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const inner = vi.fn(async (p: string) => `r:${p}`);
    const s2 = await createWorkflowJournalSession({
      orchestration: stubHooks(inner),
      runsDir,
      runId: "rnd-2",
      resumeFromRunId: "rnd-1",
      keyDerivation: withRandomKey,
    });
    await expect(s2.hooks.agent("dicey")).resolves.toBe("r:dicey");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(s2.replays).toHaveLength(0);
  });

  it("vm 沙箱同语料反证：脚本内 Date.now/Math.random 被沙箱拦下（无时间/随机源可入 key）", async () => {
    const script = `export const meta = { name: "clock", description: "d" };\nconst t = Date.now();\nreturn t;`;
    const hooks = stubHooks(async () => 1);
    await expect(runWorkflowScript({ script, hooks })).rejects.toThrow(/Date\.now/);
    await expect(
      runWorkflowScript({ script: `export const meta = { name: "rnd", description: "d" };\nreturn Math.random();`, hooks }),
    ).rejects.toThrow(/Math\.random/);
  });
});

describe("DoD⑥ resume 失败 / 缺 journal = 正常重跑，不崩溃", () => {
  it("缺 journal 文件 → readWorkflowJournal 返回 null", async () => {
    const runsDir = await tmpRunsDir();
    await expect(readWorkflowJournal(workflowJournalPath(runsDir, "nope"))).resolves.toBeNull();
  });

  it("journal 内容是非法文本 → 解析为空状态（非 null 亦非崩溃）", async () => {
    const runsDir = await tmpRunsDir();
    const filePath = workflowJournalPath(runsDir, "corrupt");
    const writer = createWorkflowJournalWriter({ filePath });
    await writer.append({ type: "started", key: "k", agentId: "a" });
    await writer.flush();
    await (await import("node:fs/promises")).appendFile(filePath, "\u0000{corrupted\n", "utf8");

    const state = await readWorkflowJournal(filePath);
    expect(state).not.toBeNull();
    expect(state?.started.has("k")).toBe(true);
  });

  it("journal 路径不可读（是目录 / EISDIR）→ null，不抛", async () => {
    const runsDir = await tmpRunsDir();
    const dirPath = workflowJournalPath(runsDir, "as-dir");
    await (await import("node:fs/promises")).mkdir(dirPath, { recursive: true });
    await expect(readWorkflowJournal(dirPath)).resolves.toBeNull();
  });

  it("resume 指向不存在的 run → 会话正常，agent 照常派生", async () => {
    const runsDir = await tmpRunsDir();
    const session = await createWorkflowJournalSession({
      orchestration: stubHooks(async (p) => `r:${p}`),
      runsDir,
      runId: "run-orphan",
      resumeFromRunId: "ghost-run",
    });
    await expect(session.hooks.agent("p")).resolves.toBe("r:p");
    expect(session.resumeState).toBeNull();
  });

  it("journal 写失败（fs 报错）不阻断 workflow；派发抛错时写 failed 后原样上抛", async () => {
    const runsDir = await tmpRunsDir();
    const brokenFs: WorkflowJournalFs = {
      appendFile: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      readFile: async () => "",
      mkdir: async () => undefined,
      rm: async () => undefined,
    };
    const writer = createWorkflowJournalWriter({ filePath: workflowJournalPath(runsDir, "broken"), fs: brokenFs });
    const errors: Array<{ code: unknown; type: unknown }> = [];
    const journaled = withWorkflowJournal(stubHooks(async (p) => `r:${p}`), {
      journal: writer,
      onJournalError: (error, record) =>
        errors.push({ code: (error as { code?: unknown }).code, type: record.type }),
    });
    await expect(journaled.hooks.agent("p")).resolves.toBe("r:p");
    // started + result 两次 append 各报一次；workflow 结果不受影响
    expect(errors.map((e) => e.type)).toEqual(["started", "result"]);
    expect(errors.every((e) => e.code === "ENOSPC")).toBe(true);

    const failing = withWorkflowJournal(
      stubHooks(async () => {
        throw new Error("dispatch boom");
      }),
      { journal: createWorkflowJournalWriter({ filePath: workflowJournalPath(runsDir, "boom") }) },
    );
    await expect(failing.hooks.agent("p")).rejects.toThrow("dispatch boom");
    const lines = journalLines(await readFile(workflowJournalPath(runsDir, "boom"), "utf8"));
    expect(lines.map((l) => l.type)).toEqual(["started", "failed"]);
  });
});

describe("端到端：vm 脚本 → 沙箱 → WP-03 内核 → journal（命中跨 run 回放）", () => {
  it("同一脚本第二次运行（resumeFromRunId）零 provider 调用、返回值等于缓存结果", async () => {
    const runsDir = await tmpRunsDir();
    let providerStarts = 0;
    const provider = makeFakeProvider("pong", { onStart: () => providerStarts++ });
    const script = `export const meta = { name: "e2e", description: "d" };\nconst a = await agent("ping", { label: "l" });\nreturn "got:" + a;`;
    const scriptPath = workflowScriptPath(runsDir, "e2e-1", "e2e");

    const s1 = await createWorkflowJournalSession({ orchestration: makeOrchestrator(provider), runsDir, runId: "e2e-1", scriptPath });
    await expect(runWorkflowScript({ script, hooks: s1.hooks, filename: scriptPath })).resolves.toBe("got:pong");
    await s1.finish();
    expect(providerStarts).toBe(1);
    expect(s1.replays).toHaveLength(0);

    // 第二次：同脚本 + resumeFromRunId → 命中回放（provider 不再被调用）
    const s2 = await createWorkflowJournalSession({
      orchestration: makeOrchestrator(provider),
      runsDir,
      runId: "e2e-2",
      resumeFromRunId: "e2e-1",
      scriptPath,
    });
    await expect(runWorkflowScript({ script, hooks: s2.hooks, filename: scriptPath })).resolves.toBe("got:pong");
    await s2.finish();
    expect(providerStarts).toBe(1); // 未新增派生
    expect(s2.replays).toHaveLength(1);
    expect(s2.replays[0].cached).toBe(true);
    expect(s2.replays[0].result).toBe("pong");
    expect(s2.replays[0].resultPreview).toBe("pong");
    // 运行目录：脚本与 journal 同 run 目录
    expect(s2.journalPath).toBe(workflowJournalPath(runsDir, "e2e-2"));
  });

  it("opts 含 schema（vm realm 对象）时 key 仍稳定：opts 参与 key 且跨 realm 规范一致", async () => {
    const runsDir = await tmpRunsDir();
    const provider = makeFakeProvider('{"ok":true}');
    const script = `export const meta = { name: "schema", description: "d" };\nreturn await agent("q", { schema: { type: "object" } });`;
    const s1 = await createWorkflowJournalSession({ orchestration: makeOrchestrator(provider), runsDir, runId: "sc-1" });
    await runWorkflowScript({ script, hooks: s1.hooks });
    await s1.finish();

    let starts = 0;
    const s2 = await createWorkflowJournalSession({
      orchestration: makeOrchestrator(makeFakeProvider('{"ok":true}', { onStart: () => starts++ })),
      runsDir,
      runId: "sc-2",
      resumeFromRunId: "sc-1",
    });
    await expect(runWorkflowScript({ script, hooks: s2.hooks })).resolves.toEqual({ ok: true });
    expect(starts).toBe(0);
    expect(s2.replays).toHaveLength(1);
  });
});

describe("辅助面：key 派生与 id 稳定性", () => {
  it("同 (prompt, opts) 必同 key；键序/undefined 无关；prompt 或 opts 变化即变", () => {
    const base = defaultWorkflowAgentKey("p", { label: "l", model: "m" });
    expect(defaultWorkflowAgentKey("p", { model: "m", label: "l" })).toBe(base);
    expect(defaultWorkflowAgentKey("p", { label: "l", model: "m", effort: undefined })).toBe(base);
    expect(defaultWorkflowAgentKey("p2", { label: "l", model: "m" })).not.toBe(base);
    expect(defaultWorkflowAgentKey("p", { label: "l" })).not.toBe(base);
    expect(base.startsWith("wfkey-")).toBe(true);
  });

  it("环状 opts 不抛：回落进程内唯一 key（永不命中，也不崩溃）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const a = defaultWorkflowAgentKey("p", cyclic as never);
    const b = defaultWorkflowAgentKey("p", cyclic as never);
    expect(a.startsWith("wfkey-unstable-")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("agentId 由 key+attempt 确定性派生（幂等），runId 参与前缀", () => {
    const key = defaultWorkflowAgentKey("p");
    expect(workflowJournalAgentId(key, 1, "run-1")).toBe(workflowJournalAgentId(key, 1, "run-1"));
    expect(workflowJournalAgentId(key, 1, "run-1")).not.toBe(workflowJournalAgentId(key, 2, "run-1"));
    expect(workflowJournalAgentId(key, 1, "run-1")).toContain("wfagent-run-1-");
  });

  it("resultPreview 截断到上限（A 级 §7.2 resultPreview 同构）", () => {
    expect(previewWorkflowResult("abc")).toBe("abc");
    expect(previewWorkflowResult({ a: 1 })).toBe('{"a":1}');
    expect(previewWorkflowResult("x".repeat(300))).toHaveLength(201); // 200 + …
  });
});
