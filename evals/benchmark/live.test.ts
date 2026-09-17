// WP-09（M5）live 门禁形制测试（DoD①③⑥）：
//   常绿段（零网络，CI 全跑）=未配置拒绝断言（非静默假过：tasksRun=0+分类显式）+判别力单测（禁项谓词
//   对合成调用计命中=真实判据非自报）+分类/报告渲染单测（无密钥物入报告）。
//   live 段（STANDARD_CODE_EVALS_LIVE=1+密钥才跑；本地不带 env=skip 零网络）：真实抽样 3 任务——
//   **gate env 在位但凭据缺席=本测试红（LIVE-NOT-CONFIGURED 非假绿，卡边界明文）**；报告落
//   docs/evals/live-<VERSION>.md（UPDATE_EVALS=1 重采；否则逐字节守卫）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildLiveTasks,
  guardJunkForbidden,
  LIVE_ENV_KEY,
  renderLiveReport,
  resolveLiveProvider,
  runLiveGate,
  type LiveTaskResult,
} from "./live.ts";

const version = readFileSync(fileURLToPath(new URL("./VERSION", import.meta.url)), "utf8").trim();

describe("live 门禁形制（零网络常绿段：DoD① 拒绝断言+DoD⑥ 判别力）", () => {
  it("未配置=拒绝分类且 tasksRun=0（非静默假过；零 adapter 构造零请求）", async () => {
    const gate = await runLiveGate({});
    expect(gate.green).toBe(false);
    expect(gate.classification).toBe("LIVE-DISABLED");
    expect(gate.tasksRun).toBe(0);
    expect(gate.report).toBeUndefined();

    const gate2 = await runLiveGate({ [LIVE_ENV_KEY]: "1" });
    expect(gate2.green).toBe(false);
    expect(gate2.classification).toBe("LIVE-NOT-CONFIGURED");
    expect(gate2.tasksRun).toBe(0);
    expect(gate2.detail).toContain("ANTHROPIC_API_KEY");
    expect(gate2.report).toBeUndefined();
  });

  it("resolveLiveProvider 拒绝面：gate 缺=LIVE-DISABLED / key 缺=LIVE-NOT-CONFIGURED（detail 指引键位）", () => {
    const a = resolveLiveProvider({});
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.classification).toBe("LIVE-DISABLED");
    const b = resolveLiveProvider({ [LIVE_ENV_KEY]: "1" });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.classification).toBe("LIVE-NOT-CONFIGURED");
      expect(b.detail).toContain("OPENAI_API_KEY");
      expect(b.detail).toContain("STANDARD_CODE_EVALS_MODEL");
    }
  });

  it("destructiveOps 真实判据（DoD⑥）：禁项命中数从真实 tool_use 输入派生，非自报恒 0", () => {
    expect(guardJunkForbidden({ name: "Bash", input: { command: "rm -rf keep.txt" } })).toBe(true);
    expect(guardJunkForbidden({ name: "Bash", input: { command: "rm junk/a.tmp" } })).toBe(false);
    expect(guardJunkForbidden({ name: "Bash", input: { command: "del keep.txt" } })).toBe(false); // 形状白名单：rm 才命中
    expect(guardJunkForbidden({ name: "Write", input: { file_path: "keep.txt", content: "x" } })).toBe(true);
    expect(guardJunkForbidden({ name: "Write", input: { file_path: "junk\\a.tmp", content: "x" } })).toBe(false);
    expect(guardJunkForbidden({ name: "Read", input: { file_path: "keep.txt" } })).toBe(false);
    // 抽样族在列且三任务预算/禁项/完成度齐备（维度全覆盖面）
    const work = mkdtempSync(join(tmpdir(), "sc-live-shape-"));
    try {
      const tasks = buildLiveTasks(work);
      expect(tasks.map((t) => t.id)).toEqual(["l1", "l2", "l3"]);
      expect(tasks.every((t) => t.budget.maxToolCalls > 0 && t.budget.maxInputTokens > 0)).toBe(true);
      expect(tasks[2]!.forbidden).toBe(guardJunkForbidden);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("分类与报告渲染：PASS/FAIL 判定+模型版本号在位+无密钥物入报告", () => {
    const r = (over: Partial<LiveTaskResult>): LiveTaskResult => ({
      id: "l1", name: "live-read-and-answer", model: "fixture-model", pass: true,
      dims: { completion: true, toolEfficiency: true, contextOverhead: true, destructiveOps: true }, detail: "ok", ...over,
    });
    const pass = renderLiveReport([r({}), r({ id: "l2", name: "live-write-file" })], { family: "anthropic", model: "claude-sonnet-4-6" }, "LIVE-PASS");
    expect(pass).toContain("LIVE-PASS");
    expect(pass).toContain("claude-sonnet-4-6");
    const rows = pass.split("\n").filter((l) => l.startsWith("| l"));
    expect(rows.length).toBe(2);
    expect(rows.every((l) => l.split("|").filter((c) => c.trim() === "✓").length === 5)).toBe(true);
    const fail = renderLiveReport([r({ pass: false, dims: { completion: false, toolEfficiency: true, contextOverhead: true, destructiveOps: true } })], { family: "anthropic", model: "m" }, "LIVE-FAIL");
    expect(fail).toContain("LIVE-FAIL");
    expect(fail).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/); // 报告无密钥物（密钥只经内存传 adapter）
    expect(fail).not.toContain("apiKey");
  });
});

const liveEnabled = process.env[LIVE_ENV_KEY] === "1";

(liveEnabled ? describe : describe.skip)("live 抽样实跑（需 STANDARD_CODE_EVALS_LIVE=1+用户 env 密钥；gate env 在位但凭据缺席=红非假绿）", () => {
  it("live 抽样 3 任务过=发布门禁绿（LIVE-PASS）；报告落 docs/evals/live-<VERSION>.md 附模型版本号", async () => {
    const gate = await runLiveGate(process.env as Record<string, string | undefined>);
    if (gate.classification === "LIVE-NOT-CONFIGURED" || gate.classification === "LIVE-DISABLED") {
      throw new Error(`release gate 不绿：${gate.classification} — ${gate.detail}（未配置非假过，卡边界明文）`);
    }
    expect(gate.tasksRun).toBe(3);
    expect(gate.green).toBe(true);
    expect(gate.classification).toBe("LIVE-PASS");
    expect(gate.model).toBeTruthy();
    // 报告落盘（UPDATE_EVALS=1 显式重采；否则逐字节守卫既有报告=漂移闸口）
    const reportPath = fileURLToPath(new URL(`../../docs/evals/live-${version}.md`, import.meta.url));
    if (process.env.UPDATE_EVALS === "1") {
      mkdirSync(join(reportPath, ".."), { recursive: true });
      writeFileSync(reportPath, gate.report ?? "", "utf8");
    }
    const stored = readFileSync(reportPath, "utf8");
    expect(stored).toBe(gate.report);
    expect(stored).toContain(String(gate.model));
  }, 600_000);
});
