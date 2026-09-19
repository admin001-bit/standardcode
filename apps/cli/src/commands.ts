// M1 五命令（v2.8 §8.2 M1 最小集）+ M2 增量（§8.2 M2 分期，B-03 只注册本里程碑命令）：
// WP-09 增 /rewind /diff（EXE-030/040/041）；WP-05 增 /context；WP-07 增 /permission 扩展；WP-10 增 /new /resume /rename；WP-11 增余量七条（恰十八=§8.2 M2 全集）。
// M7-WP-01（§8.2 M7 分期）增 /goal（会话目标：设定/查看/清除/refine 细化——Kimi goal mode 语义束收敛 [自定]，
// 锚=A 级 KimiCode的产品细节.md 行 334-364；[CC] 无 /goal。正式面注册：CLI_COMMANDS 30→31，计数断言同步 +1 口径）。
import { PERMISSION_CYCLE, PERMISSION_LABEL, type PermissionMode } from "./session.ts";
import type { TokenUsage } from "@standardcode/providers";
import { sessionDiff, redactSecrets, t } from "@standardcode/platform";
import { buildContextGrid, renderContextGrid } from "@standardcode/context";

// —— WP-10 /usage 价格表（ENG-046 "内置价格表"；卡边界=按 §10 落固定内置表 [自定] 登记偏差）。
// 数值纪律：结构性占位（系数形状 output=5×/cacheW=1.25×/cacheR=0.1×input 均 [自定]），
// 非官方价目事实断言；标定缺位登记未解决（悬而未决随仪表盘）。覆盖=本仓内置目录两模型；
// env 自定目录模型（STANDARD_CODE_MODELS）无价格行=cost n/a（拒绝静默套价）。 ——
export interface ModelPriceRate {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

const CATALOG_PRICES: Readonly<Record<string, ModelPriceRate>> = {
  // 系数形状 [自定]：output=5×input、cacheWrite=1.25×input、cacheRead=0.1×input——
  // 字面量显式写死（浮点乘除不落 0.30000000000000004 类尾差，展示与合计共用同一权威表）。
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheWriteUsdPerMTok: 3.75, cacheReadUsdPerMTok: 0.3 },
  "claude-opus-5": { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cacheWriteUsdPerMTok: 18.75, cacheReadUsdPerMTok: 1.5 },
};

export function priceTableRow(model: string): ModelPriceRate | null {
  return CATALOG_PRICES[model] ?? null;
}

/** 价格表行合计（DoD③ 断言面）：四列 × 对应单价，USD/百万 token 口径。 */
export function usageCostUsd(totals: TokenUsage, rate: ModelPriceRate): number {
  return (
    ((totals.inputTokens ?? 0) * rate.inputUsdPerMTok +
      (totals.outputTokens ?? 0) * rate.outputUsdPerMTok +
      (totals.cacheCreationTokens ?? 0) * rate.cacheWriteUsdPerMTok +
      (totals.cacheReadTokens ?? 0) * rate.cacheReadUsdPerMTok) /
    1_000_000
  );
}

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
 * WP-05 /tasks 参数解析（ORC-032：active_only 默认 true、limit 1–100 默认 20）：
 * `/tasks` | `/tasks <limit>` | `/tasks all` | `/tasks all <limit>`。limit 越界/非整数抛错（fail-closed）。
 */
export function parseTasksArgs(raw: string): { activeOnly: boolean; limit: number } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let activeOnly = true;
  const nums: string[] = [];
  for (const p of parts) {
    if (p === "all") activeOnly = false;
    else nums.push(p);
  }
  if (nums.length > 1) throw new Error(t("cmd.tasks.err.multiple", { value: nums.join(" ") }));
  let limit = 20;
  if (nums.length === 1) {
    const n = Number(nums[0]);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new Error(t("cmd.tasks.err.limit", { value: nums[0] }));
    }
    limit = n;
  }
  return { activeOnly, limit };
}

/** WP-10（M4）/subtask 类型首词解析 [自定]（DoD②/ADR-0043）：首词命中注册表类型名（大小写不敏感）=类型，
 * 余文=prompt；不命中=整段为 prompt（现状恒 general-purpose 路）。单 token/空输入不拆（防 prompt 置空）。 */
export function splitSubtaskType(input: string, names: readonly string[]): { type?: string; prompt: string } {
  const parts = input.trim().split(/\s+/);
  if (parts.length > 1 && names.length > 0) {
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const hit = byLower.get(parts[0]!.toLowerCase());
    if (hit !== undefined) return { type: hit, prompt: parts.slice(1).join(" ").trim() };
  }
  return { prompt: input.trim() };
}

/** WP-07 /subtask 名派生（CC fork 引擎 Te :347 逐字同构：prompt 前 3 词→小写→清洗→截 24 字符，兜底 "subtask"——CC 兜底字面 "fork" 因本命令语境改名 [自定]）。
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
  /** WP-01：现行注册表（已过实验特性门；/help 与补全/派发同源——门关时实验命令不出现也不可执行）。 */
  commands(): readonly SlashCommand[];
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
  /** WP-05 /tasks：任务清单（ORC-032：active_only 默认 true、limit 1–100 默认 20）。 */
  tasks(args: string): { text: string };
  /** WP-05 /background：挂后台任务清单。 */
  background(): { text: string };
  /** WP-10 /status：会话状态总览（模型/provider/权限模式/上下文水位/任务数——全实时读态）。 */
  status(): { text: string };
  /** WP-10 /usage：四列累计+缓存命中率（会话内实时，cache_read/input=M1 WP-05 口径）+内置价格表估算（[自定] 占位）。 */
  usage(): { text: string };
  /** WP-03 /mcp：server 清单视图（状态/传输/来源/连接态）。 */
  mcpList(): { text: string };
  /** M4-WP-07：i18n 渲染（ADR-0042；lang=会话级快照）。 */
  t(key: string, params?: Record<string, string | number>): string;
  /** WP-03 /mcp：approve|reject|enable|disable（local 层留痕 ADR-0037 形制+按现行门控重装配）。 */
  mcpAction(action: "approve" | "reject" | "enable" | "disable", name: string): Promise<{ text: string }>;
  /** WP-06 /memory：双轨可视化（用户轨来源与顺序 MEM-044+自动轨索引摘要）。 */
  memoryView(): { text: string };
  /** WP-05 /skills：list（name/描述/来源/状态）。 */
  skillsList(): { text: string };
  /** WP-05 /skills run：用户点名豁免（disable-model-invocation 双轨的豁免面，DoD④）。 */
  skillsRun(name: string, args?: string): { text: string };
  /** M4-WP-09 /plugin list：安装记录（含坏件标注）+聚合告警（读盘即时）。 */
  pluginList(): { text: string };
  /** M4-WP-09 /plugin install：S-5 显式确认（组件清单展示）→ 复制+留痕；未确认=零落地。 */
  pluginInstall(target: string): Promise<{ text: string }>;
  /** M4-WP-09 /plugin remove：目录级清理+留痕删。 */
  pluginRemove(name: string): { text: string };
  /** M4-WP-08 /update：查 npm registry 最新版→同版显示当前/新版提示并执行全局安装（DoD①；注入面离线测试）。 */
  updateNow(): Promise<{ text: string }>;
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
  /** M6-WP-10 /fork：fork 型 subagent（后台异步；prompt=父消息历史渲染块＋指令复合形；[CC] _353.js fork 语义束同构）。 */
  fork(args: string): Promise<{ text: string }>;
  /** M6-WP-10 /export：导出当前会话转录为 Markdown（落点 <cwd>/export-<sessionId>.md；已存在=拒绝点名）。 */
  exportSession(args: string): Promise<{ text: string }>;
  /** M7-WP-01 /goal：会话目标（<objective> 设定｜无参或 status 查看｜refine 细化=spawn 改写｜clear 清除；-- 转义；
   *  设定/清除/refine 均以 user turn 注入会话=下一轮 prompt 模型可见；目标仅会话内存态不落盘 [自定]）。 */
  goal(args: string): Promise<{ text: string }>;
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
    get description() {
      return t("cmd.help.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.t("repl.help.header"));
      for (const c of ctx.commands()) ctx.write(`  /${c.name}${c.usage ? ` ${c.usage}` : ""} — ${c.description}`);
    },
  },
  {
    name: "clear",
    get description() {
      return t("cmd.clear.desc");
    },
    execute(_args, ctx) {
      ctx.clearHistory();
      ctx.write(ctx.t("repl.done.cleared"));
    },
  },
  {
    name: "exit",
    get description() {
      return t("cmd.exit.desc");
    },
    execute(_args, ctx) {
      ctx.requestExit();
    },
  },
  {
    name: "model",
    get usage() {
      return t("cmd.model.usage");
    },
    get description() {
      return t("cmd.model.desc");
    },
    execute(args, ctx) {
      const target = args.trim();
      if (target === "") {
        ctx.write(ctx.t("repl.model.header", { value: ctx.currentModel() }));
        for (const m of ctx.catalog()) ctx.write(`  ${m === ctx.currentModel() ? "*" : " "} ${m}`);
        return;
      }
      ctx.switchModel(target);
      ctx.write(ctx.t("repl.model.switched", { value: ctx.currentModel() }));
    },
  },
  {
    name: "permission",
    get usage() {
      return t("cmd.permission.usage");
    },
    get description() {
      return t("cmd.permission.desc");
    },
    execute(args, ctx) {
      const target = args.trim();
      if (target === "") {
        const next = ctx.cyclePermissionMode();
        ctx.write(ctx.t("repl.permission.mode", { label: PERMISSION_LABEL[next], value: next }));
        return;
      }
      const mode = target as PermissionMode;
      if (!PERMISSION_CYCLE.includes(mode)) {
        throw new Error(ctx.t("cmd.permission.err.unknown", { value: target, choices: PERMISSION_CYCLE.join("|") }));
      }
      ctx.setPermissionMode(mode);
      ctx.write(ctx.t("repl.permission.mode", { label: PERMISSION_LABEL[mode], value: mode }));
    },
  },
  {
    name: "rewind",
    get usage() {
      return t("cmd.rewind.usage");
    },
    get description() {
      return t("cmd.rewind.desc");
    },
    async execute(args, ctx) {
      const raw = args.trim();
      if (raw === "") {
        ctx.write(`[rewind] ${ctx.snapshotCount()} snapshot(s); usage: /rewind <N> (1..${ctx.snapshotCount()})`);
        return;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(ctx.t("cmd.rewind.err.notInteger", { value: raw }));
      if (n > ctx.snapshotCount()) throw new Error(ctx.t("cmd.rewind.err.exceeds", { value: n, latest: ctx.snapshotCount() }));
      const r = await ctx.rewind(n);
      const files = r.undone > 0 ? "\n  " + r.files.join("\n  ") : "";
      ctx.write(`[rewind] restored to before snapshot ${n}: ${r.undone} file(s) reverted${files}`);
    },
  },
  {
    name: "context",
    get description() {
      return t("cmd.context.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.contextGrid().text);
    },
  },
  {
    name: "diff",
    get description() {
      return t("cmd.diff.desc");
    },
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
    get description() {
      return t("cmd.new.desc");
    },
    async execute(_args, ctx) {
      await ctx.newSession();
    },
  },
  {
    name: "resume",
    get usage() {
      return t("cmd.resume.usage");
    },
    get description() {
      return t("cmd.resume.desc");
    },
    async execute(_args, ctx) {
      await ctx.resumeSession();
    },
  },
  {
    name: "rename",
    get usage() {
      return t("cmd.rename.usage");
    },
    get description() {
      return t("cmd.rename.desc");
    },
    async execute(args, ctx) {
      await ctx.renameSession(args);
      ctx.write(ctx.t("repl.rename.done"));
    },
  },
  // —— WP-11：M2 分期余量（§8.2；/context 已于 WP-05 注册）——
  {
    name: "compact",
    get usage() {
      return t("cmd.compact.usage");
    },
    get description() {
      return t("cmd.compact.desc");
    },
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
            throw new Error(ctx.t("cmd.compact.err.window"));
          }
          window = w;
        }
      }
      const r = await ctx.compact(window, partialIdx);
      ctx.write(ctx.t("repl.compact.done", { pre: r.preTokens, post: r.postTokens, chars: r.summary.length }));
    },
  },
  {
    name: "config",
    get usage() {
      return t("cmd.config.usage");
    },
    get description() {
      return t("cmd.config.desc");
    },
    async execute(args, ctx) {
      const r = await ctx.config(args);
      ctx.write(r.text);
    },
  },
  {
    name: "provider",
    get usage() {
      return t("cmd.provider.usage");
    },
    get description() {
      return t("cmd.provider.desc");
    },
    execute(args, ctx) {
      ctx.write(ctx.switchProvider(args.trim() || undefined).text);
    },
  },
  {
    name: "doctor",
    get description() {
      return t("cmd.doctor.desc");
    },
    async execute(_args, ctx) {
      const r = await ctx.doctor();
      ctx.write(r.text);
    },
  },
  {
    name: "cd",
    get usage() {
      return t("cmd.cd.usage");
    },
    get description() {
      return t("cmd.cd.desc");
    },
    async execute(args, ctx) {
      if (args.trim() === "") throw new Error(ctx.t("cmd.cd.err.required"));
      ctx.write(ctx.changeDir(args.trim()).text);
    },
  },
  {
    name: "add-dir",
    get usage() {
      return t("cmd.add-dir.usage");
    },
    get description() {
      return t("cmd.add-dir.desc");
    },
    async execute(args, ctx) {
      if (args.trim() === "") throw new Error(ctx.t("cmd.add-dir.err.required"));
      const r = await ctx.addDir(args.trim());
      ctx.write(r.text);
    },
  },
  {
    name: "reload",
    get description() {
      return t("cmd.reload.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.reload().text);
    },
  },
  // —— WP-05：M3 任务面板（§8.2 M3 增 /tasks /background；ORC-032 Kimi 语义逐键）——
  {
    name: "tasks",
    get usage() {
      return t("cmd.tasks.usage");
    },
    get description() {
      return t("cmd.tasks.desc");
    },
    execute(args, ctx) {
      ctx.write(ctx.tasks(args).text);
    },
  },
  {
    name: "background",
    get description() {
      return t("cmd.background.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.background().text);
    },
  },
  // —— WP-07：M3 分期余量三件（§8.2 M3 增 /subtask /effort /init）——
  {
    name: "subtask",
    get usage() {
      return t("cmd.subtask.usage");
    },
    get description() {
      return t("cmd.subtask.desc");
    },
    async execute(args, ctx) {
      const prompt = args.trim();
      if (prompt === "") throw new Error(ctx.t("cmd.subtask.err.required"));
      const r = await ctx.subtask(prompt);
      ctx.write(r.text);
    },
  },
  {
    name: "effort",
    get usage() {
      return t("cmd.effort.usage");
    },
    get description() {
      return t("cmd.effort.desc");
    },
    async execute(args, ctx) {
      const r = await ctx.effort(args.trim());
      ctx.write(r.text);
    },
  },
  {
    name: "init",
    get description() {
      return t("cmd.init.desc");
    },
    async execute(_args, ctx) {
      const r = await ctx.init();
      ctx.write(r.text);
    },
  },
  // —— WP-10：M3 分期余量两件（§8.2；CTX-102/ENG-046/ADR-0027 权威口径）——
  {
    name: "status",
    get description() {
      return t("cmd.status.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.status().text);
    },
  },
  {
    name: "usage",
    get description() {
      return t("cmd.usage.desc");
    },
    execute(_args, ctx) {
      ctx.write(ctx.usage().text);
    },
  },
  // —— WP-03：M4 分期首件（§8.2 M4 增 /mcp；S-3 安装即确认+/mcp 可视化管控）——
  {
    name: "mcp",
    get usage() {
      return t("cmd.mcp.usage");
    },
    get description() {
      return t("cmd.mcp.desc");
    },
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      if (sub === "list") {
        if (parts.length > 1) throw new Error(ctx.t("cmd.mcp.err.listExtra", { value: parts.slice(1).join(" ") }));
        ctx.write(ctx.mcpList().text);
        return;
      }
      if (sub === "approve" || sub === "reject" || sub === "enable" || sub === "disable") {
        const name = parts[1];
        if (!name) throw new Error(ctx.t("cmd.mcp.err.nameRequired", { sub }));
        if (parts.length > 2) throw new Error(ctx.t("cmd.mcp.err.oneName", { sub, value: parts.slice(1).join(" ") }));
        const r = await ctx.mcpAction(sub, name);
        ctx.write(r.text);
        return;
      }
      throw new Error(ctx.t("cmd.mcp.err.unknownSub", { value: sub }));
    },
  },
  // —— WP-05：M4 分期（§8.2 M4 增 /skills；S-5 allowed-tools 白名单+SEC-070 信任门）——
  {
    name: "skills",
    get usage() {
      return t("cmd.skills.usage");
    },
    get description() {
      return t("cmd.skills.desc");
    },
    execute(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      if (sub === "list") {
        if (parts.length > 1) throw new Error(ctx.t("cmd.skills.err.listExtra", { value: parts.slice(1).join(" ") }));
        ctx.write(ctx.skillsList().text);
        return;
      }
      if (sub === "run") {
        const name = parts[1];
        if (!name) throw new Error(ctx.t("cmd.skills.err.nameRequired"));
        const r = ctx.skillsRun(name, parts.length > 2 ? parts.slice(2).join(" ") : undefined);
        ctx.write(r.text);
        return;
      }
      throw new Error(ctx.t("cmd.skills.err.unknownSub", { value: sub }));
    },
  },
  // —— WP-06：M4 分期（§8.2 M4 增 /memory；MEM-044 可视化+§9.1 ② 自动轨）——
  {
    name: "memory",
    get description() {
      return t("cmd.memory.desc");
    },
    execute(_args, ctx) {
      if (_args.trim() !== "") throw new Error(ctx.t("cmd.memory.err.args"));
      ctx.write(ctx.memoryView().text);
    },
  },
  // —— WP-09：M4 分期末件（§8.2 M4 增 /plugin；ECO-032 install|list|remove；S-5 安装确认=组件清单展示）——
  {
    name: "plugin",
    get usage() {
      return t("cmd.plugin.usage");
    },
    get description() {
      return t("cmd.plugin.desc");
    },
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      if (sub === "list") {
        if (parts.length > 1) throw new Error(ctx.t("cmd.plugin.err.listExtra", { value: parts.slice(1).join(" ") }));
        ctx.write(ctx.pluginList().text);
        return;
      }
      if (sub === "install") {
        const target = parts[1];
        if (!target) throw new Error(ctx.t("cmd.plugin.err.targetRequired"));
        if (parts.length > 2) throw new Error(ctx.t("cmd.plugin.err.oneTarget", { value: parts.slice(1).join(" ") }));
        const r = await ctx.pluginInstall(target);
        ctx.write(r.text);
        return;
      }
      if (sub === "remove") {
        const name = parts[1];
        if (!name) throw new Error(ctx.t("cmd.plugin.err.nameRequired"));
        if (parts.length > 2) throw new Error(ctx.t("cmd.plugin.err.oneTarget", { value: parts.slice(1).join(" ") }));
        ctx.write(ctx.pluginRemove(name).text);
        return;
      }
      throw new Error(ctx.t("cmd.plugin.err.unknownSub", { value: sub }));
    },
  },
  // —— WP-08：M4 分期收口件（§8.2 M4 增 /update；ENG-041+附录 E npm registry 通道；命令清单第 30 件）——
  {
    name: "update",
    get description() {
      return t("cmd.update.desc");
    },
    async execute(args, ctx) {
      // 无子命令无参数（DoD① 形状 [自定]：检查/提示形状无一手锚，卡参考资料栏预登记）。
      if (args.trim() !== "") throw new Error(ctx.t("cmd.update.err.args"));
      const r = await ctx.updateNow();
      ctx.write(r.text);
    },
  },
  // —— M7-WP-01：M7 分期首件（§8.2 M7 增 /goal；Kimi goal mode 语义束收敛 [自定]——
  // 不做自动续跑/pause/resume/replace/next/TUI 管理面（卡边界"不做目标自动追踪"）；
  // 子命令集收敛为 status（查看）/refine（细化=spawn 改写）/clear（清除；Kimi 用 cancel，取 clear 与 /plan clear 同形 [自定]））——
  {
    name: "goal",
    get usage() {
      return t("cmd.goal.usage");
    },
    get description() {
      return t("cmd.goal.desc");
    },
    async execute(args, ctx) {
      const r = await ctx.goal(args);
      ctx.write(r.text);
    },
  },
];
