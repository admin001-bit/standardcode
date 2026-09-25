// M8-WP-04（测试面补强；M7 遗留 #7/#6）：
//  ①#7 teams 关侧拦截块判别力——原判据缺口＝"删块后走 registry 缺席分支、副作用同形"（0 红针）。
//    补法＝合成"registry 含同名 btw 件"的探针：**门关时侧信道名不得经 registry 派发**（拦截块存在性的
//    可判别断言——删块即落到 registry → 合成件被执行 → 本组必红）；门开时旁路派发优先（合成件仍不执行）。
//  ②#6 isInterrupted 装配面守卫——main.ts 三处接线的源码级在位断言（M7 回归原形："未注入=生产恒不中断"）。
//    真 Ctrl+C/TTY 端到端仍属未覆盖面（登记于结果页，卡 DoD② 允许）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExperimentalGate } from "@standardcode/platform";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import type { SlashCommand } from "../src/commands.ts";
import { gatedRegistry } from "../src/experimental-gate.ts";
import { runRepl } from "../src/repl.ts";
import { createSession, type Session } from "../src/session.ts";
import { tmpdir } from "node:os";

const closed: ExperimentalGate = { enabled: false, flags: [], notices: [] };
const teamsOpen: ExperimentalGate = { enabled: true, flags: ["teams"], notices: [] };

const projDir = path.join(tmpdir(), "sc-m8wp04-probe");

function fakeProvider(): ProviderAdapter {
  return {
    capabilities: () => ({
      contextWindow: 1,
      maxOutputTokens: { default: 1, upper: 1 },
      thinking: "none",
      input: ["text"],
      streaming: true,
      toolCalling: true,
      cache: { ttlLevels: ["5m"], explicitBreakpoints: false },
    }),
    async *stream(_req: LLMRequest): AsyncIterable<LLMEvent> {
      for (const ev of [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "completed", raw: "end_turn" },
      ] as LLMEvent[]) yield ev;
    },
    countTokens: async () => 0,
  };
}

/** 计数 provider：判"旁路派发是否真的发生"（文案对拦截块零判别力）。 */
function countingSession(): { s: Session; streams: () => number } {
  const box = { n: 0 };
  const base = fakeProvider();
  const s = createSession({
    provider: {
      ...base,
      async *stream(req: LLMRequest): AsyncIterable<LLMEvent> {
        box.n++;
        yield* base.stream(req);
      },
    },
    catalog: ["m"],
    model: "m",
    cwd: projDir,
    projectRoot: projDir,
    home: projDir,
  });
  return { s, streams: () => box.n };
}

/** 合成"registry 里被误注册的侧信道同名件"：拦截块在位则永不执行；块被删则被执行。 */
function syntheticBtw(): { cmd: SlashCommand; calls: () => number } {
  const box = { n: 0 };
  return {
    cmd: {
      name: "btw",
      description: "M8-WP-04 判别探针：registry 里的同名侧信道件（生产不得存在）",
      execute: async () => {
        box.n++;
      },
    } as SlashCommand,
    calls: () => box.n,
  };
}

async function drive(gate: ExperimentalGate, commands: readonly SlashCommand[]): Promise<string> {
  const out: string[] = [];
  const { s } = countingSession();
  await runRepl({
    session: s,
    commands,
    io: {
      lines: (async function* () {
        yield "/btw probe-payload";
      })(),
      write: (x: string) => out.push(x),
      close: () => {},
    },
    experimentalGate: gate,
    baseDir: path.join(projDir, "repl-store-" + Math.random().toString(36).slice(2)),
  });
  return out.join("");
}

describe("M8-WP-04 ①：teams 关侧拦截块判别力（#7；合成同名 registry 件探针）", () => {
  it("门关：registry 含同名件时仍不得经 registry 派发（删拦截块→合成件被执行→本例必红）", async () => {
    const probe = syntheticBtw();
    const text = await drive(closed, [...gatedRegistry(closed), probe.cmd]);
    expect(probe.calls(), "门关时侧信道名不得落到 registry 派发（拦截块在岗判据）").toBe(0);
    expect(text, "拒绝面语义：与 registry 缺席同形（mini-ADR-0049）").toMatch(/unknown[\s\S]{0,40}btw/i);
  });

  it("门开：旁路派发优先于 registry（合成件仍不执行；provider 恰 1 次）", async () => {
    const probe = syntheticBtw();
    const { s, streams } = countingSession();
    const out: string[] = [];
    await runRepl({
      session: s,
      commands: [...gatedRegistry(teamsOpen), probe.cmd],
      io: {
        lines: (async function* () {
          yield "/btw probe-payload";
        })(),
        write: (x: string) => out.push(x),
        close: () => {},
      },
      experimentalGate: teamsOpen,
      baseDir: path.join(projDir, "repl-store-" + Math.random().toString(36).slice(2)),
    });
    expect(probe.calls(), "侧信道旁路先于 registry 查找").toBe(0);
    expect(streams(), "旁路单问真实发生（provider 恰 1 次）").toBe(1);
  });
});

describe("M8-WP-04 ②：isInterrupted 装配面守卫（#6；main.ts 三处接线在位）", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("接线①：runRepl deps 注入 isInterrupted（M7 回归原形=未注入）", () => {
    expect(src, "main.ts 必须把中断判据注入 runRepl deps").toMatch(/isInterrupted\s*:/);
  });

  it("接线②：SIGINT 处理器置起中断标志", () => {
    expect(src, "SIGINT 处理器须置起 /loop·/batch 中断标志").toMatch(/SIGINT[\s\S]{0,400}?interrupted\s*=\s*true/);
  });

  it("接线③：逐行输入生成器重置标志（中断作用域=单条命令，不跨行残留）", () => {
    expect(src, "io.lines 包装须逐行重置中断标志").toMatch(/lines\s*:[\s\S]{0,400}?interrupted\s*=\s*false/);
  });
});
