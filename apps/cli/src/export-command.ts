// M6-WP-10：/export 命令实现（导出当前会话转录为 Markdown，DoD③；flag 门=fork，见 experimental-gate.ts）。
// 格式/落点 [自定]：默认 Markdown 可读形（元数据头 sessionId/导出时间/条数＋逐条 role+text）；
// 落点 <cwd>/export-<sessionId>.md；目标已存在=拒绝并点名（不静默覆盖，B-12 fail-closed；--force 不做）。
// 门内实验命令：plain 英文 description 标 experimental（workflows-command.ts 先例，不进 i18n 双包）。
import { join } from "node:path";
import type { LLMMessage } from "@standardcode/providers";
import type { SlashCommand } from "./commands.ts";

/** /export 落点 [自定]：<cwd>/export-<sessionId>.md。 */
export function exportTargetPath(cwd: string, sessionId: string): string {
  return join(cwd, `export-${sessionId}.md`);
}

function messageText(m: LLMMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("");
}

/** /export 渲染 [自定]：Markdown 可读形（元数据头含 sessionId/导出时间/条数；逐条 role+text）。 */
export function renderSessionMarkdown(input: { sessionId: string; exportedAt: string; messages: readonly LLMMessage[] }): string {
  const lines: string[] = [
    "# Session export",
    "",
    `- sessionId: ${input.sessionId}`,
    `- exportedAt: ${input.exportedAt}`,
    `- messages: ${input.messages.length}`,
    "",
  ];
  for (const m of input.messages) {
    lines.push(`## ${m.role}`, "", messageText(m), "");
  }
  return lines.join("\n");
}

export const exportCommand: SlashCommand = {
  name: "export",
  description:
    "Export the current session transcript to a Markdown file in the working directory (experimental: enable the `fork` flag).",
  async execute(args, ctx) {
    const r = await ctx.exportSession(args);
    ctx.write(r.text);
  },
};
