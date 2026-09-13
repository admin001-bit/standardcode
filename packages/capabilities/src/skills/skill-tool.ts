// WP-05：Skill 工具（第二级展开，DoD④⑤⑥；dig-06 §4.3/§4.4）。
// tool_result 首行="Launching skill: <name>"（:164607）；展开正文随 tool_result 附带（[CC]=contextLayers
// 逐请求层，本卡承载面=tool_result [自定]——模型当轮即见，语义等价）。同内容重复调用省略（Jes :164124
// "already loaded above; instructions unchanged"）。disable-model-invocation=模型调用拒（Urr :163590 形状；
// 用户点名豁免面=/skills run，经 runByName 不经本工具）。shell 预执行缺省关闭→ubo 逐字替换（:46933）。
import type { StandardTool } from "../contract.ts";

export const SKILL_SHELL_PREEXEC_DISABLED = "[shell command execution disabled by policy]"; // ubo :46933 逐字
export const SKILL_ALREADY_LOADED_NOTE = "[skill content already loaded above; instructions unchanged]"; // Jes :164124 形状

export interface SkillToolDeps {
  findSkill(name: string): { name: string; description: string; allowedTools?: string[]; disableModelInvocation: boolean; contentHash: string; body: string; dir: string } | undefined;
  /** 变量替换基底。 */
  projectDir: string;
  sessionId: string;
  /** 记账（usage 半衰期分+同内容省略+激活面）。 */
  bumpUsage(name: string): void;
  wasSent(contentHash: string): boolean;
  markSent(contentHash: string): void;
  activate(active: { name: string; allowedTools?: string[] } | null): void;
}

/** 展开正文：${STANDARD_CODE_SKILL_DIR/PROJECT_DIR/SESSION_ID} 替换（[CC] CLAUDE_* 前缀的仓内前缀形 [自定]）+shell 预执行剥离（DoD⑥）。 */
export function expandSkillBody(body: string, vars: { skillDir: string; projectDir: string; sessionId: string; args?: string }): string {
  const replaced = body
    .split("${STANDARD_CODE_SKILL_DIR}").join(vars.skillDir)
    .split("${STANDARD_CODE_PROJECT_DIR}").join(vars.projectDir)
    .split("${STANDARD_CODE_SESSION_ID}").join(vars.sessionId);
  // shell 预执行 !`cmd`：M4 缺省关闭→ubo 逐字替换（:46933；开启面不做=偏差登记）
  return replaced.replace(/!`[^`]*`/g, SKILL_SHELL_PREEXEC_DISABLED);
}

export function createSkillTool(deps: SkillToolDeps): StandardTool {
  return {
    name: "Skill",
    description: "A skill is a packaged set of instructions. Invoke a skill by name to load its instructions and follow them.",
    inputSchema: { type: "object", required: ["skill"], properties: { skill: { type: "string" }, args: { type: "string" } } },
    searchHint: "invoke a named skill",
    isConcurrencySafe: false,
    deferred: false,
    async execute(input) {
      const skillName = typeof (input as { skill?: unknown })?.skill === "string" ? (input as { skill: string }).skill : "";
      if (skillName === "") return "error: missing required parameter 'skill'";
      const s = deps.findSkill(skillName);
      if (!s) return `error: unknown skill: ${skillName}`;
      if (s.disableModelInvocation) {
        return `error: skill "${skillName}" is user-invocable only (disable-model-invocation); ask the user to invoke it`;
      }
      deps.bumpUsage(s.name);
      deps.activate({ name: s.name, ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}) });
      const args = typeof (input as { args?: unknown })?.args === "string" ? (input as { args: string }).args : undefined;
      const expanded = expandSkillBody(s.body, { skillDir: s.dir, projectDir: deps.projectDir, sessionId: deps.sessionId, args });
      if (deps.wasSent(s.contentHash)) {
        return `Launching skill: ${s.name}\n${SKILL_ALREADY_LOADED_NOTE}`; // Jes :164124 同内容省略
      }
      deps.markSent(s.contentHash);
      return `Launching skill: ${s.name}\n\n${expanded}`; // :164607 首行+展开承载 [自定]
    },
  };
}
