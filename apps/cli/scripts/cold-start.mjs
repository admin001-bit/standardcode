#!/usr/bin/env node
// WP-06 冷启动门禁计时脚本。口径（在脚本内固定）[自定]：空载冷启动 = 子进程自 spawn 起、
// 至打印 --version 输出并退出止的墙钟时间（M0 CLI 为占位入口、无内部阶段可分；阶段化遥测口径
// 参照 [CC] dig-08 §1，待真实启动链落地后细化）。3 次预热不计入，取 21 次实测中位数。
// 阈值默认 400ms（v2.8 §2 M0 DoD）；CI 侧经 ci.yml 步骤级 env 钉死 400（WP-12，仓库级 env 不可覆盖），
// COLD_START_MAX_MS 本地覆盖仅供演示失败路径。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/standardcode.js", import.meta.url));
const MAX_MS = Number(process.env.COLD_START_MAX_MS ?? 400);
const RUNS = 21;
const WARMUP = 3;

function once() {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  const t1 = performance.now();
  if (r.status !== 0 || !r.stdout.includes("standardcode")) {
    throw new Error(`[cold-start] 被测 CLI 未正常输出：exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  }
  return t1 - t0;
}

try {
  for (let i = 0; i < WARMUP; i++) once();

  const times = Array.from({ length: RUNS }, once).sort((a, b) => a - b);
  const median = times[Math.floor(RUNS / 2)];
  const fmt = (ms) => `${ms.toFixed(1)}ms`;
  console.log(`[cold-start] ${RUNS} 次实测（预热 ${WARMUP} 次不计）：中位 ${fmt(median)}，min ${fmt(times[0])}，max ${fmt(times[RUNS - 1])}，阈值 ${MAX_MS}ms`);

  if (median > MAX_MS) {
    console.error(`[cold-start] 超限：中位 ${fmt(median)} > 阈值 ${MAX_MS}ms。发生了什么：CLI 空载冷启动中位数超标；为什么：M0 DoD 目标 ≤400ms；建议动作：排查启动链新增开销，勿放宽阈值（口径调整须走 ADR）。`);
    // WP-12 加固（M0 跑偏②）：不用 process.exit——POSIX 下其跳过 stderr 刷新的异步写有理论截断风险；
    // exitCode 让流自然 flush 后以退出码 2 结束（门禁信号不变，pnpm/Actions 传播链一致）。
    process.exitCode = 2;
  } else {
    process.exitCode = 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
