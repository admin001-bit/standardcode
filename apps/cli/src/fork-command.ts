// M6-WP-10：/fork 命令实现（fork 型 subagent，DoD①③；flag 门=fork，见 experimental-gate.ts）。
// [CC] _353.js fork 语义束（亲核切片）：forkContextMessages:e.messages（@3344，fork 携带父会话消息）、
//   override.agentId=S(f.agentId)+useExactTools:!0+isAsync:!0（fork=异步/同工具面/同 agentId 血统）、
//   拒绝态遥测 subagent_fork_prompt_missing（@1659，空上下文点名）、description slug Te（@4155）。
// 与 [CC] 机制形制差（如实登记，供 V）：本仓 harness 无 override.systemPrompt/replHydration 机制（且边界
//   禁改 harness 校验序列）——fork prompt=「父消息历史渲染块＋fork 任务指令」复合形 [自定]；fork=后台异步
//   （runInBackground:true → async_launched），完成通知经既有任务事件面（/tasks /background 消费），不做结果注入。
// 门内实验命令：plain 英文 description 标 experimental（workflows-command.ts 先例，不进 i18n 双包）。
import type { LLMMessage } from "@standardcode/providers";
import type { SlashCommand } from "./commands.ts";

/** fork prompt 携带的父消息历史上限 [自定]（[CC] forkContextMessages 全量携带；本仓取尾部 N 条防 context 失控）。 */
export const FORK_HISTORY_MAX_MESSAGES = 200;

/** fork 任务指令缺省形（args 无指令时）[自定]。 */
export const DEFAULT_FORK_INSTRUCTION =
  "Continue from the forked context above. Summarize the current state of the parent session and await further instructions.";

/**
 * fork description slug（[CC] _353.js Te @4155 逐字同构：前 3 词→join("-")→小写→清洗→去首尾折叠→截 24；
 * 空回落 "fork"——/fork 语境与 [CC] 兜底字面一致，无 M4 deriveSubtaskName 的改名理由）。
 */
export function deriveForkDescription(prompt: string): string {
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
      .slice(0, 24) || "fork"
  );
}

function messageText(m: LLMMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("");
}

/**
 * fork prompt 复合形 [自定]：父消息历史渲染块（尾部 FORK_HISTORY_MAX_MESSAGES 条，逐条 role:text 压平，
 * 非文本块以 [type] 占位）＋fork 任务指令——DoD①「fork 携带父转录=是」的落地形。
 */
export function renderForkContextPrompt(messages: readonly LLMMessage[], instruction: string): string {
  const tail = messages.slice(-FORK_HISTORY_MAX_MESSAGES);
  const lines: string[] = [];
  for (const m of tail) lines.push(`[${m.role}] ${messageText(m)}`);
  return [
    "<fork-context>",
    `Below is the message history of the parent session this agent was forked from (${tail.length} message(s), most recent last).`,
    "",
    lines.join("\n"),
    "</fork-context>",
    "",
    "<fork-task>",
    instruction,
    "</fork-task>",
  ].join("\n");
}

export const forkCommand: SlashCommand = {
  name: "fork",
  description:
    "Spawn a fork subagent that inherits the current session context and runs in the background (experimental: enable the `fork` flag).",
  usage: "[agentType] <instruction>",
  async execute(args, ctx) {
    const r = await ctx.fork(args);
    ctx.write(r.text);
  },
};
