// M1 五命令（v2.8 §8.2 M1 最小集：/help /clear /exit /model /permission；B-03：五命令之外不注册）。
import { PERMISSION_CYCLE, PERMISSION_LABEL, type PermissionMode } from "./session.ts";

export interface CommandContext {
  catalog(): readonly string[];
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

export const M1_COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    description: "list all available commands",
    execute(_args, ctx) {
      ctx.write("commands:");
      for (const c of M1_COMMANDS) ctx.write(`  /${c.name}${c.usage ? ` ${c.usage}` : ""} — ${c.description}`);
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
];
