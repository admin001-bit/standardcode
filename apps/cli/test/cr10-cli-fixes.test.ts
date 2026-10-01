// 批 10 CLI 组回归（全仓审查 2026-10-01）：R1-5 /theme LIST 大小写、S5-8 Stop 续轮×auto-compact
// 转录补写基准、S5-10 shell spawn 层错误可见、S6-4 readline completer 唯一命中/hint 接线。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { completerFor, createCommandContext, runRepl, type ReplDeps } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";
import { CLI_COMMANDS } from "../src/commands.ts";
import { THEMES } from "../src/theme.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-cr10-cli-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function baseSession(proj: string, extra: Partial<Parameters<typeof createSession>[0]> = {}): Session {
  mkdirSync(proj, { recursive: true });
  return createSession({
    provider: stubProvider(),
    catalog: ["m"],
    model: "m",
    cwd: proj,
    projectRoot: proj,
    home: path.join(root, "home"),
    trusted: true,
    env: { ...process.env, STANDARD_CODE_LANG: "en" },
    ...extra,
  });
}

function stubProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(): AsyncIterable<LLMEvent> {
      throw new Error("provider must not be called");
    },
  };
}

function ctxOf(s: Session, out: string[] = [], extra: Partial<ReplDeps> = {}) {
  return createCommandContext({ session: s, io: { lines: (async function* () {})(), write: (x) => out.push(x), close: () => {} }, baseDir: path.join(root, "base"), ...extra });
}

describe("R1-5 /theme list 大小写口径（原精确小写 vs /goal toLowerCase 分叉）", () => {
  it("/theme LIST 与 /theme List 同列清单（原落 resolveTheme fail-closed 报 invalid theme）", async () => {
    const s = baseSession(path.join(root, "theme"));
    const ctx = ctxOf(s);
    for (const arg of ["LIST", "List", "list"]) {
      const r = await ctx.theme(arg);
      expect(r.text).toContain("plain");
      for (const t of THEMES) expect(r.text).toContain(t);
    }
    // 真主题值仍 fail-closed（既有语义不动）
    await expect(ctx.theme("blue")).rejects.toThrow(/invalid theme/);
  });
});

describe("S6-4 readline completer 接线（唯一命中与 hint 原被丢弃＝生产终端零生效）", () => {
  it("唯一命中透传 insert（readline 单候选自动补全）；多义透传候选", () => {
    const fn = completerFor(CLI_COMMANDS, () => {});
    expect(fn("/hel")).toEqual([["/help "], "/hel"]); // 修复前：candidates:[] → 判无匹配
    const multi = fn("/e");
    expect((multi[0] as string[]).length).toBeGreaterThan(1); // exit/effort...
    expect(fn("plain text")).toEqual([[], "plain text"]); // 非斜杠首无补全
  });
  it("参数位 hint 经 write 打出（修复前 hint 丢弃）", () => {
    const writes: string[] = [];
    const fn = completerFor(CLI_COMMANDS, (x) => writes.push(x));
    const model = CLI_COMMANDS.find((c) => c.name === "model")!;
    expect(fn("/model ")).toEqual([[], "/model "]);
    expect(writes.join("")).toContain(model.usage); // hint=usage — description 形
  });
});

describe("S5-10 shell spawn 层错误可见（原只打空输出＋exit unknown）", () => {
  it("! 行 spawn 失败 → 输出 spawn failed（真实错误零解释→显式呈现）", async () => {
    if (process.platform !== "win32") return; // shell:true 错误注入依赖 ComSpec（POSIX 恒 /bin/sh 存在）
    const proj = path.join(root, "shell-err");
    const s = baseSession(proj);
    const prev = process.env.ComSpec;
    process.env.ComSpec = path.join(root, "no-such-shell.exe"); // spawn 层 ENOENT
    const out: string[] = [];
    try {
      const io: ReplDeps["io"] = { lines: (async function* () { yield "!echo hi"; yield "/exit"; })(), write: (x) => out.push(x), close: () => {} };
      await runRepl({ session: s, io, baseDir: path.join(root, "shell-base") });
    } finally {
      if (prev === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prev;
    }
    const text = out.join("\n");
    expect(text).toMatch(/spawn failed|启动失败/); // 修复前：空输出 + exit code unknown
    expect(text).not.toContain("hi");
  }, 20_000);
});

describe("S5-8 Stop 钉 blocking 续轮 × auto-compact 转录补写基准", () => {
  it("第 1 轮已落盘消息不被第 2 轮 perform 二次补写（原基准=preTurnLength ⇒ JSONL 重复）", async () => {
    const proj = path.join(root, "s58");
    mkdirSync(path.join(proj, ".standardcode"), { recursive: true });
    // Stop hook：仅首次阻断（exit2+stderr 反馈），其后放行（防 8 连阻断兜底路径干扰）
    const hookMark = path.join(root, "s58-stop.mark");
    const hookScript = path.join(root, "s58-stop.mjs");
    writeFileSync(
      hookScript,
      `import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(hookMark)})) { writeFileSync(${JSON.stringify(hookMark)}, "1"); process.stderr.write("blocking-round-one"); process.exit(2); }
process.exit(0);
`,
      "utf8",
    );
    const s58Reqs: LLMRequest[] = [];
    const s = createSession({
      provider: s58Provider(s58Reqs),
      catalog: ["m"],
      model: "m",
      cwd: proj,
      projectRoot: proj,
      home: path.join(root, "home"),
      trusted: true,
      env: { STANDARD_CODE_LANG: "en" }, // 会话 env 隔离：掐断 ambient AUTO_COMPACT_DISABLE 等
      flagOverrides: { hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${hookScript}"` }] }] } } as Record<string, unknown>,
    });
    const baseDir = path.join(root, "s58-base");
    const out: string[] = [];
    await runRepl({
      session: s,
      io: { lines: (async function* () { yield "hello world"; yield "/exit"; })(), write: (x) => out.push(x), close: () => {} },
      baseDir,
    });
    // 转录文件：prompt/user 记录与 round1 assistant 各只应出现一次（缺陷形=双份）
    const encDir = path.join(baseDir, "projects");
    const projDirs = readdirSync(encDir);
    expect(projDirs.length).toBe(1);
    const tdir = path.join(encDir, projDirs[0]!, "transcripts");
    const files = readdirSync(tdir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    const jsonl = readFileSync(path.join(tdir, files[0]!), "utf8");
    const count = (needle: string): number => jsonl.split(needle).length - 1;
    const kinds = jsonl
      .trim()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { kind: string; reason?: string }).kind);
    // 落盘诊断（失败时供排查；不影响断言）
    writeFileSync(
      path.join(root, "s58-diag.txt"),
      JSON.stringify({ kinds, out: out.join("|"), reqs: s58Reqs.map((r) => ({ compact: r.tools === undefined, n: r.messages.length })) }, null, 1),
    );
    expect(count('"hello world"')).toBe(1); // 修复前：第 2 轮 perform 按 preTurnLength 重放 → 2
    expect(count('"reply-one"')).toBe(1); // round1 assistant 同理
    // Stop blocking 轮真发生（hook 落 mark=首次 exit2 已执行；反馈消息在后续请求历史里）
    expect(existsSync(hookMark)).toBe(true);
    expect(s58Reqs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(s58Reqs[1]!.messages)).toContain("blocking-round-one");
    // 压缩真发生（compact 记录在位、摘要入记录）
    expect(kinds).toContain("compact");
    expect(jsonl).toContain("SUMMARY-OF-CONVERSATION");
  }, 30_000);
});

/** S5-8 夹具：call1 成功+巨额 usage → call2 先发巨额 usage 再抛 context_length（round2 独立 state，
 *  usage 须在本轮落账 evaluate 才见巨额）→ compact 请求（无 tools）供摘要 → 收尾成功。 */
function s58Provider(reqs: LLMRequest[]): ProviderAdapter {
  let phase: "first" | "throwing" | "compacted" = "first";
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 10,
    async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
      reqs.push(req);
      if (req.tools === undefined && phase !== "first") {
        // 压缩请求（无 tools）→ 供摘要并翻相位
        phase = "compacted";
        yield { type: "message_start", id: "mc", model: "m" } as LLMEvent;
        yield { type: "text_delta", text: "SUMMARY-OF-CONVERSATION" } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
        return;
      }
      if (phase === "first") {
        phase = "throwing";
        yield { type: "message_start", id: "m1", model: "m" } as LLMEvent;
        yield { type: "text_delta", text: "reply-one" } as LLMEvent;
        yield { type: "usage", usage: { inputTokens: 9_999_999, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
        yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
        return;
      }
      if (phase === "throwing") {
        // 先落本轮巨额 usage 再抛（round2 状态独立；evaluate 读的是本轮 state.usage——F11 语义）
        yield { type: "message_start", id: "m2", model: "m" } as LLMEvent;
        yield { type: "usage", usage: { inputTokens: 9_999_999, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
        throw Object.assign(new Error("prompt is too long"), { kind: "context_length", status: 400 });
      }
      yield { type: "message_start", id: "m3", model: "m" } as LLMEvent;
      yield { type: "text_delta", text: "reply-final" } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}
