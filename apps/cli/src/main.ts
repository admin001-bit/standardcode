// CLI 入口装配（§5.1 L0 装配 L1/L3/L5；version 门禁与冷启动门禁不经此路径——bin 对 --version 短路）。
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { createSession, PERMISSION_LABEL } from "./session.ts";
import { runRepl, completerFor } from "./repl.ts";
import { CLI_COMMANDS } from "./commands.ts";
import { FileHistoryStoreImpl, acceptTrust, findGitRoot, isTrusted, isNativeDirSymlink, type SessionIndexEntry } from "@standardcode/platform";
import { confirmQuestion, parseConfirmAnswer, trustQuestion, parseTrustAnswer, type ConfirmChoice } from "./confirm.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * 行路由（WP-10）：交互提问（确认/选择器）与 REPL 命令流共用一个 readline——
 * waiter 队列优先消费，提问答案不进命令流（rl.question 与 async iterator 并挂会双吃的坑）。
 */
function createLineRouter(rl: import("node:readline").Interface) {
  const waiters: ((line: string) => void)[] = [];
  return {
    askLine(question: string): Promise<string> {
      process.stdout.write(question);
      return new Promise((resolve) => {
        waiters.push((line) => resolve(line));
      });
    },
    lines: (async function* () {
      for await (const raw of rl) {
        const w = waiters.shift();
        if (w) {
          w(raw);
          continue;
        }
        yield raw;
      }
    })(),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length > 0) {
    process.stdout.write(`usage: standardcode\n   (interactive REPL; --version for version)\n`);
    process.exitCode = 1;
    return;
  }
  const rl = createInterface({
    input: process.stdin,
    completer: completerFor(CLI_COMMANDS), // UI-001
  });
  const router = createLineRouter(rl);
  // WP-07（UI-061）：启动信任对话框——非 TTY/已信任跳过；接受以 git 仓库根为密钥写 trust store。
  if (process.stdin.isTTY) {
    const workdir = process.cwd();
    if (!isTrusted(workdir)) {
      const repoRoot = findGitRoot(workdir);
      const symlinkFlagged = isNativeDirSymlink(workdir);
      const answer = await router.askLine(trustQuestion(workdir, repoRoot, symlinkFlagged));
      if (parseTrustAnswer(answer)) acceptTrust(workdir);
      else process.stdout.write("[trust] proceeding without trust — shared settings stay gated (deny/ask still apply)\n");
    }
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
  // WP-09：file-history store（快照+/rewind 数据面；缺席仅降级提示）
  let fileHistory;
  try {
    fileHistory = await FileHistoryStoreImpl.create(session.cwd);
  } catch {
    process.stdout.write("[file-history] store unavailable — /rewind disabled\n");
  }
  // WP-07 确认 UI 最小流 + WP-10 /resume 选择器：共用行路由（提问答案不进命令流）。
  const ttyConfirm = process.stdin.isTTY
    ? {
        async confirm(toolLabel: string, detail: string): Promise<ConfirmChoice> {
          return parseConfirmAnswer(await router.askLine(confirmQuestion(toolLabel, detail)));
        },
      }
    : undefined;
  const sessionPicker = process.stdin.isTTY
    ? {
        async pick(entries: SessionIndexEntry[]): Promise<SessionIndexEntry | null> {
          if (entries.length === 0) return null;
          entries.forEach((e, i) => process.stdout.write(`  ${i + 1}. ${e.title || "(no title)"}  (${e.messageCount} msgs, last ${e.lastActivityAt ?? "?"})\n`));
          const raw = await router.askLine("resume # (1-based, empty to cancel): ");
          const n = Number(raw.trim());
          if (!Number.isInteger(n) || n < 1 || n > entries.length) return null;
          return entries[n - 1]!;
        },
      }
    : undefined;
  // EXE-001 shift+tab 切换（TTY；非 TTY 管道无键事件——终端兼容矩阵见 WP-11）
  if (process.stdin.isTTY) {
    const { emitKeypressEvents } = await import("node:readline");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (_s: string, key: { name?: string; shift?: boolean; ctrl?: boolean }) => {
      if (key?.shift && key.name === "tab" && !key.ctrl) {
        const next = session.broker.cycle();
        process.stdout.write(`\n[permission] ${PERMISSION_LABEL[next]} (${next})\n`);
        rl.prompt();
      }
    });
  }
  rl.on("SIGINT", () => {
    // §8.4 中断：turn 进行中→停流；空闲→提示退出方式（M1 不做二次确认计数）
    if (session.activeAbort) session.activeAbort.abort();
    else process.stdout.write("\n(输入 /exit 退出)\n");
  });
  process.stdout.write(`standardcode ${VERSION} — /help 查看命令，/exit 退出\n`);
  await runRepl({
    session,
    io: { lines: router.lines, write: (s) => process.stdout.write(s), close: () => rl.close() },
    fileHistory,
    confirm: ttyConfirm,
    sessionPicker,
  });
}
