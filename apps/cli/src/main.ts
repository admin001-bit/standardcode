// CLI 入口装配（§5.1 L0 装配 L1/L3/L5；version 门禁与冷启动门禁不经此路径——bin 对 --version 短路）。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createSession } from "./session.ts";
import { runRepl, completerFor } from "./repl.ts";
import { M1_COMMANDS } from "./commands.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length > 0) {
    process.stdout.write(`usage: standardcode\n   (interactive REPL; --version for version)\n`);
    process.exitCode = 1;
    return;
  }
  let session;
  try {
    session = createSession();
  } catch (err) {
    process.stderr.write(
      `[standardcode] 启动失败：${err instanceof Error ? err.message : String(err)}\n发生了什么：会话装配失败；为什么：M1 需要 provider 凭据或注入；建议动作：设置对应 API key 环境变量后重试。\n`,
    );
    process.exitCode = 1;
    return;
  }
  const rl = createInterface({
    input: process.stdin,
    completer: completerFor(M1_COMMANDS), // UI-001
  });
  rl.on("SIGINT", () => {
    // §8.4 中断：turn 进行中→停流；空闲→提示退出方式（M1 不做二次确认计数）
    if (session.activeAbort) session.activeAbort.abort();
    else process.stdout.write("\n(输入 /exit 退出)\n");
  });
  process.stdout.write(`standardcode ${VERSION} — /help 查看命令，/exit 退出\n`);
  await runRepl({
    session,
    io: { lines: rl, write: (s) => process.stdout.write(s), close: () => rl.close() },
  });
}
