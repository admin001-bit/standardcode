// F28（2026-09-30 可用性实测）回归：/goal 会话态须跨命令派发存续。
// 缺陷原形：派发点每条命令 createCommandContext 新建 → sessionGoal 即抛即弃，生产路径
// /goal status 恒 none、clear 恒 none、refine 恒 noGoal（wp01 同 ctx 单测族掩蔽此类回归）。
// 判别形制＝走 runRepl 生产派发（WP-08「注入面已验≠生产路径可用」同款教训的机制化）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, LLMRequest, ProviderAdapter } from "@standardcode/providers";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-f28-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stubProvider(): ProviderAdapter {
  return {
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    // 纯命令轮次不触模型；若被调用即测试环境异常。
    // eslint-disable-next-line require-yield
    async *stream(_req: LLMRequest): AsyncIterable<LLMEvent> {
      throw new Error("provider must not be called (command-only turns)");
    },
    countTokens: async () => 0,
  };
}

async function run(lines: string[]): Promise<string> {
  const session = createSession({ provider: stubProvider(), catalog: ["m-a"], model: "m-a", cwd: dir });
  let out = "";
  const io: ReplIo = {
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({ session, io, baseDir: dir });
  return out;
}

describe("F28 /goal 会话态跨派发存续（生产路径）", () => {
  it("set 后 status 查得目标（原形：status 恒 none）", async () => {
    const out = await run(["/goal fix F28 then ship", "/goal status", "/exit"]);
    expect(out).toContain("fix F28 then ship");
    expect(out).not.toContain("no session goal");
  });

  it("clear 真清且输出 cleared（原形：fresh ctx 下 clear 恒 none）", async () => {
    const out = await run(["/goal ship now", "/goal clear", "/goal status", "/exit"]);
    expect(out).toContain("[goal] cleared");
    expect(out).toContain("no session goal");
    expect(out).not.toContain("current: ship now");
  });

  it("转录注入半边不受影响：set 的 <session-goal> 注入轮在转录侧可见", async () => {
    const out = await run(["/goal persistent-goal-marker", "/exit"]);
    expect(out).toContain("[goal] set");
    // 注入消息落 session.messages（共享态）——命令轮不触模型，仅断言 set 回执不抛错。
    expect(out).not.toContain("failed");
  });
});
