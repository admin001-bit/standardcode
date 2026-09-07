// L4 执行底座：工具执行环境。cwd 由 L3（capabilities）按会话配置注入；
// signal/registerProcess 与 harness ToolContext 形状同构（工具 MUST 观察中断并及时退出，§8.4）。
import type { ChildProcess } from "node:child_process";

export interface ExecEnv {
  /** 会话工作目录：相对路径以此为基解析。 */
  cwd: string;
  signal?: AbortSignal;
  /** 工具派生的子进程注册到此处——中断时由 harness 负责进程树终止（§8.4）。 */
  registerProcess?(child: ChildProcess): void;
}

export class ExecError extends Error {}
