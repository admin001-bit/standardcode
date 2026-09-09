// WP-07（M2）确认 UI 最小流+信任对话框测试（UI-061/§8.3 持久化；判据自足：板 WP-07 DoD①②③）。
// 集成形态：真实 repl（工具执行体）+注入式 confirm 桩——ask 触发面=default 模式 Bash。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMEvent, ProviderAdapter } from "@standardcode/providers";
import { acceptTrust } from "@standardcode/platform";
import { createSession } from "../src/session.ts";
import { runRepl, type ReplIo } from "../src/repl.ts";
import { alwaysAllowRuleFor, parseConfirmAnswer, parseTrustAnswer, trustQuestion } from "../src/confirm.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-confirm-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 每例独立 home（local 落盘/信任 store 随之，防交叉污染）。 */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "stdcode-confirm-home-"));
}

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
}

function echoProvider(): ProviderAdapter {
  let n = 0;
  return {
    // reactive 装配（WP-05）在 turn 构造期读窗口（repl.ts modelWindow）——桩给真实形状 caps
    capabilities: () => ({ contextWindow: 200_000, maxOutputTokens: { default: 8192, upper: 8192 }, thinking: "none", input: ["text"], streaming: true, toolCalling: true, cache: { ttlLevels: ["5m"], explicitBreakpoints: false } }),
    countTokens: async () => 0,
    async *stream() {
      n++;
      if (n === 1) {
        yield { type: "tool_start", id: "t1", name: "Bash" } as LLMEvent;
        yield { type: "tool_input_delta", id: "t1", jsonPartial: JSON.stringify({ command: "echo confirm-marker" }) } as LLMEvent;
        yield { type: "tool_end", id: "t1" } as LLMEvent;
      }
      yield { type: "text_delta", text: n === 1 ? "" : "done" } as LLMEvent;
      yield { type: "finish", reason: "completed", raw: "end_turn" } as LLMEvent;
    },
  };
}

async function runReplWith(repo: string, home: string, answers: string[]): Promise<{ out: string; localFile: string }> {
  const session = createSession({ provider: echoProvider(), catalog: ["m-a"], model: "m-a", cwd: repo, home });
  let out = "";
  let ai = 0;
  const io: ReplIo = {
    lines: (async function* () {
      yield "run the marker command";
      yield "/exit";
    })(),
    write: (s) => (out += s),
    close: () => {},
  };
  await runRepl({
    session,
    io,
    confirm: {
      async confirm() {
        return parseConfirmAnswer(answers[ai++] ?? "n");
      },
    },
  });
  return { out, localFile: join(repo, ".standardcode", "settings.local.json") }; // 规格路径=项目 local 层
}

describe("DoD①/② 确认流（ask → y/a/n；总是允许落 local 层）", () => {
  it("n=拒绝（工具不执行）；y=本次允许（工具执行）；两者均不落盘", async () => {
    const homeN = freshHome();
    const repoN = join(dir, "repoN");
    mkdirSync(repoN);
    gitInit(repoN);
    const rN = await runReplWith(repoN, homeN, ["n"]);
    expect(rN.out).toContain("✗"); // 拒绝 → error tool_result（fail-closed 保持）
    expect(existsSync(rN.localFile)).toBe(false); // 拒绝不落盘

    const homeY = freshHome();
    const repoY = join(dir, "repoY");
    mkdirSync(repoY);
    gitInit(repoY);
    const rY = await runReplWith(repoY, homeY, ["y"]);
    expect(rY.out).toContain("✓"); // 本次允许=真实执行成功
    expect(existsSync(rY.localFile)).toBe(false); // once 不落盘
  });

  it("a=总是允许：工具执行+settings.local.json 落盘（ADR-0037 格式）+新会话经 settings 装配即生效", async () => {
    const homeA = freshHome();
    const repo = join(dir, "repoA");
    mkdirSync(repo);
    gitInit(repo);
    const r = await runReplWith(repo, homeA, ["a"]);
    expect(r.out).toContain("✓"); // 执行
    const doc = JSON.parse(readFileSync(r.localFile, "utf8"));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.permissions.allow).toContain("Bash(echo *)");
    // 新 session（经 settings 五来源装载 local 层）→ 无需再确认
    const s2 = createSession({ provider: echoProvider(), catalog: ["m-a"], model: "m-a", cwd: repo, home: homeA });
    expect(s2.broker.evaluate("Bash", { command: "echo anything" }).decision).toBe("allow");
  });

  it("alwaysAllowRuleFor 构造口径：Bash=首词前缀通配；路径工具=字面路径", () => {
    expect(alwaysAllowRuleFor("Bash", { command: "echo hi" })).toBe("Bash(echo *)");
    expect(alwaysAllowRuleFor("Write", { file_path: "a\\b.txt" })).toBe("Write(a/b.txt)");
    expect(alwaysAllowRuleFor("WebFetch", { url: "https://x" })).toBe("WebFetch");
  });
});

describe("DoD② 仓库共享设置未信任不生效（session 装配级）", () => {
  it("共享层 allow 未信任不进 broker；deny/ask 进；local 未跟踪 allow 进；接受信任后生效；env.* 注入经门控（R-env）", () => {
    const homeC = freshHome();
    const repo = join(dir, "repoC");
    const std = join(repo, ".standardcode");
    mkdirSync(std, { recursive: true });
    writeFileSync(join(std, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git push *)"], deny: ["Bash(rm -rf *)"] }, "env.TRUST_SEED": "seeded" }), "utf8");
    writeFileSync(join(std, "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(echo *)"] } }), "utf8");
    gitInit(repo);
    const session = createSession({ provider: echoProvider(), catalog: ["m-a"], model: "m-a", cwd: repo, home: homeC });
    expect(session.trust.trusted).toBe(false);
    expect(session.broker.evaluate("Bash", { command: "git push origin x" }).decision).toBe("ask"); // 共享 allow 被门控
    expect(session.broker.evaluate("Bash", { command: "rm -rf x" }).decision).toBe("deny"); // deny 立即生效
    expect(session.broker.evaluate("Bash", { command: "echo hi" }).decision).toBe("allow"); // local 免信任保留
    expect(session.env.TRUST_SEED).toBeUndefined(); // R-env：未信任共享层 env.* 不注入（V 退回面）
    expect(session.trust.withheld.some((w) => w.key === "env.TRUST_SEED")).toBe(true);
    // 接受信任（store 随 home 覆写）→ 重开 session 共享 allow 与 env.* 全生效
    acceptTrust(repo, { accepted: {} }, join(homeC, ".standardcode", "trust.json"));
    const s2 = createSession({ provider: echoProvider(), catalog: ["m-a"], model: "m-a", cwd: repo, home: homeC });
    expect(s2.trust.trusted).toBe(true);
    expect(s2.broker.evaluate("Bash", { command: "git push origin x" }).decision).toBe("allow");
    expect(s2.env.TRUST_SEED).toBe("seeded");
  });
});

describe("信任对话框（UI-061 语义面）", () => {
  it("问句含仓库根密钥表述+symlink 旗标行；解析 y/N；DENY 桩恒 false（另模块导出面核验）", () => {
    const q = trustQuestion("D:\\w", "D:\\w", true);
    expect(q).toContain("repository root D:\\w");
    expect(q).toContain("symlink");
    expect(parseTrustAnswer("y")).toBe(true);
    expect(parseTrustAnswer("N")).toBe(false);
    expect(parseTrustAnswer("")).toBe(false); // 信任缺省 No（高风险确认，区别于工具确认回车=y）
  });
});
