// M1 五命令（v2.8 §8.2 M1 最小集）+ M2 增量（§8.2 M2 分期，B-03 只注册本里程碑命令）：
// WP-09 增 /rewind /diff（EXE-030/040/041）；WP-05 增 /context；WP-07 增 /permission 扩展；WP-10 增 /new /resume /rename；WP-11 增余量七条（恰十八=§8.2 M2 全集）。
import { PERMISSION_CYCLE, PERMISSION_LABEL, type PermissionMode } from "./session.ts";
import { sessionDiff, redactSecrets } from "@standardcode/platform";
import { buildContextGrid, renderContextGrid } from "@standardcode/context";

// —— WP-07 /effort：推理力度档位 → model.thinking 值映射 [自定]（ADR-0030 值形；medium=resolveThinking 缺省 8000 对齐，
// low=其半，high=adaptive；OpenCode reasoning_effort 档位语义同构，调研报告 §B2）——
export const EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const EFFORT_TO_THINKING: Readonly<Record<EffortLevel, string>> = {
  off: "off",
  low: "budget:4000",
  medium: "budget:8000",
  high: "adaptive",
};

/** 档位显示（ThinkingSetting → 档位名；非标准 budget 值显示原样）。 */
export function effortLabel(thinking: { type: "adaptive" } | { type: "budget"; budgetTokens: number } | undefined): string {
  if (!thinking) return "off";
  if (thinking.type === "adaptive") return "high";
  if (thinking.budgetTokens === 8000) return "medium";
  if (thinking.budgetTokens === 4000) return "low";
  return `custom(budget:${thinking.budgetTokens})`;
}

/**
 * WP-07 /subtask 名派生（CC fork 引擎 Te :347 逐字同构：prompt 前 3 词→小写→清洗→截 24 字符，兜底 "fork"）。
 */
export function deriveSubtaskName(prompt: string): string {
  return (
    prompt
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "subtask"
  );
}

/** WP-07 /init 骨架（前缀头约定=CC agent-prompt-claude-md-creation.md 同构；内容占位=静态骨架面，分析式生成非本卡）。 */
export const AGENTS_SKELETON = `# AGENTS.md

This file provides guidance to StandardCode (standardcode CLI) when working with code in this repository.

## Commands

<!-- Common build/lint/test commands, including how to run a single test. -->

## Architecture

<!-- High-level architecture notes that require reading multiple files to understand. -->
`;

export interface CommandContext {
  catalog(): readonly string[];
  /** 会话工作目录（/diff 的 git 执行目录）。 */
  workingDir(): string;
  /** file-history 回滚（/rewind N，EXE-040；store 缺席=报错提示）。 */
  rewind(seq: number): Promise<{ undone: number; files: string[] }>;
  /** 当前快照数（/rewind 空参展示）。 */
  snapshotCount(): number;
  /** 会话文件变更面 diff（WP-09 rework：自实现引擎 over file-history；store 缺席=空结果）。 */
  sessionDiff(): Promise<{ output: string; changed: number; scanned: number; skipped: string[] }>;
  /** /context 网格数据（WP-05 CTX-038：分类占用+33k buffer+usage 四列对账）。 */
  contextGrid(): { text: string };
  /** WP-11 /compact：手动压缩（窗口=CTX-036 手动窗 100k–1M 或模型窗；空参=模型窗）。 */
  compact(window?: number, partialIdx?: number): Promise<{ summary: string; preTokens: number; postTokens: number }>;
  /** WP-11 /config：无参=五来源合并展示（ADR-0030 键位）；有参=写 local 层并回显。 */
  config(args: string): Promise<{ text: string }>;
  /** WP-11 /provider：无参列目录；有参切换（MDL-010~013：下一 turn 生效）。 */
  switchProvider(name?: string): { text: string };
  /** WP-11 /doctor：环境健康检查与自修复最小集（ENG-043+S-10 提示+ENG-080 迁移提示）。 */
  doctor(): Promise<{ text: string; fixed: string[] }>;
  /** WP-11 /cd：切换工作目录（transcript 项目归属随 cwd）。 */
  changeDir(path: string): { text: string };
  /** WP-11 /add-dir：追加授权目录（§8.3 additionalDirectories——WP-07 信任门控联动）。 */
  addDir(path: string): Promise<{ text: string }>;
  /** WP-11 /reload：重载记忆（WP-02）与设置（WP-01）。 */
  reload(): { text: string };
  /** WP-07 /subtask：同步子任务（走 spawn，M6 前仅同步语义；结果注入会话——CC :328 首轮前拒绝）。 */
  subtask(prompt: string): Promise<{ text: string }>;
  /** WP-07 /effort：推理力度档位（查看/设置；写 model.thinking local 层+下一 turn 生效——MDL-010~013 同构）。 */
  effort(args: string): Promise<{ text: string }>;
  /** WP-07 /init：生成 AGENTS.md 骨架（已存在不覆盖——卡 DoD③）。 */
  init(): Promise<{ text: string }>;
  currentModel(): string;
  /** 未知模型抛错（由 repl 统一转 error 行）。 */
  switchModel(name: string): void;
  permissionMode(): PermissionMode;
  /** 按 EXE-001 循环序推进一档并返回新模式。 */
  cyclePermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  clearHistory(): void;
  requestExit(): void;
  /** WP-10（CTX-101 交接终点）：开新会话，旧 transcript 完好可 /resume。 */
  newSession(): Promise<void>;
  /** WP-10（UI-030）：会话选择器（搜索+预览+重命名），恢复选中的会话；返回是否恢复。 */
  resumeSession(): Promise<boolean>;
  /** WP-10：当前会话重命名（sidecar 标题；/resume 列表即时反映）。 */
  renameSession(title: string): Promise<void>;
  write(line: string): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  execute(args: string, ctx: CommandContext): void | Promise<void>;
}

export const CLI_COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    description: "list all available commands",
    execute(_args, ctx) {
      ctx.write("commands:");
      for (const c of CLI_COMMANDS) ctx.write(`  /${c.name}${c.usage ? ` ${c.usage}` : ""} — ${c.description}`);
    },
  },
  {
    name: "clear",
    description: "clear conversation history (keeps this session)",
    execute(_args, ctx) {
      ctx.clearHistory();
      ctx.write("[clear] conversation history cleared");
    },
  },
  {
    name: "exit",
    description: "exit standardcode",
    execute(_args, ctx) {
      ctx.requestExit();
    },
  },
  {
    name: "model",
    usage: "[name]",
    description: "show or switch the model (WP-01 provider catalog)",
    execute(args, ctx) {
      const target = args.trim();
      if (target === "") {
        ctx.write(`models (current: ${ctx.currentModel()}):`);
        for (const m of ctx.catalog()) ctx.write(`  ${m === ctx.currentModel() ? "*" : " "} ${m}`);
        return;
      }
      ctx.switchModel(target);
      ctx.write(`[model] switched to ${ctx.currentModel()}`);
    },
  },
  {
    name: "permission",
    usage: "[default|acceptEdits|plan|bypassPermissions]",
    description: "cycle (no args, EXE-001 order) or set the permission mode",
    execute(args, ctx) {
      const target = args.trim();
      if (target === "") {
        const next = ctx.cyclePermissionMode();
        ctx.write(`[permission] mode: ${PERMISSION_LABEL[next]} (${next})`);
        return;
      }
      const mode = target as PermissionMode;
      if (!PERMISSION_CYCLE.includes(mode)) {
        throw new Error(`unknown mode: ${target}（可选 ${PERMISSION_CYCLE.join("|")}）`);
      }
      ctx.setPermissionMode(mode);
      ctx.write(`[permission] mode: ${PERMISSION_LABEL[mode]} (${mode})`);
    },
  },
  {
    name: "rewind",
    usage: "<N>",
    description: "restore files to the state before snapshot N (file-history, EXE-040)",
    async execute(args, ctx) {
      const raw = args.trim();
      if (raw === "") {
        ctx.write(`[rewind] ${ctx.snapshotCount()} snapshot(s); usage: /rewind <N> (1..${ctx.snapshotCount()})`);
        return;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`/rewind N: N must be a positive integer (got ${raw})`);
      if (n > ctx.snapshotCount()) throw new Error(`/rewind N: N (${n}) exceeds latest snapshot (${ctx.snapshotCount()})`);
      const r = await ctx.rewind(n);
      const files = r.undone > 0 ? "\n  " + r.files.join("\n  ") : "";
      ctx.write(`[rewind] restored to before snapshot ${n}: ${r.undone} file(s) reverted${files}`);
    },
  },
  {
    name: "context",
    description: "show context window breakdown with real usage reconciliation (CTX-038; ADR-0027)",
    execute(_args, ctx) {
      ctx.write(ctx.contextGrid().text);
    },
  },
  {
    name: "diff",
    description: "show session file changes vs pre-write snapshots (self-implemented unified diff, ADR-0032 rework; S-10 redaction)",
    async execute(args, ctx) {
      // ADR-0032 决策 1【勘误 2026-09-08】：用户裁决改自实现——/diff 语义=会话文件变更面（file-history 快照基线 vs 当前）
      const r = await ctx.sessionDiff();
      if (r.changed === 0) {
        ctx.write(r.scanned === 0 ? "[diff] no file-history snapshots in this session" : "[diff] no changes vs session start");
        return;
      }
      let out = redactSecrets(r.output); // S-10：diff 内容可能含密钥
      if (out.length > 30_000) out = out.slice(0, 30_000) + "\n[output truncated]";
      const tail = out.endsWith("\n") ? out : out + "\n";
      ctx.write(`[diff] ${r.changed} file(s) changed (${r.scanned} scanned${r.skipped.length > 0 ? `, ${r.skipped.length} skipped: ${r.skipped.join(", ")}` : ""})\n${tail}`);
    },
  },
  {
    name: "new",
    description: "start a new session (previous transcript stays intact and resumable, CTX-101)",
    async execute(_args, ctx) {
      await ctx.newSession();
    },
  },
  {
    name: "resume",
    usage: "[query]",
    description: "pick a past session (search + preview) and restore it (UI-030)",
    async execute(_args, ctx) {
      await ctx.resumeSession();
    },
  },
  {
    name: "rename",
    usage: "<title>",
    description: "rename the current session (shows in /resume list)",
    async execute(args, ctx) {
      await ctx.renameSession(args);
      ctx.write(`[rename] session renamed`);
    },
  },
  // —— WP-11：M2 分期余量（§8.2；/context 已于 WP-05 注册）——
  {
    name: "compact",
    usage: "[window | partial <msgIndex>]",
    description: "manually compact the conversation (9-section summary, CTX-036; window 100k-1M)",
    async execute(args, ctx) {
      const a = args.trim();
      let window: number | undefined;
      let partialIdx: number | undefined;
      if (a !== "") {
        const pm = /^partial\s+(\d+)$/.exec(a);
        if (pm) {
          partialIdx = Number(pm[1]);
        } else {
          const w = Number(a);
          if (!Number.isInteger(w) || w < 100_000 || w > 1_000_000) {
            throw new Error("/compact window: must be integer in [100000, 1000000] (CTX-036 manual window)");
          }
          window = w;
        }
      }
      const r = await ctx.compact(window, partialIdx);
      ctx.write(`[compact] ${r.preTokens} -> ${r.postTokens} tokens（摘要 ${r.summary.length} chars，已替换历史）`);
    },
  },
  {
    name: "config",
    usage: "[key [value]]",
    description: "show merged settings (5-source order, WP-01) or set key into local layer",
    async execute(args, ctx) {
      const r = await ctx.config(args);
      ctx.write(r.text);
    },
  },
  {
    name: "provider",
    usage: "[anthropic|openai]",
    description: "show or switch provider (takes effect next turn, MDL-010~013)",
    execute(args, ctx) {
      ctx.write(ctx.switchProvider(args.trim() || undefined).text);
    },
  },
  {
    name: "doctor",
    description: "environment health check with minimal self-repair (ENG-043, S-10 hints, ENG-080 migration)",
    async execute(_args, ctx) {
      const r = await ctx.doctor();
      ctx.write(r.text);
    },
  },
  {
    name: "cd",
    usage: "<dir>",
    description: "change the working directory (tools re-created; transcript project follows cwd)",
    async execute(args, ctx) {
      if (args.trim() === "") throw new Error("/cd <dir>: directory required");
      ctx.write(ctx.changeDir(args.trim()).text);
    },
  },
  {
    name: "add-dir",
    usage: "<dir>",
    description: "allow an additional working directory (gated by workspace trust, §8.3)",
    async execute(args, ctx) {
      if (args.trim() === "") throw new Error("/add-dir <dir>: directory required");
      const r = await ctx.addDir(args.trim());
      ctx.write(r.text);
    },
  },
  {
    name: "reload",
    description: "reload memory (WP-02) and settings (WP-01) from disk",
    execute(_args, ctx) {
      ctx.write(ctx.reload().text);
    },
  },
  // —— WP-07：M3 分期余量三件（§8.2 M3 增 /subtask /effort /init）——
  {
    name: "subtask",
    usage: "<prompt>",
    description: "run a synchronous subtask via subagent spawn and inject the result (M6 前仅同步语义)",
    async execute(args, ctx) {
      const prompt = args.trim();
      if (prompt === "") throw new Error("/subtask <prompt>: prompt required");
      const r = await ctx.subtask(prompt);
      ctx.write(r.text);
    },
  },
  {
    name: "effort",
    usage: "[off|low|medium|high]",
    description: "show or set the reasoning effort level (writes model.thinking, takes effect next turn — MDL-010~013)",
    async execute(args, ctx) {
      const r = await ctx.effort(args.trim());
      ctx.write(r.text);
    },
  },
  {
    name: "init",
    description: "generate an AGENTS.md skeleton in the project root (never overwrites an existing file)",
    async execute(_args, ctx) {
      const r = await ctx.init();
      ctx.write(r.text);
    },
  },
];
