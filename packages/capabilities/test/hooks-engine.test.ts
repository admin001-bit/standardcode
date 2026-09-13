// WP-04（M4）hooks 引擎单测：DoD①（五来源合并+总闸+信任门）/②（退出码+JSON 归一+SEC-080）/③（http 三闸）/
// ④（matcher 三态+query 缺失语义陷阱 :261743）/⑥（RANK 只升不降+decisionReason）/⑦（timeout 秒覆盖+缺省 600000）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHookEngine, HOOK_EVENT_DEFAULT_TIMEOUT_MS, HOOK_EVENTS, hookQueryFor, loadHookConfigs, matchHookMatcher, type HookEventName } from "../src/index.ts";

let root: string;
let fixturePath: string;
let markFile: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-hooks-"));
  fixturePath = path.join(root, "hook-fixture.mjs");
  markFile = path.join(root, "marks.txt");
  writeFileSync(
    fixturePath,
    `import { appendFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const a = process.argv[2] ?? "ok";
  if (a === "approve") { console.log(JSON.stringify({ decision: "approve" })); process.exit(0); }
  if (a === "deny") { console.log(JSON.stringify({ decision: "block", reason: "no-way" })); process.exit(0); }
  if (a === "pd_allow") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })); process.exit(0); }
  if (a === "pd_deny") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } })); process.exit(0); }
  if (a === "pd_ask") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } })); process.exit(0); }
  if (a === "pd_defer") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "defer" } })); process.exit(0); }
  if (a === "pd_bad") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "yolo" } })); process.exit(0); }
  if (a === "plain") { console.log("just text"); process.exit(0); }
  if (a === "badjson") { console.log("{not-json"); process.exit(0); }
  if (a === "exit2") { process.stderr.write("blocked-by-hook"); process.exit(2); }
  if (a === "fail3") { process.exit(3); }
  if (a === "env") { console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: process.env[process.argv[3]] === undefined ? "allow" : "deny" } })); process.exit(0); }
  if (a === "sleep") { setTimeout(() => process.exit(0), Number(process.argv[3] ?? 5000)); return; }
  if (a === "mark") { appendFileSync(process.argv[3], (process.argv[4] ?? "x") + "\\n"); process.exit(0); }
  process.exit(0);
});
`,
    "utf8",
  );
});
afterAll(() => {
  // Windows：超时测试的孤儿孙进程可持 fixture 句柄数秒——rm EPERM 容错（泄漏可接受，OS 随 tmp 清理；wp02 形制）
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
  } catch {
    /* 泄漏可接受 */
  }
});

const cmd = (action: string, timeout?: number, extraArgs: string[] = []): { type: "command"; command: string; timeout?: number } => ({
  type: "command",
  command: `node "${fixturePath}"${action !== "ok" ? ` ${action}` : ""}${extraArgs.map((a) => ` "${a}"`).join("")}`,
  ...(timeout !== undefined ? { timeout } : {}),
});

function engineFor(event: HookEventName, hooks: unknown[], over: Record<string, unknown> = {}, trusted: boolean | (() => boolean) = true) {
  const config = loadHookConfigs({ user: { hooks: { [event]: hooks }, ...over } });
  return createHookEngine(config, { trusted, cwd: root });
}

describe("DoD① 配置装载（五来源合并+总闸+信任门）", () => {
  it("HOOK_EVENTS 恰 13 事件（§9.3 附注清单）", () => {
    expect(HOOK_EVENTS).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "SubagentStop", "SubagentStart", "PreCompact", "PostCompact", "SessionStart", "SessionEnd", "PermissionRequest", "Notification"]);
  });

  it("managed 组先于 user 组执行（最高优先；decisionReason.hookSource=managed）", async () => {
    const config = loadHookConfigs({
      managed: { hooks: { Stop: [{ hooks: [cmd("pd_allow")] }] } },
      user: { hooks: { Stop: [{ hooks: [cmd("pd_allow")] }] } },
    });
    const e = createHookEngine(config, { trusted: true, cwd: root });
    const o = await e.fire("Stop", { payload: {} });
    expect(o.verdict).toBe("allow");
    expect(o.decisionReason?.hookSource).toBe("managed");
  });

  it("disableAllHooks=true 总闸（skippedReason）；坏件告警继续", async () => {
    const config = loadHookConfigs({ user: { disableAllHooks: true, hooks: { Stop: [{ hooks: [cmd("ok")] }, "garbage"] } } });
    expect(config.disableAllHooks).toBe(true);
    expect(config.warnings.some((w) => w.includes("not an object"))).toBe(true);
    const e = createHookEngine(config, { trusted: true, cwd: root });
    const o = await e.fire("Stop", { payload: {} });
    expect(o.skippedReason).toContain("disableAllHooks");
  });

  it("信任未确认→跳全部（:262013 逐字形状）", async () => {
    const e = engineFor("PreToolUse", [{ hooks: [cmd("ok")] }], {}, false);
    const o = await e.fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.skippedReason).toBe("Skipping PreToolUse hook execution - workspace trust not accepted");
    expect(o.verdict).toBeNull();
  });
});

describe("DoD④ matcher 三态+query 缺失语义陷阱（:261743）", () => {
  it("* /缺席=全配；| , 列表=逐项；正则；非法正则=告警+false", () => {
    const w: string[] = [];
    expect(matchHookMatcher(undefined, "Bash", w)).toBe(true);
    expect(matchHookMatcher("*", "Bash", w)).toBe(true);
    expect(matchHookMatcher("Bash|Edit", "Edit", w)).toBe(true);
    expect(matchHookMatcher("Bash,Edit", "Read", w)).toBe(false);
    expect(matchHookMatcher("^Ba.*", "Bash", w)).toBe(true);
    expect(matchHookMatcher("[", "Bash", w)).toBe(false);
    expect(w.some((x) => x.includes("invalid hook matcher regex"))).toBe(true);
  });

  it("query 映射（vBr）：工具事件=tool_name；SubagentStart/Stop=agent_type；SessionStart=source；SessionEnd=reason；其余无 query", () => {
    expect(hookQueryFor("PreToolUse", { toolName: "Bash" })).toBe("Bash");
    expect(hookQueryFor("SubagentStop", { agentType: "Explore" })).toBe("Explore");
    expect(hookQueryFor("SessionStart", { source: "startup" })).toBe("startup");
    expect(hookQueryFor("SessionEnd", { reason: "exit" })).toBe("exit");
    expect(hookQueryFor("Stop", {})).toBeUndefined();
    expect(hookQueryFor("PreCompact", {})).toBeUndefined();
  });

  it("语义陷阱：Stop（无 query）配非 * matcher 照样全执行（matcher 被忽略，:261743）", async () => {
    const e = engineFor("Stop", [{ matcher: "Bash", hooks: [cmd("pd_deny")] }]);
    const o = await e.fire("Stop", { payload: {} });
    expect(o.verdict).toBe("deny");
  });

  it("PreToolUse matcher 过滤：不匹配的组不执行", async () => {
    const e = engineFor("PreToolUse", [{ matcher: "Edit", hooks: [cmd("pd_deny")] }]);
    const o = await e.fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.verdict).toBeNull();
  });
});

describe("DoD② 退出码/JSON 协议+SEC-080（command 真跑）", () => {
  it("exit0+decision approve/block 归一；block reason→blockingError", async () => {
    const allow = await engineFor("Stop", [{ hooks: [cmd("approve")] }]).fire("Stop", { payload: {} });
    expect(allow.verdict).toBe("allow");
    const deny = await engineFor("Stop", [{ hooks: [cmd("deny")] }]).fire("Stop", { payload: {} });
    expect(deny.verdict).toBe("deny");
    expect(deny.blockingError).toBe("no-way");
  });

  it("exit0 纯文本=无决定（:260353）；坏 JSON=non_blocking 带 schema 说明（:260365 形状）", async () => {
    const plain = await engineFor("Stop", [{ hooks: [cmd("plain")] }]).fire("Stop", { payload: {} });
    expect(plain.verdict).toBeNull();
    const bad = await engineFor("Stop", [{ hooks: [cmd("badjson")] }]).fire("Stop", { payload: {} });
    expect(bad.verdict).toBeNull();
    expect(bad.nonBlockingErrors.some((x) => x.includes("permissionDecision"))).toBe(true);
  });

  it("permissionDecision 四值：defer→ask（[自定]）；非法值→告警带 schema", async () => {
    expect((await engineFor("PreToolUse", [{ hooks: [cmd("pd_ask")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} })).verdict).toBe("ask");
    expect((await engineFor("PreToolUse", [{ hooks: [cmd("pd_defer")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} })).verdict).toBe("ask");
    const bad = await engineFor("PreToolUse", [{ hooks: [cmd("pd_bad")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(bad.verdict).toBeNull();
    expect(bad.nonBlockingErrors.join()).toContain('"allow", "deny", "ask", "defer"');
  });

  it("exit2=blocking：deny+blockingError=stderr（:260403 形状）", async () => {
    const o = await engineFor("PreToolUse", [{ hooks: [cmd("exit2")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.verdict).toBe("deny");
    expect(o.blockingError).toBe("blocked-by-hook");
    expect(o.decisionReason?.reason).toBe("blocked-by-hook");
  });

  it("其他非零=non_blocking_error 告警继续（无决定）", async () => {
    const o = await engineFor("Stop", [{ hooks: [cmd("fail3")] }]).fire("Stop", { payload: {} });
    expect(o.verdict).toBeNull();
    expect(o.nonBlockingErrors.join()).toContain("exited with code 3");
  });

  it("SEC-080 接缝⑬：hook 子进程 env 过清洗（密钥剔除、PATH 在位）", async () => {
    process.env.SC_HOOK_PROBE_KEY = "x";
    const stripped = await engineFor("PreToolUse", [{ hooks: [cmd("env", undefined, ["SC_HOOK_PROBE_KEY"])] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(stripped.verdict).toBe("allow"); // 密钥被清洗→fixture 读不到→allow
    const kept = await engineFor("PreToolUse", [{ hooks: [cmd("env", undefined, ["PATH"])] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(kept.verdict).toBe("deny"); // PATH 在位（白名单）→fixture 读到→deny
    delete process.env.SC_HOOK_PROBE_KEY;
  });
});

describe("DoD⑦ 超时（缺省 600000；每 hook 秒覆盖）+fail-closed", () => {
  it("HOOK_EVENT_DEFAULT_TIMEOUT_MS=600000（[CC] Rs :62011）", () => {
    expect(HOOK_EVENT_DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it("PreToolUse 超时=deny fail-closed（:61919 文案形状）；allow 不能洗白", async () => {
    const e = engineFor("PreToolUse", [{ hooks: [cmd("sleep", 1, ["3000"]), cmd("approve")] }]);
    const o = await e.fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.verdict).toBe("deny");
    expect(o.decisionReason?.reason).toContain("did not respond before its timeout");
    expect(o.decisionReason?.reason).toContain("fail-closed");
  });

  it("非门事件（Stop）超时=non_blocking 告警继续（[自定]）", async () => {
    const o = await engineFor("Stop", [{ hooks: [cmd("sleep", 1, ["3000"])] }]).fire("Stop", { payload: {} });
    expect(o.verdict).toBeNull();
    expect(o.nonBlockingErrors.join()).toContain("timed out");
  });
});

describe("DoD③ http 型（白名单+maxRedirects:0+SessionStart 禁用）", () => {
  function httpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ url: string; close: () => Promise<void>; bodies: string[] }> {
    const bodies: string[] = [];
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString()));
        req.on("end", () => {
          bodies.push(b);
          handler(req, res, b);
        });
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${addr.port}/hook`, close: () => new Promise((r) => srv.close(() => r())), bodies });
      });
    });
  }

  it("白名单内 POST JSON+2xx JSON 决定消费", async () => {
    const srv = await httpServer((req, res) => {
      expect(req.method).toBe("POST");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }));
    });
    try {
      const e = engineFor("Stop", [{ hooks: [{ type: "http", url: srv.url }] }], { allowedHttpHookUrls: [srv.url] });
      const o = await e.fire("Stop", { payload: { stop_hook_cli: true } });
      expect(o.verdict).toBe("deny");
      expect(JSON.parse(srv.bodies[0]).stop_hook_cli).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("白名单外拒绝（fail-closed）", async () => {
    const e = engineFor("Stop", [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/hook" }] }]);
    const o = await e.fire("Stop", { payload: {} });
    expect(o.verdict).toBeNull();
    expect(o.nonBlockingErrors.join()).toContain("allowedHttpHookUrls");
  });

  it("3xx 重定向=拒绝（maxRedirects:0，:259195 形状）", async () => {
    const srv = await httpServer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example" });
      res.end();
    });
    try {
      const e = engineFor("Stop", [{ hooks: [{ type: "http", url: srv.url }] }], { allowedHttpHookUrls: [srv.url] });
      const o = await e.fire("Stop", { payload: {} });
      expect(o.verdict).toBeNull();
      expect(o.nonBlockingErrors.join()).toContain("maxRedirects: 0");
    } finally {
      await srv.close();
    }
  });

  it("SessionStart 禁用 http（:261879 逐字形状）", async () => {
    const e = engineFor("SessionStart", [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/hook" }] }], { allowedHttpHookUrls: ["http://127.0.0.1:1/hook"] });
    const o = await e.fire("SessionStart", { payload: {} });
    expect(o.verdict).toBeNull();
    expect(o.nonBlockingErrors.join()).toContain("HTTP hooks are not supported for SessionStart");
  });
});

describe("DoD⑥ 聚合 RANK 只升不降+decisionReason 结构化", () => {
  it("先 deny 后 allow 不能洗白（deny 恒赢）", async () => {
    const o = await engineFor("PreToolUse", [{ hooks: [cmd("exit2"), cmd("approve")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.verdict).toBe("deny");
    expect(o.blockingError).toBe("blocked-by-hook");
  });

  it("ask(2) > allow(1)：ask+approve=ask；deny(3) > ask(2)：deny+ask=deny", async () => {
    const a = await engineFor("PreToolUse", [{ hooks: [cmd("pd_ask"), cmd("approve")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(a.verdict).toBe("ask");
    const d = await engineFor("PreToolUse", [{ hooks: [cmd("exit2"), cmd("pd_ask")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(d.verdict).toBe("deny");
  });

  it("decisionReason 结构化（type/hookName/hookSource/reason，:61769 形状）", async () => {
    const o = await engineFor("PreToolUse", [{ hooks: [cmd("deny")] }]).fire("PreToolUse", { query: { toolName: "Bash" }, payload: {} });
    expect(o.decisionReason).toEqual({ type: "hook", hookName: `node "${fixturePath}" deny`, hookSource: "user", reason: "no-way" });
  });
});

describe("stdin 负载与 mark 面（集成消费前置）", () => {
  it("command hook 真跑：mark 文件按序追加（多 hook 顺序执行）", async () => {
    const e = engineFor("Stop", [{ hooks: [cmd("mark", undefined, [markFile, "a"]), cmd("mark", undefined, [markFile, "b"])] }]);
    await e.fire("Stop", { payload: {} });
    expect(readFileSync(markFile, "utf8")).toBe("a\nb\n");
  });
});
