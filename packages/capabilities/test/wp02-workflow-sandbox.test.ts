// WP-02（M6）workflow vm 沙箱单测：DoD①（`__proto__:null` + `codeGeneration{strings:false,wasm:false}` + 逃逸集：
// 原型链逃逸 / eval / Function 字符串编译 / WASM）、DoD②（Date.now()、Math.random()、无参 new Date() 各一例抛错，
// 理由=break resume 报告 §2.3 L171026）、DoD③（require/process/fs 不可达）、DoD④（九件全局注入齐全）、
// DoD⑥（同步段超时包装）、DoD⑦（子 workflow 内 workflow() 恒 reject）。
//
// 逃逸面实证（2026-09-18 本机探针，见结果页"过程要点"）：直接注入宿主函数时
// `hostFn.constructor("return process")()` **可取到宿主 process**（宿主 realm 的 Function 不受本 context 的
// codeGeneration 约束）→ 故本套件必须覆盖**四条**宿主注入通路：同步返回值、async Promise 本体、
// **同步 throw**、**异步 rejection**（后两条=错误对象的 constructor 同样携带宿主 Function；V 核验 R1 退回项），
// 且两条返回值通路须**各自**有用例（V 核验 R2：只测 async 会让同步 clone 分支零判别力）。
import { runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowContext,
  runWorkflowScript,
  WORKFLOW_CHILD_NESTING_MESSAGE,
  WORKFLOW_GLOBAL_NAMES,
  WORKFLOW_HOOK_MISSING_MESSAGE,
  WORKFLOW_SYNC_TIMEOUT_MS,
  WorkflowSandboxError,
  WorkflowTimeoutError,
  type WorkflowHooks,
  type WorkflowRunOptions,
} from "../src/index.ts";

const META = `export const meta = { name: "wp02-probe", description: "WP-02 沙箱探针" };`;

function script(body: string): string {
  return `${META}\n${body}\n`;
}

function hooks(overrides: Partial<WorkflowHooks> = {}): WorkflowHooks {
  return {
    agent: async (prompt) => `agent:${prompt}`,
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => {
      const out: unknown[] = [];
      for (let index = 0; index < items.length; index++) {
        let value: unknown = items[index];
        for (const stage of stages) value = await (stage as (prev: unknown, item: unknown, i: number) => unknown)(value, items[index], index);
        out.push(value);
      }
      return out;
    },
    log: () => {},
    phase: () => {},
    ...overrides,
  };
}

/** 在沙箱里求值一个表达式，把抛错收成 `{ err, message, leak }`（避免宿主侧 try/catch 掩盖判别力）。
 * `leak` = 在 **context 内**用错误对象的 constructor 链尝试取宿主 process——宿主机注入面（含错误对象）的判别位。 */
async function probe(
  expression: string,
  options: Partial<WorkflowRunOptions> = {},
): Promise<{ ok?: unknown; err?: string; message?: string; leak?: string }> {
  const source = script(
    [
      `try { return { ok: await (${expression}) }; }`,
      `catch (err) {`,
      `  var leak;`,
      `  try { leak = "LEAK:" + String(err.constructor.constructor("return process")()); }`,
      `  catch (guard) { leak = "BLOCKED:" + String(guard && guard.name); }`,
      `  return { err: String(err && err.name), message: String(err && err.message), leak: leak };`,
      `}`,
    ].join("\n"),
  );
  return (await runWorkflowScript({ script: source, hooks: hooks(), ...options })) as {
    ok?: unknown;
    err?: string;
    message?: string;
    leak?: string;
  };
}

describe("DoD① vm context 基座与逃逸面", () => {
  it("sandbox 是 null 原型对象（ORC-023/024 行 295 字面 `__proto__: null` 的落地形）", () => {
    expect(Object.getPrototypeOf(createWorkflowContext())).toBeNull();
  });

  it("逃逸·原型链：({}).constructor.constructor 字符串编译被 codeGeneration 拒绝", async () => {
    const result = await probe(`({}).constructor.constructor("return process")()`);
    expect(result.err).toBe("EvalError");
  });

  it("逃逸·原型链：数组/函数链同样不可取宿主 Function", async () => {
    expect((await probe(`[].constructor.constructor("return process")()`)).err).toBe("EvalError");
    expect((await probe(`(function () {}).constructor("return process")()`)).err).toBe("EvalError");
  });

  it("逃逸·eval 字符串求值被拒", async () => {
    expect((await probe(`eval("1 + 1")`)).err).toBe("EvalError");
  });

  it("逃逸·new Function 字符串编译被拒", async () => {
    expect((await probe(`new Function("return process")()`)).err).toBe("EvalError");
  });

  it("逃逸·WASM 编译被拒（codeGeneration.wasm=false）", async () => {
    const result = await probe(`WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))`);
    expect(`${result.err ?? ""} ${result.message ?? ""}`.toLowerCase()).toContain("wasm");
  });

  it("逃逸·宿主注入面①：钩子函数本体的 constructor 是 context Function（非宿主）", async () => {
    expect((await probe(`agent.constructor("return process")()`)).err).toBe("EvalError");
  });

  it("逃逸·宿主注入面②：宿主 async 钩子回传的 Promise 本体不泄漏宿主 Function", async () => {
    const result = await probe(`agent("x").constructor.constructor("return process")()`);
    expect(result.err).toBe("EvalError");
  });

  it("逃逸·宿主注入面③：钩子返回的宿主对象经克隆落 context realm（原型是 context 的 Object.prototype）", async () => {
    const hostObject = { deep: { value: 7 } };
    const result = await probe(`(async () => { const r = await agent("x"); return Object.getPrototypeOf(r) === Object.prototype; })()`, {
      hooks: hooks({ agent: async () => hostObject }),
    });
    expect(result.ok).toBe(true);
    const escape = await probe(`agent("x").then((r) => r.constructor.constructor("return process")())`, {
      hooks: hooks({ agent: async () => hostObject }),
    });
    expect(escape.err).toBe("EvalError");
  });

  it("逃逸·宿主注入面④：args 宿主对象经克隆落 context realm", async () => {
    const result = await probe(`Object.getPrototypeOf(args) === Object.prototype && args.deep.value`, {
      args: { deep: { value: 7 } },
    });
    expect(result.ok).toBe(7);
    expect((await probe(`args.constructor.constructor("return process")()`, { args: { a: 1 } })).err).toBe("EvalError");
  });

  it("逃逸·函数值不得进入 context（钩子返回函数=明报拒绝，不静默丢弃）", async () => {
    await expect(
      runWorkflowScript({
        script: script(`return await agent("x");`),
        hooks: hooks({ agent: async () => (() => 1) as unknown as string }),
      }),
    ).rejects.toThrow(/不得是函数/);
  });

  it("逃逸·context 内无宿主对象可作原型链跳板（宿主侧注入面全经桥接）", () => {
    const context = createWorkflowContext();
    expect(runInContext(`typeof hostLeak`, context)).toBe("undefined");
  });

  it("逃逸·宿主注入面⑤：**同步**（非 async）钩子返回的宿主对象经克隆落 context realm（V 核验 R2 缺口回归）", async () => {
    const hostObject = { deep: { value: 11 } };
    const syncHooks = hooks({ agent: ((prompt: string) => ({ ...hostObject, prompt })) as unknown as WorkflowHooks["agent"] });
    const realm = await probe(
      `(async () => { const r = agent("x"); return { proto: Object.getPrototypeOf(r) === Object.prototype, value: r.deep.value }; })()`,
      { hooks: syncHooks },
    );
    expect(realm.ok).toEqual({ proto: true, value: 11 });
    expect((await probe(`agent("x").constructor.constructor("return process")()`, { hooks: syncHooks })).err).toBe("EvalError");
  });

  it("逃逸·宿主注入面⑥：同步钩子返回**函数值**同样明报拒绝（非静默）", async () => {
    await expect(
      runWorkflowScript({
        script: script(`return agent("x");`),
        hooks: hooks({ agent: (() => (() => 1)) as unknown as WorkflowHooks["agent"] }),
      }),
    ).rejects.toThrow(/不得是函数/);
  });
});

describe("DoD③ 宿主错误对象不得逃逸（V 核验 R1 修复回归）", () => {
  const hostError = Object.assign(new Error("host sync boom"), { code: "E_HOST" });
  const syncThrowing = hooks({ agent: (() => { throw hostError; }) as unknown as WorkflowHooks["agent"] });
  const asyncThrowing = hooks({ agent: (async () => { throw hostError; }) as unknown as WorkflowHooks["agent"] });

  it("同步抛错：错误在 context 内重建（message/code 保留），constructor 链不可达宿主 Function", async () => {
    const result = await probe(`agent("x")`, { hooks: syncThrowing });
    expect(result.err).toBe("Error");
    expect(result.message).toBe("host sync boom");
    expect(result.leak).toBe("BLOCKED:EvalError");
    const codeEcho = await probe(`(function(){ try { agent("x"); } catch (e) { return String(e.code); } })()`, { hooks: syncThrowing });
    expect(codeEcho.ok).toBe("E_HOST");
  });

  it("async reject：rejection reason 同样归一", async () => {
    const result = await probe(`agent("x")`, { hooks: asyncThrowing });
    expect(result.message).toBe("host sync boom");
    expect(result.leak).toBe("BLOCKED:EvalError");
  });

  it("hooks.workflow 缺位时实现自产的宿主 reject 同样归一", async () => {
    const result = await probe(`workflow("inner")`);
    expect(result.message).toBe(WORKFLOW_HOOK_MISSING_MESSAGE);
    expect(result.leak).toBe("BLOCKED:EvalError");
  });

  it("非 Error 抛出物（字符串）归一为 context Error", async () => {
    const result = await probe(`agent("x")`, {
      hooks: hooks({ agent: (async () => Promise.reject("plain-host-reason")) as unknown as WorkflowHooks["agent"] }),
    });
    expect(result.message).toBe("plain-host-reason");
    expect(result.leak).toBe("BLOCKED:EvalError");
  });

  it("宿主错误缺 message 时回落带 label 的缺省文案（信息不丢且不夹带宿主对象）", async () => {
    const result = await probe(`agent("x")`, {
      hooks: hooks({ agent: (() => { throw { weird: true }; }) as unknown as WorkflowHooks["agent"] }),
    });
    expect(result.message).toBe("workflow hook agent failed");
    expect(result.leak).toBe("BLOCKED:EvalError");
  });
});

describe("DoD② 禁时间/随机源（理由=break resume，A 级报告 §2.3 L171026）", () => {
  it("Date.now() 抛错", async () => {
    const result = await probe(`Date.now()`);
    expect(result.message).toContain("Date.now()");
  });

  it("无参 new Date() 抛错", async () => {
    const result = await probe(`new Date()`);
    expect(result.message).toContain("new Date()");
  });

  it("Math.random() 抛错", async () => {
    const result = await probe(`Math.random()`);
    expect(result.message).toContain("Math.random()");
  });

  it("带参 Date 与 Date.parse/UTC 保留（只禁无参构造与 now）", async () => {
    expect((await probe(`new Date(0).toISOString()`)).ok).toBe("1970-01-01T00:00:00.000Z");
    expect((await probe(`Date.parse("2020-01-01T00:00:00Z")`)).ok).toBe(1_577_836_800_000);
  });

  it("Math 其余成员保留", async () => {
    expect((await probe(`Math.max(1, 2)`)).ok).toBe(2);
  });

  it("delete Date/Math 不回落 realm 原版（configurable:false）", async () => {
    expect((await probe(`delete globalThis.Date`)).ok).toBe(false);
    expect((await probe(`delete globalThis.Math`)).ok).toBe(false);
    expect((await probe(`Date.now()`)).message).toContain("Date.now()");
    expect((await probe(`Math.random()`)).message).toContain("Math.random()");
  });

  it("守卫本体是 context 函数——原型链不可达宿主 Function", async () => {
    expect((await probe(`Date.constructor("return process")()`)).err).toBe("EvalError");
    expect((await probe(`Math.constructor.constructor("return process")()`)).err).toBe("EvalError");
    expect((await probe(`Object.getPrototypeOf(Math) === Object.prototype`)).ok).toBe(true);
  });
});

describe("DoD③ 无 fs / Node API（vm realm 天然隔离）", () => {
  it("require / process / fs / module / Buffer 均不可达", async () => {
    for (const name of ["require", "process", "fs", "module", "Buffer", "global"]) {
      expect((await probe(`typeof ${name}`)).ok).toBe("undefined");
    }
  });

  it("访问即 ReferenceError（非静默 undefined 取值）", async () => {
    expect((await probe(`require("node:fs")`)).err).toBe("ReferenceError");
    expect((await probe(`process.env.PATH`)).err).toBe("ReferenceError");
    expect((await probe(`fs.readFileSync("/etc/passwd", "utf8")`)).err).toBe("ReferenceError");
  });
});

describe("DoD④ 九件全局注入齐全", () => {
  it("九件齐在（逐枚 typeof 核对，缺一即失败）", async () => {
    const summary = (await probe(
      `Object.fromEntries(${JSON.stringify(WORKFLOW_GLOBAL_NAMES)}.map(function (n) { return [n, (n in globalThis) ? typeof globalThis[n] : "MISSING"]; }))`,
      { args: { ok: 1 } },
    )).ok as Record<string, string>;
    expect(Object.keys(summary).sort()).toEqual([...WORKFLOW_GLOBAL_NAMES].sort());
    expect(summary.agent).toBe("function");
    expect(summary.parallel).toBe("function");
    expect(summary.pipeline).toBe("function");
    expect(summary.phase).toBe("function");
    expect(summary.log).toBe("function");
    expect(summary.console).toBe("object");
    expect(summary.budget).toBe("object");
    expect(summary.args).toBe("object");
    expect(summary.workflow).toBe("function");
  });

  it("钩子端到端可用：agent/pipeline/parallel/phase/log/console/budget 全跑通", async () => {
    const log = vi.fn();
    const phase = vi.fn();
    const result = await runWorkflowScript({
      script: script(`
        phase("第一步");
        log("开始");
        console.warn("注意");
        const a = await agent("one", { label: "L1" });
        const p = await pipeline([1, 2], (prev) => prev * 10);
        const q = await parallel([() => Promise.resolve("x"), () => Promise.resolve("y")]);
        return { a, p, q, total: budget.total, remaining: String(budget.remaining()), spent: budget.spent() };
      `),
      hooks: hooks({ log, phase }),
      budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    });
    expect(result).toEqual({
      a: "agent:one",
      p: [10, 20],
      q: ["x", "y"],
      total: null,
      remaining: "Infinity",
      spent: 0,
    });
    expect(phase).toHaveBeenCalledWith("第一步");
    expect(log.mock.calls.map((call) => call[0])).toEqual(["开始", "注意"]);
  });
});

describe("DoD⑥ 同步段求值超时包装", () => {
  it("缺省超时常量已登记为 [自定] 值", () => {
    expect(WORKFLOW_SYNC_TIMEOUT_MS).toBe(5_000);
  });

  it("同步段死循环触发 WorkflowTimeoutError", async () => {
    const failure = await runWorkflowScript({
      script: script(`while (true) {}`),
      hooks: hooks(),
      syncTimeoutMs: 50,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(WorkflowTimeoutError);
    expect(failure).toBeInstanceOf(WorkflowSandboxError);
    expect((failure as Error).message).toContain("syncTimeoutMs=50");
    expect((failure as WorkflowTimeoutError).syncTimeoutMs).toBe(50);
  });

  it("异步段不受 syncTimeoutMs 约束（只包同步段）——120ms 的钩子不被 50ms 超时打断", async () => {
    const result = await runWorkflowScript({
      script: script(`const slow = await agent("slow"); return slow;`),
      hooks: hooks({
        agent: () => new Promise((resolve) => setTimeout(() => resolve("slow-ok"), 120)),
      }),
      syncTimeoutMs: 50,
    });
    expect(result).toBe("slow-ok");
  });
});

describe("DoD⑦ 子 workflow 内 workflow() 恒 reject（一层嵌套硬约束）", () => {
  it("child=true：workflow() 恒 reject，文案逐字同 [CC]（A 级报告 §3.2 L167314）", async () => {
    const outcome = await runWorkflowScript({
      script: script(`try { await workflow("inner"); return "resolved"; } catch (err) { return "rejected:" + err.message; }`),
      hooks: hooks({ workflow: async () => "should-not-be-used" }),
      child: true,
    });
    expect(outcome).toBe(`rejected:${WORKFLOW_CHILD_NESTING_MESSAGE}`);
  });

  it("child=false：workflow() 走 hooks.workflow", async () => {
    const seen: unknown[] = [];
    const outcome = await runWorkflowScript({
      script: script(`return await workflow("inner", { a: 1 });`),
      hooks: hooks({
        workflow: async (name, args) => {
          seen.push(name, args);
          return "child-ok";
        },
      }),
    });
    expect(outcome).toBe("child-ok");
    expect(seen).toEqual(["inner", { a: 1 }]);
  });

  it("父层缺 hooks.workflow 时明报拒绝（不静默返回 undefined）", async () => {
    await expect(
      runWorkflowScript({ script: script(`return await workflow("inner");`), hooks: hooks() }),
    ).rejects.toThrow(WORKFLOW_HOOK_MISSING_MESSAGE);
  });
});

describe("脚本正文求值与 meta 结合", () => {
  it("meta 在正文作用域内可见，且顶层 return 即 workflow 返回值", async () => {
    const result = await runWorkflowScript({
      script: script(`return meta.name + "|" + meta.description;`),
      hooks: hooks(),
    });
    expect(result).toBe("wp02-probe|WP-02 沙箱探针");
  });

  it("meta 非纯字面量时求值前置拒绝（不进入 vm）", async () => {
    await expect(
      runWorkflowScript({ script: `export const meta = { name: SOME_VAR, description: "x" };`, hooks: hooks() }),
    ).rejects.toThrow(/不允许变量引用/);
  });
});
