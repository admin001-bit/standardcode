// WP-11（M3）基准集 v0 运行面（DoD① runner recorded 全绿+DoD② ≥10 任务各有自动判分+DoD③ 出分记录）。
// M4-WP-11 扩列 v1（M4 DoD②"基准集扩到 ≥20 任务"原文判据）：reportPath 随 VERSION 动态化（v0.md 档案留存不改）；
// 报告=渲染与落盘文件逐字节守卫（compact-summarizer Golden 同型纪律）：结果漂移/忘更新出分 → 本测试红；
// 重采集=UPDATE_EVALS=1 跑一次（写 docs/evals/v<N>.md 后复跑守卫绿）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEvalTask, renderReport, BENCHMARK_MODEL, type TaskResult } from "./runner.ts";
import { buildTasks } from "./tasks.ts";

const version = readFileSync(fileURLToPath(new URL("./VERSION", import.meta.url)), "utf8").trim();
const reportPath = fileURLToPath(new URL(`../../docs/evals/${version}.md`, import.meta.url));

let work: string;
let results: TaskResult[];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), `sc-evals-${version}-`));
  results = [];
  for (const task of buildTasks(work)) {
    results.push(await runEvalTask(task));
  }
}, 180_000);

afterAll(() => {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch {
    /* Windows 子进程尾窗（b16 超时 hook 子进程持 cwd）：临时目录残留可接受，系统 tmp 自清 */
  }
});

describe("DoD①/② runner recorded 全绿+基准集（v0 ≥10；v1 ≥20=M4 DoD② 原文判据）", () => {
  it("任务数 ≥20 且逐任务四维度结构完整（完成度/工具效率/上下文开销/破坏性操作数）", () => {
    expect(results.length).toBeGreaterThanOrEqual(20);
    for (const r of results) {
      expect(Object.keys(r.dims).sort()).toEqual(["completion", "contextOverhead", "destructiveOps", "toolEfficiency"]);
      expect(r.model).toBe(BENCHMARK_MODEL); // 结论附模型版本号（ENG-030）
    }
  });

  it("recorded 模式全绿（每任务四维全 ✓；判分失败打印明细）", () => {
    const failed = results.filter((r) => !r.pass).map((r) => `${r.id}/${r.name}: ${JSON.stringify(r.dims)}`);
    expect(failed).toEqual([]);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe("DoD③ 出分记录落盘（docs/evals/<VERSION>.md 逐字节守卫+VERSION 独立版本化【勘误 2026-09-15 V：题头 v0 字样随 v1 更新】）", () => {
  it("报告与运行结果一致（漂移=红；UPDATE_EVALS=1 重采集）", () => {
    const rendered = renderReport(results, version);
    if (process.env.UPDATE_EVALS === "1") {
      mkdirSync(join(reportPath, ".."), { recursive: true });
      writeFileSync(reportPath, rendered, "utf8");
    }
    const stored = readFileSync(reportPath, "utf8");
    expect(stored).toBe(rendered);
    expect(stored).toContain(`# evals 基准集 ${version} 出分记录`);
    expect(stored).toContain(BENCHMARK_MODEL);
  });
});
