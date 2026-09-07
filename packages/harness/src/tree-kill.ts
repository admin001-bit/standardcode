// 进程树终止原语（§8.4 中断不变量：信号传播整个子进程树）。
// M1 落 taskkill /T（Windows）/ 进程组 SIGKILL（POSIX）；Windows Job Object 归 executor（WP-07）集成。

import { spawn, type ChildProcess } from "node:child_process";

export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /T 连同子树终止（不等待；调用方自行监听 exit）
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      // detached 子进程构成进程组，负 pid 杀整组
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
