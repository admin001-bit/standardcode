// WP-07 确认 UI 最小流（§8.4 UI-061+§8.3 持久化；解除 M1 ask=拒绝降级——M1 WP-08 偏差②）。
// 语义：ask 裁决 → 用户确认（y=本次允许 / a=总是允许并落 local 层 / n=拒绝）；
// always=addAllow 运行时即时生效（repl 侧）+persistAlwaysAllow 落 local（ADR-0037）。
// 非交互（非 TTY/测试注入）缺省拒绝 fail-closed（SEC-020 不变）。

export type ConfirmChoice = "once" | "always" | "deny";

export interface ConfirmPrompt {
  /** 展示问题并取用户选择（TTY 实现=main.ts 行路由；测试=注入桩）。 */
  confirm(toolLabel: string, detail: string): Promise<ConfirmChoice>;
}

export const DENY_CONFIRM: ConfirmPrompt = {
  async confirm() {
    return "deny";
  },
};

/** TTY 解析（main.ts 消费）：回车=y（本次允许，[CC] 确认语义缺省档）；a=总是；其余=n。 */
export function parseConfirmAnswer(raw: string): ConfirmChoice {
  const s = raw.trim().toLowerCase();
  if (s === "a" || s === "always") return "always";
  if (s === "y" || s === "yes" || s === "") return "once";
  return "deny";
}

export function confirmQuestion(toolLabel: string, detail: string): string {
  return `Allow ${toolLabel}? ${detail}\n  [y] once  [a] always (saved to .standardcode/settings.local.json)  [n] no: `;
}

/**
 * WP-07（ADR-0037）："总是允许"规则构造 [自定]——Bash=命令首词前缀通配（`Bash(<head> *)`，[CC] 命令级
 * 语义）；路径参数工具=字面 file_path/path；其余=工具级。构造结果经 broker.addAllow 构造期清洗（违规抛错→调用方回退 deny）。
 */
export function alwaysAllowRuleFor(toolName: string, input: unknown): string {
  const rec = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof rec.command === "string") {
    const head = rec.command.trim().split(/\s+/)[0] ?? "";
    return `Bash(${head} *)`;
  }
  const p = rec.file_path ?? rec.path;
  if (typeof p === "string") return `${toolName}(${p.replaceAll("\\", "/")})`;
  return toolName;
}

// —— 信任对话框（UI-061：启动工作区信任对话框；细则=以 git 仓库根为密钥覆盖整库）——

export interface TrustDialog {
  askTrust(workdir: string, repoRoot: string | null, symlinkFlagged: boolean): Promise<boolean>;
}

export const DENY_TRUST: TrustDialog = {
  async askTrust() {
    return false;
  },
};

export function trustQuestion(workdir: string, repoRoot: string | null, symlinkFlagged: boolean): string {
  const lines = [
    `Workspace trust: do you trust the files in ${workdir}?`,
    repoRoot ? `  Trust scope: repository root ${repoRoot} (covers the whole repo, §8.3)` : "  (no git repository found — shared settings stay gated)",
    symlinkFlagged ? "  ! .standardcode is a symlink — treated as repo-provided, trust required" : "",
    "  Shared settings (permissions.allow / additionalDirectories / env.*) stay inert until trusted; deny/ask rules apply immediately.",
    "Trust this workspace? [y/N]: ",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function parseTrustAnswer(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "y" || s === "yes";
}
