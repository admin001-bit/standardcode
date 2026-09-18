// M6-WP-05：/workflows 命令实现（DoD④：flag 门内注册，见 experimental-gate.ts）。
//
// 行为（A 级 §8）：watch live progress tree——读取 workflowBoard 上的活动 workflow 进度 tracker，渲染最小纯文本进度树。
// 无活动 workflow 时给出明确提示（不抛错、不进入 TUI/ANSI 绘制，符合「minimal observability only」边界）。
import type { SlashCommand } from "./commands.ts";
import { renderWorkflowProgressTree } from "@standardcode/capabilities";
import { workflowBoard } from "./workflow-board.ts";

export const workflowsCommand: SlashCommand = {
  name: "workflows",
  description: "Watch the live progress tree of the running workflow (experimental: enable the `workflow` flag).",
  execute(_args, ctx) {
    const trackers = workflowBoard.list();
    if (trackers.length === 0) {
      ctx.write("[workflows] no active workflow");
      return;
    }
    for (const tracker of trackers) {
      ctx.write(renderWorkflowProgressTree(tracker));
    }
  },
};
