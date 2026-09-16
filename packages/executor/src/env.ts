// L4 执行底座：工具执行环境。cwd 由 L3（capabilities）按会话配置注入；
// signal/registerProcess 与 harness ToolContext 形状同构（工具 MUST 观察中断并及时退出，§8.4）。
// SEC-080（§11）：工具子进程 env 白名单清洗——密钥通道与 Bash 注入键不得进入子进程（M3 WP-08）。
import type { ChildProcess } from "node:child_process";
import type { SandboxHandle } from "./sandbox/client.ts";

export interface ExecEnv {
  /** 会话工作目录：相对路径以此为基解析。 */
  cwd: string;
  /** 子进程环境（显式 > 隐式）：缺席=runProcess 现场经 sanitizeToolEnv 清洗（fail-closed 缺省）。 */
  env?: NodeJS.ProcessEnv;
  /** 超限输出落盘目录（E2E②；缺席=tmpdir——测试注入以断言落盘内容）。 */
  spillDir?: string;
  /**
   * 沙箱句柄（WP-03/EXE-011：-sdb 开启时由装配层注入）。在位=Bash 与文件写经
   * `standardcode-sandbox --serve`（ARCH-008 帧通道）执行；缺席=现状直通（默认关，ADR-002）。
   */
  sandbox?: SandboxHandle;
  signal?: AbortSignal;
  /** 工具派生的子进程注册到此处——中断时由 harness 负责进程树终止（§8.4）。 */
  registerProcess?(child: ChildProcess): void;
}

export class ExecError extends Error {}

// —— SEC-080 env 清洗 ——

export interface ToolEnvStripRule {
  /** 规则标识（逐键断言与快照 debug 通道的归因位）。 */
  id: string;
  /** SEC-080 原文条目（锚点回查）。 */
  spec: string;
  /** 命中即剔除（大小写不敏感：Windows env 名不区分大小写，剔除取严）。 */
  strips(name: string): boolean;
}

export const TOOL_ENV_STRIP_RULES: readonly ToolEnvStripRule[] = [
  { id: "standardcode-channel", spec: "STANDARD_CODE_*（含 API key 通道）", strips: (n) => n.toUpperCase().startsWith("STANDARD_CODE_") },
  { id: "key-suffix", spec: "*_KEY", strips: (n) => n.toUpperCase().endsWith("_KEY") },
  { id: "token-suffix", spec: "*_TOKEN", strips: (n) => n.toUpperCase().endsWith("_TOKEN") },
  { id: "secret-suffix", spec: "*_SECRET", strips: (n) => n.toUpperCase().endsWith("_SECRET") },
  { id: "bash-injection", spec: "BASH_ENV/ENV 执行面注入键", strips: (n) => { const u = n.toUpperCase(); return u === "BASH_ENV" || u === "ENV"; } },
  { id: "git-config", spec: "GIT_CONFIG_*", strips: (n) => n.toUpperCase().startsWith("GIT_CONFIG_") },
  { id: "node-options", spec: "NODE_OPTIONS", strips: (n) => n.toUpperCase() === "NODE_OPTIONS" },
];

export interface ToolEnvSnapshot {
  /** 清洗后的子进程环境（保留项，如 PATH/SystemRoot——"按需保留"）。 */
  env: NodeJS.ProcessEnv;
  /** 被剔除的键名（原样大小写；快照 debug 通道消费，SEC-080"记录"位）。 */
  removed: string[];
  /** 命中规则 id 列表（与 removed 同序）。 */
  strippedBy: string[];
}

/** 工具子进程 env 白名单清洗（SEC-080）：剔除清单见 TOOL_ENV_STRIP_RULES；API key（*_KEY 通道）绝不下沉子进程。 */
export function sanitizeToolEnv(source: NodeJS.ProcessEnv = process.env): ToolEnvSnapshot {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  const strippedBy: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    const hit = TOOL_ENV_STRIP_RULES.find((r) => r.strips(name));
    if (hit) {
      removed.push(name);
      strippedBy.push(hit.id);
      continue;
    }
    if (value !== undefined) env[name] = value;
  }
  return { env, removed, strippedBy };
}
