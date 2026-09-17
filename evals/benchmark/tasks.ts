// WP-11（M3）基准集 v0 12 任务 + M4-WP-11 扩列 v1（M4 DoD② ≥20）——可自动判分（判据脚本断言，卡边界）。
// 全部 recorded：provider 事件流为合成夹具（零网络零凭据）；磁盘夹具全合成无用户数据（golden 脱敏同源纪律）。
// 覆盖族：L1 循环+六工具（b01-06，含 E2E④ malformed 形状）/subagent 执行与摘要（b07）/任务注册表与
// 后台翻转（b08·09，ORC-040/022）/SEC-080 env 清洗（b10）/注册表优先级链（b11，WP-06）/SEC-070 信任门（b12，WP-09）。
// M4 扩列（b13-b20）：MCP 注入链+默认 ask（b13，WP-02 真子进程回放 server）/项目 server 未批准不注入
// （b14，WP-03 S-3）/hooks exit2 阻断+RANK 只升不降（b15）/PreToolUse 超时 fail-closed（b16，WP-04）/
// skills 清单预算+展开注入（b17，WP-05）/memory 索引硬截断+互链（b18，WP-06）/custom agent 端到端
// （b19，session 生产装配链——WP-10 链）/plugin 安装确认 fail-closed+聚合（b20，WP-09 S-5）。
// M4 注记②清偿：b08/b11/b12 补 directBudget（toolEfficiency/contextOverhead 真判据，非恒过虚位）。
// M5-WP-09 扩列 v2（b21-b24，">20 恰界"清偿=M4-WP-11 未解决①）：沙箱策略 wire 契约+帧 codec（b21，WP-01/03）/
// SEC-020b env 注入黑名单（b22）+SEC-030 疑似密钥告警+脱敏链（b23，均 WP-05）/遥测契约+opt-in 门序+接缝⑮（b24，WP-06）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMEvent, ProviderAdapter } from "../../packages/providers/src/index.ts";
import {
  BUILT_IN_AGENTS,
  createAgentRegistry,
  createPermissionBroker,
  createTaskRegistry,
  gateProjectAgentDefinitions,
  parseAgentMarkdown,
  runSubagent,
  spawnSubagentTask,
  SUBAGENT_ANTI_FABRICATION,
  validateSpawn,
  type SubagentDefinition,
} from "../../packages/harness/src/index.ts";
import { buildMcpToolsForConnection, buildSkillListing, connectAll, createHookEngine, createStandardTools, expandSkillBody, gateMcpServerDocs, loadHookConfigs, loadMcpServerConfigs, sanitizeMcpNameSegment } from "../../packages/capabilities/src/index.ts";
import { loadAutoMemory } from "../../packages/context/src/index.ts";
import { buildPluginDocs, componentCounts, installPlugin, loadInstalledPlugins, loadPluginsDoc, pluginsRootDir } from "../../packages/platform/src/index.ts";
import { applySettingsEnv, createTelemetryFacade, mergeSettingsDocs, redactSecrets, resolveTelemetryEnabled, TELEMETRY_ENV_KEY, type TelemetryEnvelope } from "../../packages/platform/src/index.ts";
import { DEFAULT_METADATA_PROTECTION, decodeFrame, encodeFrame, execBash, IPC_PROTOCOL_VERSION, policyFor, SANDBOX_TIERS, type Frame } from "../../packages/executor/src/index.ts";
import { createSession } from "../../apps/cli/src/session.ts";
import { scriptedProvider, BENCHMARK_MODEL, type EvalTask, type ScoreCtx } from "./runner.ts";

// —— 事件夹具 builder（IR 层；finish 形状=e2e-scenarios 先例）——

const DONE: LLMEvent = { type: "finish", reason: "completed", raw: "end_turn" };
const TOOL_DONE: LLMEvent = { type: "finish", reason: "tool_calls", raw: "tool_use" };
const U = (input: number, output: number, cacheW = 0, cacheR = 0): LLMEvent => ({ type: "usage", usage: { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheW, cacheReadTokens: cacheR } });
const use = (id: string, name: string, input: unknown): LLMEvent[] => [
  { type: "tool_start", id, name },
  { type: "tool_input_delta", id, jsonPartial: JSON.stringify(input) },
  { type: "tool_end", id },
];
const reply = (t: string): LLMEvent[] => [{ type: "text_delta", text: t }];

/** direct 任务用最小文本 provider（recorded 子会话）。 */
function textProvider(capture?: { system?: string }): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream(req) {
      if (capture) capture.system = req.system ?? "";
      yield { type: "text_delta", text: "sub-report: found 3 files, no mutations." } as LLMEvent;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } } as LLMEvent;
      yield DONE;
    },
  };
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
function ctxLite(over: Partial<ScoreCtx>): ScoreCtx {
  return { calls: [], results: [], finalText: "", usage: { ...ZERO_USAGE }, events: [], ...over };
}

export function buildTasks(work: string): EvalTask[] {
  const dir = (name: string) => {
    const d = join(work, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const toolsFor = (d: string) => createStandardTools({ cwd: d });

  // b01：读文件并回答（六工具 Read→text）
  const d1 = dir("b01");
  writeFileSync(join(d1, "note.txt"), "eagle-42", "utf8");
  // b02：写文件
  const d2 = dir("b02");
  // b03：编辑文件
  const d3 = dir("b03");
  writeFileSync(join(d3, "cfg.json"), '{"version":1}', "utf8");
  // b04：Glob+单读（效率预算钉死重复读）
  const d4 = dir("b04");
  for (const n of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(d4, n), "const x = 1;\n", "utf8");
  // b05：畸形工具调用连续失败 fail-closed（E2E④ 形状）
  const d5 = dir("b05");
  // b06：大文件读取截断+上下文开销预算
  const d6 = dir("b06");
  writeFileSync(join(d6, "big.txt"), "x".repeat(40_000), "utf8");

  return [
    {
      id: "b01", name: "read-and-answer", seed: "Read note.txt 后以文本回答其内容",
      kind: "loop", sandboxDir: d1, prompt: "read note.txt and answer with its exact content",
      tools: toolsFor(d1),
      turns: [[U(1000, 10), ...use("t1", "Read", { file_path: "note.txt" }), TOOL_DONE], [U(1200, 20), ...reply("The file says: eagle-42"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 3000 },
      completion: (c) => c.calls.some((x) => x.name === "Read") && c.finalText.includes("eagle-42"),
    },
    {
      id: "b02", name: "write-file", seed: "Write out/report.md 落盘",
      kind: "loop", sandboxDir: d2, prompt: "write out/report.md with title STATUS",
      tools: toolsFor(d2),
      turns: [[U(900, 40), ...use("t1", "Write", { file_path: "out/report.md", content: "# STATUS\nok" }), TOOL_DONE], [U(1100, 10), ...reply("written"), DONE]],
      budget: { maxToolCalls: 1, maxInputTokens: 3000 },
      completion: () => readFileSync(join(d2, "out", "report.md"), "utf8") === "# STATUS\nok",
      forbidden: (c) => c.name === "Bash", // 本任务禁 Bash（破坏性面：绕过 Write 面改盘）
    },
    {
      id: "b03", name: "edit-file", seed: "Edit cfg.json version 1→2",
      kind: "loop", sandboxDir: d3, prompt: "bump cfg.json version to 2",
      tools: toolsFor(d3),
      turns: [[U(1000, 10), ...use("t1", "Read", { file_path: "cfg.json" }), TOOL_DONE], [U(1300, 30), ...use("t2", "Edit", { file_path: "cfg.json", old_string: '"version":1', new_string: '"version":2' }), TOOL_DONE], [U(1400, 10), ...reply("bumped"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 4000 },
      completion: () => JSON.parse(readFileSync(join(d3, "cfg.json"), "utf8")).version === 2,
    },
    {
      id: "b04", name: "glob-then-single-read", seed: "Glob *.ts 后单次 Read 汇总（预算 2 钉死重复读）",
      kind: "loop", sandboxDir: d4, prompt: "count .ts files and read one",
      tools: toolsFor(d4),
      turns: [[U(800, 8), ...use("t1", "Glob", { pattern: "*.ts" }), TOOL_DONE], [U(1000, 10), ...use("t2", "Read", { file_path: "a.ts" }), TOOL_DONE], [U(1100, 12), ...reply("3 files; a.ts defines const x"), DONE]],
      budget: { maxToolCalls: 2, maxInputTokens: 3500 },
      completion: (c) => c.calls.length === 2 && c.calls.every((x, i) => c.calls.findIndex((y) => y.name === x.name && JSON.stringify(y.input) === JSON.stringify(x.input)) === i) && c.finalText.includes("3 files"),
    },
    {
      id: "b05", name: "malformed-tools-fail-closed", seed: "未知工具连续两轮→error tool_result 配对、不崩、终局收敛（E2E④ 形状）",
      kind: "loop", sandboxDir: d5, prompt: "do something with a nonexistent tool",
      tools: toolsFor(d5),
      turns: [
        [U(700, 8), ...use("t1", "NoSuchTool", {}), TOOL_DONE],
        [U(800, 8), ...use("t2", "Read", { file_path: 42 }), TOOL_DONE], // 非法 input（缺 requireString）
        [U(900, 8), ...reply("giving up: no suitable tool"), DONE],
      ],
      budget: { maxToolCalls: 2, maxInputTokens: 3000 },
      completion: (c) => c.results.filter((r) => r.isError).length >= 2 && c.finalText.includes("giving up"),
      forbidden: (c) => c.name === "Write" || c.name === "Edit" || c.name === "Bash",
    },
    {
      id: "b06", name: "large-output-truncate", seed: "40KB 单行读→2000 字符行截断标记（READ_MAX_LINE_CHARS；上下文开销预算主案例）",
      kind: "loop", sandboxDir: d6, prompt: "read big.txt and report its length",
      tools: toolsFor(d6),
      turns: [[U(2000, 10), ...use("t1", "Read", { file_path: "big.txt" }), TOOL_DONE], [U(35000, 2000), ...reply("truncated big output confirmed"), DONE]],
      budget: { maxToolCalls: 1, maxInputTokens: 40000 },
      completion: (c) => c.results.some((r) => !r.isError && r.content.includes("line truncated")) && c.results.every((r) => r.content.length <= 30_500) && c.finalText.includes("truncated"),
    },
    // —— direct 族 ——
    {
      id: "b07", name: "subagent-report-antifab", seed: "Explore 子代理同步执行：摘要回传+<subagent_tokens> 标注+防伪造条目进 system（ORC-041/022）",
      kind: "direct",
      async run() {
        const cap: { system?: string } = {};
        const norm = await validateSpawn({ prompt: "count files", description: "count files", subagentType: "Explore" }, { depth: 0, concurrentSubagents: 0, availableTypes: ["Explore"], definitionsOf: (n) => (n === "Explore" ? ({ name: "Explore", description: "ro", tools: ["Read"] } satisfies SubagentDefinition) : undefined) });
        if (!norm.ok) throw new Error("fixture refused: " + norm.code);
        const broker = createPermissionBroker({ mode: "default" });
        const res = await runSubagent(norm.normalized, {
          provider: textProvider(cap), model: BENCHMARK_MODEL, tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "file" }],
          permissionBroker: broker,
        });
        const ok = res.report.includes("sub-report") && res.report.includes("<subagent_tokens>") && cap.system!.includes(SUBAGENT_ANTI_FABRICATION);
        return { ctx: ctxLite({ calls: [{ name: "Subagent", input: { type: "Explore" } }], finalText: res.report }), completion: ok, completionDetail: ok ? "" : `report/tokens/antifab 检查失败 system=${String(cap.system).includes("fabricate")}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 200 },
    },
    {
      id: "b08", name: "task-registry-lifecycle", seed: "注册→取槽→终态→幂等释放→evictAfter 逐出（ORC-040 一致性）",
      kind: "direct",
      async run() {
        let evictFn: (() => void) | null = null;
        const reg = createTaskRegistry({ maxConcurrent: 20, evictAfterMs: 30_000, scheduleEvict: (fn) => { evictFn = fn; } });
        const t = reg.register({ agentId: "a", agentType: "general-purpose", description: "d", isBackgrounded: false });
        const got = reg.takeConcurrencySlot(t.taskId);
        const concurrentHeld = reg.getConcurrentSubagents();
        reg.releaseConcurrencySlot(t.taskId);
        reg.releaseConcurrencySlot(t.taskId); // 幂等：重复释放不二次计数（DoD① 先例面）
        const concurrentAfterRelease = reg.getConcurrentSubagents();
        reg.complete(t.taskId, { content: "ok", totalTokens: 3, totalToolUseCount: 1, totalDurationMs: 1, doneReason: "end" });
        const fire = evictFn as (() => void) | null; // 闭包赋值不进 TS 流分析，本地别名触发注入调度器（evictAfter 逐出动作面）
        if (fire) fire();
        const after = reg.list();
        const ok = got === true && concurrentHeld === 1 && concurrentAfterRelease === 0 && after.length === 0;
        return { ctx: ctxLite({ calls: [{ name: "task-registry", input: { ops: 4 } }] }), completion: ok, completionDetail: ok ? "" : `got=${got} held=${concurrentHeld} afterRelease=${concurrentAfterRelease} list=${after.length}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 }, // M4-WP-11 注记②补实：两维真判据（usage 自报零 token=注册表操作无模型调用）
    },
    {
      id: "b09", name: "sync-to-background-flip", seed: "同步 subagent 超 autoBackgroundMs 翻后台→终态 completed 落账（ORC-022 后台默认/120s 翻转测试注入）",
      kind: "direct",
      async run() {
        const reg = createTaskRegistry({ maxConcurrent: 20 });
        const slowProvider: ProviderAdapter = {
          capabilities: textProvider().capabilities,
          countTokens: async () => 0,
          async *stream() {
            await new Promise((r) => setTimeout(r, 80));
            yield { type: "text_delta", text: "late answer" } as LLMEvent;
            yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
          },
        };
        const launch = await spawnSubagentTask(
          { prompt: "slow work", description: "flip probe", runInBackground: false }, // 显式同步通道（缺省=后台默认 async_launched；同步超阈值才翻 backgrounded）
          { depth: 0, availableTypes: ["general-purpose"] },
          { provider: slowProvider, model: BENCHMARK_MODEL, tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "x" }], permissionBroker: createPermissionBroker({ mode: "default" }) },
          { registry: reg, env: { STANDARD_CODE_AUTO_BACKGROUND_TASKS: "20" } }, // 数字值=该毫秒（parseAutoBackgroundMs 语义，测试注入 20ms）
        );
        if (launch.status !== "backgrounded") return { ctx: ctxLite({}), completion: false, completionDetail: `channel=${launch.status}` };
        // 轮询终态（taskOutput 非阻塞快照口径，WP-05 接口）
        for (let i = 0; i < 100; i++) {
          const rec = reg.get(launch.taskId);
          if (rec?.status === "completed") return { ctx: ctxLite({ calls: [{ name: "Agent", input: { flip: true } }] }), completion: true };
          await new Promise((r) => setTimeout(r, 20));
        }
        return { ctx: ctxLite({}), completion: false, completionDetail: "never reached completed" };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 1000 },
    },
    {
      id: "b10", name: "bash-env-sanitized", seed: "Bash 子进程 env 无 STANDARD_CODE_*/\*_TOKEN 探针（SEC-080 破坏性面=外传）",
      kind: "direct",
      async run() {
        const savedA = process.env.STANDARD_CODE_B10_PROBE;
        const savedB = process.env.B10_TOKEN;
        process.env.STANDARD_CODE_B10_PROBE = "leak-a";
        process.env.B10_TOKEN = "leak-b";
        try {
          const out = await execBash({ command: `node -e "console.log(JSON.stringify(process.env))"` }, { cwd: work });
          const child = JSON.parse(out.trim()) as Record<string, string>;
          const leaks = Object.keys(child).filter((k) => /^STANDARD_CODE_/i.test(k) || /_(KEY|TOKEN|SECRET)$/i.test(k) || /^(BASH_ENV|ENV|NODE_OPTIONS)$/i.test(k) || /^GIT_CONFIG_/i.test(k));
          const ok = leaks.length === 0 && !!(child.PATH ?? child.Path);
          return { ctx: ctxLite({ calls: [{ name: "Bash", input: { command: "printenv-json" } }], finalText: out }), completion: ok, completionDetail: leaks.length ? `leaked: ${leaks.join(",")}` : "", forbiddenHits: leaks.length };
        } finally {
          if (savedA === undefined) delete process.env.STANDARD_CODE_B10_PROBE; else process.env.STANDARD_CODE_B10_PROBE = savedA;
          if (savedB === undefined) delete process.env.B10_TOKEN; else process.env.B10_TOKEN = savedB;
        }
      },
      directBudget: { maxToolCalls: 1 },
    },
    {
      id: "b11", name: "agent-registry-precedence", seed: "project 层同名覆盖 built-in（六层链高来源胜+去重日志）",
      kind: "direct",
      async run() {
        const dups: string[] = [];
        const proj: SubagentDefinition[] = [{ name: "Explore", description: "project override", tools: ["Read"] }];
        const reg = createAgentRegistry({ sources: { project: proj }, onDuplicate: (name, winner) => { void winner; dups.push(name); } });
        const e = reg.get("Explore");
        const ok = e?.source === "project" && e.tools?.join() === "Read" && dups.length === 1 && reg.list().length === BUILT_IN_AGENTS.length;
        return { ctx: ctxLite({ calls: [{ name: "agent-registry", input: { layers: 2 } }] }), completion: ok, completionDetail: ok ? "" : `source=${e?.source} dups=${dups.length}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 }, // M4-WP-11 注记②补实
    },
    {
      id: "b12", name: "sec070-trust-gate", seed: "含 bypassPermissions 的项目级定义未信任不加载、仅内置可用（SEC-070 供应链面）",
      kind: "direct",
      async run() {
        const esc = parseAgentMarkdown("---\nschemaVersion: 1\nname: sneaky\ndescription: d\npermissionMode: bypassPermissions\n---\n", "sneaky.md");
        const gated = await gateProjectAgentDefinitions([esc], { trusted: false });
        const reg = createAgentRegistry({ sources: { project: gated.loadable } });
        const ok = gated.layerWithheld === true && gated.loadable.length === 0 && !reg.get("sneaky") && reg.list().length === BUILT_IN_AGENTS.length;
        return { ctx: ctxLite({ calls: [{ name: "agent-load", input: { withheld: 1 } }] }), completion: ok, completionDetail: ok ? "" : `layerWithheld=${gated.layerWithheld} names=${reg.names().join(",")}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 }, // M4-WP-11 注记②补实（maxInputTokens 维入判）
    },
    // —— M4-WP-11 扩列（b13-b20，M4 DoD② ≥20；能力族对位 WP-02/03/04/05/06/09/10）——
    {
      id: "b13", name: "mcp-tool-injection-default-ask", kind: "direct",
      seed: "stdio 回放 server→mcp__ 命名净化+顶层 anyOf 跳过+MCP 默认 ask 链（WP-02/§5.3(4)/S-3）",
      async run() {
        const d = dir("b13");
        const script = join(d, "server.mjs");
        writeFileSync(script, [
          'let buf = "";',
          'process.stdin.on("data", (c) => { buf += c.toString(); for (;;) { const i = buf.indexOf("\\n"); if (i < 0) break; const t = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (t) handle(JSON.parse(t)); } });',
          'function send(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }',
          'function handle(m) {',
          '  if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: "evals-b13" }, capabilities: {} } }); }',
          '  else if (m.method === "tools/list") { send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
          '    { name: "echo", description: "echoes", inputSchema: { type: "object", properties: { v: { type: "string" } } } },',
          '    { name: "combo", description: "combinator", inputSchema: { anyOf: [{ type: "object" }, { type: "null" }] } }',
          '  ] } }); }',
          '  else if (m.id !== undefined) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } }); }',
          '}',
        ].join("\n"), "utf8");
        const loaded = loadMcpServerConfigs({ user: { mcpServers: { "my srv!": { type: "stdio", command: process.execPath, args: [script] } } } }, {});
        const conns = await connectAll(loaded, { cwd: d, sessionId: "evals-b13", envBase: {} });
        try {
          const conn = conns.find((c) => c.name === "my srv!");
          if (!conn || conn.status !== "connected" || !conn.client) {
            return { ctx: ctxLite({}), completion: false, completionDetail: `conn=${conn?.status ?? "absent"}` };
          }
          const built = await buildMcpToolsForConnection(conn.client, { serverName: "my srv!", transport: "stdio", serverTimeout: undefined, env: {}, isMainLoop: true });
          const full = "mcp__" + sanitizeMcpNameSegment("my srv!") + "__echo";
          const echo = built.tools.find((t) => t.name === full);
          const broker = createPermissionBroker();
          const askDefault = broker.evaluate(full, { v: "x" }).decision;
          broker.addAllow(full);
          const allowAfter = broker.evaluate(full, { v: "x" }).decision;
          const ok = !!echo && echo.mcpInfo.serverName === "my srv!" && built.skipped.some((sk) => sk.name === "combo" && sk.reason.includes("anyOf")) && askDefault === "ask" && allowAfter === "allow";
          return { ctx: ctxLite({ calls: [{ name: "tools/list", input: { server: "my srv!" } }] }), completion: ok, completionDetail: ok ? "" : `echo=${!!echo} skipped=${JSON.stringify(built.skipped)} ask=${askDefault} allow=${allowAfter}` };
        } finally {
          for (const c of conns) await c.close().catch(() => {});
        }
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b14", name: "project-mcp-unapproved-not-injected", kind: "direct",
      seed: "项目级 server 未批准不进合并（S-3 安装即确认；reject 恒赢/approve 放行；WP-03）",
      run: async () => {
        const docs = { user: { mcpServers: { u: { command: "u-cmd" } } }, projectShared: { mcpServers: { p: { command: "p-cmd" }, q: { command: "q-cmd" } } } };
        const g1 = gateMcpServerDocs({ docs, trusted: false, records: {} });
        const names1 = loadMcpServerConfigs(g1.docs, {}).servers.map((x) => x.name).sort().join(",");
        const g2 = gateMcpServerDocs({ docs, trusted: false, records: { p: { decision: "approved" } } });
        const load2 = loadMcpServerConfigs(g2.docs, {}).servers;
        const g3 = gateMcpServerDocs({ docs, trusted: true, records: { p: { decision: "rejected" } } });
        const names3 = loadMcpServerConfigs(g3.docs, {}).servers.map((x) => x.name).sort().join(",");
        const ok =
          names1 === "u" &&
          g1.states.find((x) => x.name === "p")?.state === "pending" &&
          load2.some((x) => x.name === "p" && x.origin === "projectShared") &&
          names3 === "q,u" &&
          g3.dropped.find((x) => x.name === "p")?.state === "rejected";
        return { ctx: ctxLite({ calls: [{ name: "mcp-gate", input: { cases: 3 } }] }), completion: ok, completionDetail: ok ? "" : `n1=${names1} p1=${g1.states.find((x) => x.name === "p")?.state} n3=${names3}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b15", name: "hooks-exit2-block-rank-up", kind: "direct",
      seed: "allow 组+exit2 组同事件=deny（RANK 只升不降）+stderr 入 blockingError+hookSource=user（WP-04）",
      async run() {
        const d = dir("b15");
        const allow = join(d, "allow.mjs");
        const block = join(d, "block.mjs");
        writeFileSync(allow, 'process.stdout.write(JSON.stringify({ decision: "allow" }));\n', "utf8");
        writeFileSync(block, 'process.stderr.write("b15-blocked"); process.exit(2);\n', "utf8");
        const cfg = loadHookConfigs({ user: { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${allow}"` }] }, { matcher: "*", hooks: [{ type: "command", command: `node "${block}"` }] }] } } });
        const engine = createHookEngine(cfg, { trusted: () => true, cwd: d });
        const o = await engine.fire("PreToolUse", { query: { toolName: "Read" }, payload: { tool_name: "Read", tool_input: {} } });
        const ok = o.verdict === "deny" && (o.blockingError ?? "").includes("b15-blocked") && o.decisionReason?.hookSource === "user" && cfg.warnings.length === 0;
        return { ctx: ctxLite({ calls: [{ name: "hooks", input: { fired: 2 } }] }), completion: ok, completionDetail: ok ? "" : `verdict=${o.verdict} blocking=${o.blockingError} src=${o.decisionReason?.hookSource} warn=${cfg.warnings.length}` };
      },
      directBudget: { maxToolCalls: 2, maxInputTokens: 0 },
    },
    {
      id: "b16", name: "pretooluse-timeout-fail-closed", kind: "direct",
      seed: "PreToolUse hook 超时=deny 工具不执行（:61919 fail-closed 无旁路；WP-04 DoD⑤）",
      async run() {
        const d = dir("b16");
        const sleeper = join(d, "sleep.mjs");
        writeFileSync(sleeper, "setTimeout(() => {}, 2500);\n", "utf8"); // 2.5s>timeout 1s；短于 afterAll 清理重试窗（Windows cwd 占用 EPERM 面）
        const cfg = loadHookConfigs({ user: { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${sleeper}"`, timeout: 1 }] }] } } });
        const engine = createHookEngine(cfg, { trusted: () => true, cwd: d });
        const o = await engine.fire("PreToolUse", { query: { toolName: "Read" }, payload: { tool_name: "Read", tool_input: {} } });
        const ok = o.verdict === "deny" && ((o.decisionReason?.reason ?? "") + (o.blockingError ?? "")).includes("fail-closed");
        return { ctx: ctxLite({ calls: [{ name: "hooks", input: { timeoutHook: 1 } }] }), completion: ok, completionDetail: ok ? "" : `verdict=${o.verdict} reason=${o.decisionReason?.reason} blocking=${o.blockingError} nbe=${o.nonBlockingErrors.length}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b17", name: "skills-listing-budget-expand", kind: "direct",
      seed: "清单 1536 截断+预算降档 name-only+展开注入（变量替换+shell 预执行策略剥离）（WP-05 DoD③④⑥）",
      run: async () => {
        const long = "L".repeat(2000);
        const listing = buildSkillListing(
          [{ name: "alpha", description: "short desc", whenToUse: "for tests" }, { name: "beta", description: long }],
          { contextTokens: 200_000 },
        );
        const betaLine = listing.lines.find((l) => l.startsWith("- beta: "));
        const truncated1536 = betaLine === `- beta: ${long.slice(0, 1536)}` && listing.lines.some((l) => l === "- alpha: short desc for tests");
        const tight = buildSkillListing(
          [{ name: "alpha", description: "d".repeat(100) }, { name: "beta", description: long }],
          { contextTokens: 50 }, // 预算=50×0.01×4=2 字节 → 全部降档
        );
        const demotedAll = tight.budgetMode === "priority" && tight.lines.every((l) => !l.includes(": ")) && tight.demoted.length === 2;
        const expanded = expandSkillBody("D=${STANDARD_CODE_SKILL_DIR} S=${STANDARD_CODE_SESSION_ID}\nRun: !`dangerous`", { skillDir: "/sk", projectDir: "/pj", sessionId: "sid42", args: "one" });
        const expandOk = expanded.includes("/sk") && expanded.includes("sid42") && !expanded.includes("${") && expanded.includes("[shell command execution disabled by policy]");
        const ok = truncated1536 && demotedAll && expandOk;
        return { ctx: ctxLite({ calls: [{ name: "skills", input: { listing: 2, expand: 1 } }] }), completion: ok, completionDetail: ok ? "" : `t1536=${truncated1536} demote=${demotedAll} expand=${expandOk}` };
      },
      directBudget: { maxToolCalls: 3, maxInputTokens: 0 },
    },
    {
      id: "b18", name: "automemory-index-truncate", kind: "direct",
      seed: "MEMORY.md 200 行硬截断+字节截断+互链解析（缺失告警不炸）+目录计数（WP-06 DoD①②③）",
      run: async () => {
        const d = dir("b18");
        const mem = join(d, "memory");
        mkdirSync(mem, { recursive: true });
        const idxLines = ["- see also [[m1]] and [[ghost]]"]; // 互链 [[name]] 形且在截断窗口内（200 行前）
        idxLines.push(...Array.from({ length: 250 }, (_, i) => `- [m${i}](m${i}.md) note ${i}`));
        writeFileSync(join(mem, "MEMORY.md"), idxLines.join("\n"), "utf8");
        writeFileSync(join(mem, "m1.md"), "---\nname: m1\ndescription: first\ntype: project\nschemaVersion: 1\n---\nbody of m1\n", "utf8");
        const v = loadAutoMemory(mem);
        const linesOk = v.index.exists && v.index.truncated && v.index.lines === 200 && v.index.bytes <= 25_000;
        const linkOk = v.resolved.some((r) => r.name === "m1") && v.missing.includes("ghost");
        const dBig = join(d, "mem2");
        mkdirSync(dBig, { recursive: true });
        writeFileSync(join(dBig, "MEMORY.md"), "x".repeat(30_000), "utf8"); // 单行 30KB：行数免疫的字节截断面（码点二分形制）
        const v2 = loadAutoMemory(dBig);
        const bytesOk = v2.index.truncated && v2.index.bytes <= 25_000;
        const ok = linesOk && linkOk && bytesOk && v.entryCount === 1;
        return { ctx: ctxLite({ calls: [{ name: "memory", input: { reads: 2 } }] }), completion: ok, completionDetail: ok ? "" : `lines=${v.index.lines}/${v.index.truncated} link=${linkOk} bytes=${v2.index.bytes}/${v2.index.truncated} entries=${v.entryCount}` };
      },
      directBudget: { maxToolCalls: 2, maxInputTokens: 0 },
    },
    {
      id: "b19", name: "custom-agent-e2e-production", kind: "direct",
      seed: "项目 .md→SEC-070 确认留痕→registry→validateSpawn 类型解析→runSubagent def 装配（session 生产面端到端；WP-10 链）",
      async run() {
        const home = join(dir("b19"), "home");
        const proj = join(dir("b19"), "proj");
        mkdirSync(join(proj, ".standardcode", "agents"), { recursive: true });
        writeFileSync(join(proj, ".standardcode", "agents", "e2e.md"), "---\nschemaVersion: 1\nname: e2e\ndescription: e2e agent\npermissionMode: bypassPermissions\n---\nE2E project agent.\n", "utf8");
        const cap: { system?: string } = {};
        const s = createSession({ provider: textProvider(cap), catalog: ["m"], model: "m", cwd: proj, projectRoot: proj, home, trusted: true });
        const st = await s.agents.loadProjectAgents({ confirm: async () => true });
        const local = JSON.parse(readFileSync(join(proj, ".standardcode", "settings.local.json"), "utf8"));
        const { ctx } = s.agents.prepareSpawn("e2e");
        const v = await validateSpawn({ prompt: "task", subagentType: "e2e", description: "d" }, { ...ctx, concurrentSubagents: 0 });
        if (!v.ok) return { ctx: ctxLite({}), completion: false, completionDetail: `spawn=${v.code}` };
        const res = await runSubagent(v.normalized, {
          provider: textProvider(cap), model: BENCHMARK_MODEL,
          tools: [{ name: "Read", description: "d", inputSchema: {}, execute: async () => "file" }],
          permissionBroker: s.broker,
        });
        const ok =
          v.normalized.definition.systemPrompt === "E2E project agent." &&
          s.agents.names().includes("e2e") &&
          local.agentTrust?.e2e?.permissionMode === "bypassPermissions" &&
          res.report.includes("sub-report") &&
          cap.system === "E2E project agent.\n\n" + SUBAGENT_ANTI_FABRICATION &&
          st.stripped.length === 0;
        return { ctx: ctxLite({ calls: [{ name: "Agent", input: { type: "e2e" } }], usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } }), completion: ok, completionDetail: ok ? "" : `sys=${JSON.stringify(cap.system)} trust=${JSON.stringify(local.agentTrust)}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 50 }, // 子代理夹具 usage 入判（token 维真判据）
    },
    {
      id: "b20", name: "plugin-install-confirm-failclosed", kind: "direct",
      seed: "S-5 安装确认先于任何写盘（拒绝零半程）+留痕+四注入面聚合 docs+同名 exists（WP-09 DoD③④）",
      async run() {
        const d = dir("b20");
        const baseDir = join(d, "base");
        const src = join(d, "src");
        mkdirSync(join(src, "skills", "pk-s"), { recursive: true });
        writeFileSync(join(src, "skills", "pk-s", "SKILL.md"), "---\ndescription: pk skill\n---\nb\n", "utf8");
        writeFileSync(join(src, "plugin.json"), JSON.stringify({
          schemaVersion: 1, name: "b20-suite", version: "0.2.0",
          hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node x.mjs" }] }] },
          mcpServers: { b20srv: { type: "stdio", command: "x" }, dup: { type: "stdio", command: "y" } },
        }), "utf8");
        const declined = await installPlugin(src, { baseDir, opts: { onConfirm: async () => false } });
        const zeroLanding = declined.error === "declined" && loadPluginsDoc(baseDir).plugins.length === 0 && !existsSync(pluginsRootDir(baseDir));
        const ok2 = await installPlugin(src, { baseDir });
        const second = await installPlugin(src, { baseDir });
        const views = loadInstalledPlugins(baseDir);
        const docs = buildPluginDocs(views);
        const counts = componentCounts(views[0]!.manifest!);
        const ok =
          zeroLanding && ok2.ok === true && second.error === "exists" &&
          (docs.hooksDoc?.hooks as Record<string, unknown>).PreToolUse !== undefined &&
          (docs.mcpDoc?.mcpServers as Record<string, unknown>).b20srv !== undefined &&
          counts.skills.join() === "pk-s" && counts.mcpServers.join() === "b20srv,dup" &&
          ((docs.hooksDoc?.hooks as Record<string, unknown[]>).PreToolUse ?? []).length === 1;
        return { ctx: ctxLite({ calls: [{ name: "plugin", input: { installs: 3 } }] }), completion: ok, completionDetail: ok ? "" : `zero=${zeroLanding} e2=${second.error} hooks=${JSON.stringify(docs.hooksDoc)} skills=${counts.skills}` };
      },
      directBudget: { maxToolCalls: 3, maxInputTokens: 0 },
    },

    // —— M5-WP-09 扩列 v2（b21-b24；M5 三族：沙箱/SEC/遥测）——
    {
      id: "b21", name: "sandbox-policy-wire-contract", kind: "direct",
      seed: "三档 wire 策略形状+元数据默认名单（EXE-011 行 427）+帧 codec 往返/坏帧拒绝（WP-01/03，ARCH-008）",
      async run() {
        const ro = policyFor("read-only", "/ws");
        const ww = policyFor("workspace-write", "/ws");
        const danger = policyFor("danger-full-access", "/ws");
        const frame: Frame = { v: IPC_PROTOCOL_VERSION, kind: "request", id: 7, payload: { x: 1 } };
        const encoded = encodeFrame(frame);
        const round = decodeFrame(encoded);
        let mismatch = "";
        let oversized = "";
        try {
          decodeFrame(encoded.replace(`"v":${IPC_PROTOCOL_VERSION}`, '"v":4'));
        } catch (e) {
          mismatch = (e as Error).message;
        }
        try {
          encodeFrame({ v: IPC_PROTOCOL_VERSION, kind: "response", id: 1, payload: "x".repeat(17 * 1024 * 1024) });
        } catch (e) {
          oversized = (e as Error).message;
        }
        const metaOk = [ro, ww, danger].every((p) => JSON.stringify(p.fs.metadata) === JSON.stringify(DEFAULT_METADATA_PROTECTION));
        const ok =
          SANDBOX_TIERS.join() === "read-only,workspace-write,danger-full-access" &&
          ro.fs.kind === "restricted" && ro.fs.writable_roots.length === 0 && ro.net === "denied" &&
          ww.fs.writable_roots[0]?.path === "/ws" && ww.fs.writable_roots[0]?.shape === "real" && ww.net === "denied" &&
          danger.fs.kind === "unrestricted" && danger.net === "allowed" &&
          metaOk &&
          DEFAULT_METADATA_PROTECTION.protected_names.join() === ".git,.standardcode" &&
          DEFAULT_METADATA_PROTECTION.read_only_subpaths.join() === ".git/hooks" &&
          encoded.endsWith("\n") && round.kind === "request" && round.id === 7 &&
          mismatch.includes("protocol version mismatch") && oversized.includes("frame too large");
        return { ctx: ctxLite({ calls: [{ name: "sandbox", input: { tiers: 3, frames: 2 } }] }), completion: ok, completionDetail: ok ? "" : `mismatch="${mismatch}" oversized="${oversized}" meta=${metaOk}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b22", name: "sec020b-env-blacklist", kind: "direct",
      seed: "黑名单键（PATH/LD_PRELOAD/NODE_OPTIONS）经项目级源拒注入+告警、大小写不敏感；user 源不设限（WP-05 SEC-020b）",
      async run() {
        const loaded = mergeSettingsDocs({
          managed: null,
          flag: null,
          projectLocal: { env: { path: "C:\\evil-bin" } },
          projectShared: { env: { PATH: "/evil", NODE_OPTIONS: "--inspect" } },
          user: { env: { EVALS_B22_OK: "1" } },
        });
        const target: Record<string, string | undefined> = {};
        const r = applySettingsEnv(loaded, target);
        const upperBlocked = r.blocked.map((b) => b.toUpperCase());
        const ok =
          upperBlocked.includes("PATH") && upperBlocked.includes("NODE_OPTIONS") &&
          r.blocked.length === 3 &&
          target.PATH === undefined && target.NODE_OPTIONS === undefined && target.path === undefined &&
          target.EVALS_B22_OK === "1" && r.injected.includes("EVALS_B22_OK") &&
          loaded.warnings.filter((w) => w.reason.includes("SEC-020b")).length === 3;
        return { ctx: ctxLite({ calls: [{ name: "settings", input: { blocked: r.blocked, injected: r.injected } }] }), completion: ok, completionDetail: ok ? "" : `blocked=${JSON.stringify(r.blocked)} injected=${JSON.stringify(r.injected)} warns=${JSON.stringify(loaded.warnings)}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b23", name: "sec030-redaction-chain", kind: "direct",
      seed: "疑似密钥告警（≥20 字符 KEY/TOKEN/SECRET 命名键；分词边界防误报）+redactSecrets 形状白名单脱敏幂等（WP-05 SEC-030/S-10）",
      async run() {
        const loaded = mergeSettingsDocs({
          managed: null,
          flag: null,
          projectLocal: null,
          projectShared: null,
          user: { env: { DEPLOY_TOKEN: "supersecretvalue1234567890", MONKEY_BUSINESS: "x".repeat(30) } },
        });
        const secretWarn = loaded.warnings.filter((w) => w.reason.includes("suspected plaintext secret"));
        const monkeyWarn = loaded.warnings.filter((w) => w.path.includes("MONKEY"));
        const redacted = redactSecrets("key sk-ant-api03-abcdefghijklmnop Bearer abcdefghijklmnopqrstux");
        const ok =
          secretWarn.length === 1 && secretWarn[0]!.path.includes("DEPLOY_TOKEN") &&
          monkeyWarn.length === 0 &&
          redacted.includes("[REDACTED]") && !redacted.includes("sk-ant-api03-abcdefghijklmnop") &&
          !redacted.includes("abcdefghijklmnopqrstux") &&
          redactSecrets(redacted) === redacted;
        return { ctx: ctxLite({ calls: [{ name: "sec030", input: { warns: secretWarn.length } }] }), completion: ok, completionDetail: ok ? "" : `warns=${secretWarn.length} monkey=${monkeyWarn.length} redacted="${redacted}"` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
    {
      id: "b24", name: "telemetry-contract-gate-redact", kind: "direct",
      seed: "七事件 sc_ 前缀+opt-in 门序（env>settings>缺省关 fail-closed）+关态零发射+事件体 redactSecrets 单源（WP-06/接缝⑮）",
      async run() {
        const gate =
          resolveTelemetryEnabled({ env: { [TELEMETRY_ENV_KEY]: "1" } }) === true &&
          resolveTelemetryEnabled({ env: { [TELEMETRY_ENV_KEY]: "0" }, settingsEnabled: true }) === false &&
          resolveTelemetryEnabled({ settingsEnabled: true }) === true &&
          resolveTelemetryEnabled({ env: { [TELEMETRY_ENV_KEY]: "weird" }, settingsEnabled: true }) === false &&
          resolveTelemetryEnabled({}) === false;
        const seen: TelemetryEnvelope[] = [];
        const sink = { write: (events: readonly TelemetryEnvelope[]) => void seen.push(...events) };
        const off = createTelemetryFacade({ env: {}, sink });
        off.queryError({ message: "should not emit" });
        const offQuiet = seen.length === 0 && off.isEnabled() === false;
        const on = createTelemetryFacade({ env: { [TELEMETRY_ENV_KEY]: "1" }, sink });
        on.queryError({ message: "token sk-ant-api03-abcdefghijklmnop leaked?" });
        await on.flush();
        const ok =
          gate && offQuiet &&
          seen.length === 1 && seen[0]!.event === "sc_query_error" &&
          !JSON.stringify(seen).includes("sk-ant-api03-abcdefghijklmnop") &&
          JSON.stringify(seen).includes("[REDACTED]");
        return { ctx: ctxLite({ calls: [{ name: "telemetry", input: { emitted: seen.length, gate } }] }), completion: ok, completionDetail: ok ? "" : `gate=${gate} off=${offQuiet} seen=${JSON.stringify(seen)}` };
      },
      directBudget: { maxToolCalls: 1, maxInputTokens: 0 },
    },
  ];
}
