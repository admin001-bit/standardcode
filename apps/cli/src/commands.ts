// M1 五命令（v2.8 §8.2 M1 最小集）+ M2 增量（§8.2 M2 分期，B-03 只注册本里程碑命令）：
// WP-09 增 /rewind /diff（EXE-030/040/041）；WP-10/11 增其余。
import { spawnSync } from "node:child_process";
import { PERMISSION_CYCLE, PERMISSION_LABEL, type PermissionMode } from "./session.ts";
import { redactSecrets } from "@standardcode/platform";

export interface CommandContext {
  catalog(): readonly string[];
  /** 会话工作目录（/diff 的 git 执行目录）。 */
  workingDir(): string;
  /** file-history 回滚（/rewind N，EXE-040；store 缺席=报错提示）。 */
  rewind(seq: number): Promise<{ undone: number; files: string[] }>;
  /** 当前快照数（/rewind 空参展示）。 */
  snapshotCount(): number;
  currentModel(): string;
  /** 未知模型抛错（由 repl 统一转 error 行）。 */
  switchModel(name: string): void;
  permissionMode(): PermissionMode;
  /** 按 EXE-001 循环序推进一档并返回新模式。 */
  cyclePermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  clearHistory(): void;
  requestExit(): void;
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
    name: "diff",
    description: "show uncommitted changes (git diff HEAD, ADR-0032; S-10 redaction applied)",
    execute(args, ctx) {
      const argsParts = args.trim();
      const gitArgs = argsParts ? ["diff", ...argsParts.split(/\s+/)] : ["diff", "HEAD"];
      const r = spawnSync("git", gitArgs, { cwd: ctx.workingDir(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (r.error || (r.status !== 0 && r.status !== 1)) {
        const why = (r.stderr ?? "").trim().slice(0, 500) || "not a git repository?";
        ctx.write(`[diff] git unavailable or failed: ${why}\n发生了什么：git diff 执行失败；为什么：/diff 复用系统 git（ADR-0032）；建议动作：确认目录为 git 仓库且 git 在 PATH。`);
        return;
      }
      let out = r.stdout ?? "";
      if (out.trim() === "") {
        ctx.write("[diff] no uncommitted changes");
        return;
      }
      out = redactSecrets(out); // S-10：diff 内容可能含密钥
      if (out.length > 30_000) out = out.slice(0, 30_000) + "\n[output truncated]";
      ctx.write(out.endsWith("\n") ? out : out + "\n");
    },
  },
];
