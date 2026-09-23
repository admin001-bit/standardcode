// CLI 入口装配（§5.1 L0 装配 L1/L3/L5；version 门禁与冷启动门禁不经此路径——bin 对 --version 短路）。
import { createInterface } from "node:readline";
import { createSession, PERMISSION_LABEL } from "./session.ts";
import { runRepl, completerFor } from "./repl.ts";
import { gatedRegistry } from "./experimental-gate.ts";
import { FileHistoryStoreImpl, acceptTrust, experimentalSettingsFrom, findGitRoot, isTrusted, isNativeDirSymlink, loadSettings, resolveExperimental, settingsValue, type SessionIndexEntry } from "@standardcode/platform";
import { confirmQuestion, parseConfirmAnswer, trustQuestion, parseTrustAnswer, type ConfirmChoice } from "./confirm.ts";
// M5-WP-03：沙箱开关解析（-sdb 旗标/env 逃逸舱/settings sandbox.*；纯函数面可单测）。
import { gateDangerTier, resolveSandboxSettings } from "./sandbox-config.ts";
import type { SandboxTier } from "@standardcode/capabilities";
// WP-08：版本号单一来源收敛入 version.ts（横幅与 /update/auto-check 的 registry 比对基准同源）。
import { CLI_VERSION } from "./version.ts";
// WP-04（接缝㉔）：键位表单源——本面只消费单源表，不再内联硬编码键位（缺省 shift+tab 见 keybindings.ts）。
import { getKeybindings, keybindingsFromSettings, matchKeyEvent, setKeybindings } from "./keybindings.ts";

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
  // M5-WP-03：唯一旗标 -sdb（显式开启沙箱，EXE-011 行 427；/sandbox 斜杠命令=M7-WP-06 已注册，
  // 见 runRepl 的 `sandbox` 注入面——本旗标态传入命令面作"生效来源"展示）。
  // 命令全集 34 断言=斜杠命令面，旗标不触（WP-10 DoD⑤ 同形）。
  const sandboxCliFlag = argv.length === 1 && argv[0] === "-sdb";
  if (argv.length > 0 && !sandboxCliFlag) {
    process.stdout.write(`usage: standardcode [-sdb]\n   (interactive REPL; --version for version; uninstall [--purge] for removal)\n`);
    process.exitCode = 1;
    return;
  }
  // 启动期 settings 一次装配（沙箱/实验特性位共用同一份合并结果；§7.7 五来源序在 loadSettings 内承载）。
  const bootSettings = loadSettings({ projectRoot: process.cwd() });
  // WP-01：实验特性位（ORC-050 默认关闭）——env STANDARD_CODE_EXPERIMENTAL（逃逸舱）> settings experimental.enabled
  // > 缺省关；非法值 fail-closed；告警（非法值/未知 flag 名）启动即打印，不静默丢弃。门判定=platform 纯函数，
  // 命令表过滤=experimental-gate（装配/补全/派发/help 同一份表，故门关时实验命令既不出现也不可执行）。
  const experimentalSettings = experimentalSettingsFrom(bootSettings.merged);
  const experimental = resolveExperimental({
    env: process.env,
    ...(experimentalSettings !== undefined ? { settings: experimentalSettings } : {}),
  });
  for (const notice of experimental.notices) process.stdout.write(`${notice}\n`);
  const commands = gatedRegistry(experimental);
  const rl = createInterface({
    input: process.stdin,
    completer: completerFor(commands), // UI-001
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
  // M5-WP-03 沙箱装配（解析序/键位见 sandbox-config.ts 头注）：settings 读启动期同一次合并结果（bootSettings）
  // ——sandbox.* 非 env 注入非 allow 规则，未信任共享层置 enabled=收紧执行非攻击面；
  // danger 档另有逐会话显式确认闸（DoD③）兜住放宽方向（[自定] 登记供 V 判）。
  let sandboxInit: { tier: SandboxTier } | undefined;
  {
    const assembly = await gateDangerTier(
      resolveSandboxSettings({
        cliFlag: sandboxCliFlag,
        env: process.env,
        settings: {
          enabled: settingsValue<boolean>(bootSettings, "sandbox.enabled"),
          tier: settingsValue<string>(bootSettings, "sandbox.tier"),
        },
      }),
      async () => {
        if (!process.stdin.isTTY) return false; // 非 TTY=无法显式确认→不启用（fail-closed，非降档）
        const choice = parseConfirmAnswer(await router.askLine(confirmQuestion("sandbox", "danger-full-access：全盘可写+网络全开，沙箱不施加固有限制")));
        return choice === "once" || choice === "always";
      },
    );
    if (assembly.notice) process.stdout.write(`${assembly.notice}\n`);
    if (assembly.enabled) sandboxInit = { tier: assembly.tier };
  }
  let session;
  try {
    session = createSession({
      ...(sandboxInit ? { sandbox: sandboxInit } : {}),
      experimental, // M6-WP-07：teams 工具面装配消费同一份启动期门判定（DoD⑤ 默认关=零构造零触盘）
    });
    if (sandboxInit) process.stdout.write(`[sandbox] 已启用（档=${sandboxInit.tier}，执行面=Bash/写盘经 standardcode-sandbox；关=现状直通）\n`);
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
        // UI-030/附录 A 三要素（R2 修复）：搜索过滤+预览行+选择器内重命名（/[0-9]+ 可跳选择器直取序号）
        async pick(entries: SessionIndexEntry[]): Promise<SessionIndexEntry | null> {
          if (entries.length === 0) return null;
          const fmt = (e: SessionIndexEntry) => `${e.title || "(no title)"}  (${e.messageCount} msgs, last ${e.lastActivityAt ?? "?"})`;
          let candidates = entries;
          for (;;) {
            candidates.forEach((e, i) => process.stdout.write(`  ${i + 1}. ${fmt(e)}\n`));
            const raw = await router.askLine("resume # / <search> / r<N> <title> to rename / empty to cancel: ");
            const s = raw.trim();
            if (s === "") return null;
            if (/^\d+$/.test(s)) {
              const n = Number(s);
              if (n >= 1 && n <= candidates.length) return candidates[n - 1]!;
              process.stdout.write(`[resume] out of range: ${n}\n`);
              continue;
            }
            const rm = /^r(\d+)\s+(.+)$/.exec(s); // r<N> <title>：选择器内重命名（附录 A 要素三）
            if (rm) {
              const n = Number(rm[1]);
              if (n >= 1 && n <= candidates.length) {
                const { renameSessionTitle } = await import("@standardcode/platform");
                await renameSessionTitle(process.cwd(), candidates[n - 1]!.sessionId, rm[2]!);
                candidates = await (async () => (await import("@standardcode/platform")).listSessions(process.cwd()).then((r) => r.sessions))();
                process.stdout.write(`[rename] session renamed\n`);
                continue;
              }
              process.stdout.write(`[resume] out of range: ${n}\n`);
              continue;
            }
            // 搜索：标题/id 子串过滤（附录 A 要素一）
            const q = s.toLowerCase();
            const filtered = candidates.filter((e) => e.title.toLowerCase().includes(q) || e.sessionId.toLowerCase().includes(q));
            if (filtered.length === 0) process.stdout.write(`[resume] no match: ${s}\n`);
            else candidates = filtered;
          }
        },
        // 选择器内重命名钩子（恢复前对历史会话；空输入跳过）
        async rename(entry: SessionIndexEntry): Promise<void> {
          const raw = await router.askLine(`rename this session (empty to keep "${entry.title || "(no title)"}"): `);
          if (raw.trim() !== "") {
            const { renameSessionTitle } = await import("@standardcode/platform");
            await renameSessionTitle(process.cwd(), entry.sessionId, raw.trim());
          }
        },
      }
    : undefined;
  // EXE-001 权限循环键（TTY；非 TTY 管道无键事件——终端兼容矩阵见 WP-11）。
  // WP-04（接缝㉔）：键位改由单源表驱动（apps/cli/src/keybindings.ts，缺省 shift+tab，可经 /keybindings 重绑定）。
  setKeybindings(keybindingsFromSettings(session.settings)); // 启动装配=重启恢复入口（非法设置 fail-closed）
  if (process.stdin.isTTY) {
    const { emitKeypressEvents } = await import("node:readline");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (_s: string, key: { name?: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }) => {
      if (matchKeyEvent(getKeybindings()["permission.cycle"], key)) {
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
  process.stdout.write(`standardcode ${CLI_VERSION} — /help 查看命令，/exit 退出\n`);
  await runRepl({
    session,
    commands, // WP-01：门控后的注册表（派发/help/补全同源）
    experimentalGate: experimental, // M7-WP-07：/btw 侧信道派发开关判据（teams flag）
    io: {
      lines: router.lines,
      write: (s) => process.stdout.write(s),
      close: () => rl.close(),
      // WP-08 DoD③：auto 更新通知行重绘（清当前行+写通知+重绘提示符；preserveCursor=保留已输入缓冲，
      // M4-WP-08 未解决②并发尾窗乱码清偿）。非 TTY/无 rl 宿主不走此路（repl 回落 write）。
      redrawNotice: process.stdin.isTTY
        ? (line) => {
            process.stdout.write("\r\x1b[2K");
            process.stdout.write(line);
            rl.prompt(true);
          }
        : undefined,
    },
    fileHistory,
    confirm: ttyConfirm,
    sessionPicker,
    // M7-WP-06：/sandbox 命令面注入（旗标态=装配期已解析的同一来源；探针缺席=executor 真探针）。
    sandbox: { cliFlag: sandboxCliFlag },
  });
}

// WP-07：uninstall 子命令经 bin shim 路由至本入口的重导出（bundle 单入口；ADR-0044 决策 3/5）。
export { runUninstall } from "./uninstall.ts";
