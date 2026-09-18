// M6-WP-02：workflow 脚本 vm 沙箱（DoD① 直接载体）。
//
// 规格：ORC-023/024（v2.8 行 295 原文"workflow 脚本 vm 沙箱（`__proto__:null` + 禁 `Date.now/Math.random`）+ journal 续跑 +
// budget 硬顶"）+ ADR-014 行 557 `[已定]` + §12.5 接缝⑰（vm 沙箱 × resume 缓存：禁时间/随机源是 journal key 稳定与
// 缓存命中的**前提**，非独立洁癖）。逐字参考 A 级 `claude-code-workflow.md` §2.3（L171026 沙箱限制原文）、
// §3.2（vm context 构建逐字 L167312-167370、主 workflow 求值超时包装 L170401/L172230）。
//
// 边界（卡）：不做编排执行语义（agent() 真派生 / parallel() / pipeline() 真实现=WP-03）；不做 journal（WP-04）；
// **不复用 M5 Rust 沙箱**（sandbox-backend=L4 进程隔离，与 vm 脚本求值不同层，不混用）。
//
// 逃逸面与对策（本机探针实证 2026-09-18，记录见结果页"过程要点"）：
//   ① `codeGeneration {strings:false, wasm:false}` 封死 eval / new Function / `({}).constructor.constructor` / WASM 编译；
//   ② **宿主注入面是真实缺口**——直接注入宿主函数时 `hostFn.constructor("return process")()` 取到宿主 process
//      （宿主 realm 的 Function 不受本 context 的 codeGeneration 约束，探针实证返回 `[object process]`）。
//      故全部宿主钩子 MUST 经 **context 内桥接器**包裹、全部宿主数据 MUST 经 **context 内 JSON 克隆**，
//      使脚本侧 `x.constructor` 恒为 context realm 的 Function（→ EvalError）。
//   ③ Date/Math 守卫 MUST 在 context 内定义且 configurable:false（宿主侧定义会经 `.constructor` 泄漏宿主 Function；
//      configurable:true 则 `delete Date` 会回落 realm 原版）。探针实证：delete 返回 false、守卫仍生效。
//
// [自定] 口径（供 V 核验）：
//   ① 脚本正文包 `(async () => { ... })()`——[CC] 描述"script body runs in an async context — use await directly"
//      而 vm 的 script 不允许顶层 await，故必须包装；这也让正文顶层 `return` 成为 workflow 返回值。
//   ② `syncTimeoutMs` 缺省 5_000——vm `runInContext` 的 timeout 只约束**同步段**（到首个 await 为止）；
//      异步段由后续卡（budget/abort）承载，不在此卡。
//   ③ 注入面=DoD④ 逐字九件（agent/parallel/pipeline/phase/log/console/budget/args/workflow），
//      **不注入 timers**（[CC] §3.2 子 context 含 setTimeout/clearTimeout，但 DoD④ 未列且宿主 timer 句柄回传
//      会新增逃逸面）→ 登记为对 [CC] 的偏差，留 WP-03 评估。

import { createContext, runInContext, type Context } from "node:vm";
import { parseWorkflowMeta } from "./meta.ts";

/** [自定]②：脚本同步段求值超时（ms）。 */
export const WORKFLOW_SYNC_TIMEOUT_MS = 5_000;

/** DoD④ 九件注入面（顺序即登记顺序，供测试逐枚核对）。 */
export const WORKFLOW_GLOBAL_NAMES = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "console",
  "budget",
  "args",
  "workflow",
] as const;

export type WorkflowGlobalName = (typeof WORKFLOW_GLOBAL_NAMES)[number];

/** [CC] 逐字文案（A 级报告 §3.2 L167314 子 workflow 的 workflow() 占位）——DoD⑦。 */
export const WORKFLOW_CHILD_NESTING_MESSAGE =
  "workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.";

/** A 级报告 §2.3 L171026 原文理由：禁项会 break resume（resume 缓存按 (prompt, opts) 命中）。 */
export const WORKFLOW_DATE_BANNED_MESSAGE =
  "workflow sandbox: Date.now() / argless new Date() 被禁——会破坏 resume 缓存命中（A 级报告 §2.3 L171026）；时间戳请经 args 传入";

export const WORKFLOW_RANDOM_BANNED_MESSAGE =
  "workflow sandbox: Math.random() 被禁——会破坏 resume 缓存命中（A 级报告 §2.3 L171026）";

/** hooks.workflow 缺位时的缺省（父层 workflow() 真实现=WP-03）。 */
export const WORKFLOW_HOOK_MISSING_MESSAGE =
  "workflow sandbox: workflow() 需要 hooks.workflow（编排内核=WP-03 提供；本卡只做沙箱与注入面）";

export const WORKFLOW_SCRIPT_FILENAME = "workflow-script.js";

export class WorkflowSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSandboxError";
  }
}

export class WorkflowTimeoutError extends WorkflowSandboxError {
  constructor(
    readonly syncTimeoutMs: number,
    readonly filename: string,
  ) {
    super(`workflow sandbox: 脚本同步段求值超过 syncTimeoutMs=${syncTimeoutMs}ms（${filename}）`);
    this.name = "WorkflowTimeoutError";
  }
}

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  effort?: string;
  isolation?: "worktree";
  agentType?: string;
}

export type WorkflowPipelineStage = (prev: unknown, item: unknown, index: number) => unknown;

/** 父层注入的编排内核接口（本卡只做注入与守卫；真实现=WP-03）。 */
export interface WorkflowHooks {
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<unknown>;
  parallel(thunks: ReadonlyArray<() => Promise<unknown>>): Promise<unknown[]>;
  pipeline(items: readonly unknown[], ...stages: WorkflowPipelineStage[]): Promise<unknown[]>;
  log?(message: string): void;
  phase?(title: string): void;
  workflow?(nameOrRef: string, args?: unknown): Promise<unknown>;
}

/** budget 形状同 [CC]（A 级报告 §2.2：`{total: number|null, spent(): number, remaining(): number}`）。 */
export interface WorkflowBudget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowRunOptions {
  /** 脚本文本（MUST 以 `export const meta = {...}` 纯字面量开头）。 */
  script: string;
  hooks: WorkflowHooks;
  /** 工具调用传入的 args（真 JSON 值）；进 context 前经 JSON 克隆。 */
  args?: unknown;
  budget?: WorkflowBudget;
  /** [自定]②：缺省 WORKFLOW_SYNC_TIMEOUT_MS。 */
  syncTimeoutMs?: number;
  /** true=子 workflow 上下文：`workflow()` 恒 reject（DoD⑦，一层嵌套硬约束）。 */
  child?: boolean;
  filename?: string;
}

const DEFAULT_BUDGET: WorkflowBudget = { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY };

function preludeSource(): string {
  return `(function () {
  "use strict";
  var DATE_MSG = ${JSON.stringify(WORKFLOW_DATE_BANNED_MESSAGE)};
  var RANDOM_MSG = ${JSON.stringify(WORKFLOW_RANDOM_BANNED_MESSAGE)};
  var RealDate = Date;
  function GuardedDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) throw new Error(DATE_MSG);
    if (args.length === 0) throw new Error(DATE_MSG);
    return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
  }
  GuardedDate.now = function () { throw new Error(DATE_MSG); };
  GuardedDate.parse = RealDate.parse;
  GuardedDate.UTC = RealDate.UTC;
  GuardedDate.prototype = RealDate.prototype;
  Object.defineProperty(globalThis, "Date", {
    value: GuardedDate, writable: false, enumerable: false, configurable: false,
  });
  var guardedMath = {};
  Object.getOwnPropertyNames(Math).forEach(function (key) {
    if (key === "random") return;
    Object.defineProperty(guardedMath, key, Object.getOwnPropertyDescriptor(Math, key));
  });
  Object.defineProperty(guardedMath, "random", {
    value: function () { throw new Error(RANDOM_MSG); },
    writable: false, enumerable: false, configurable: false,
  });
  Object.defineProperty(globalThis, "Math", {
    value: guardedMath, writable: false, enumerable: false, configurable: false,
  });
})()`;
}

/** context 内 JSON 克隆：宿主数据落进 context realm，切断 `value.constructor` → 宿主 Function 的通路。
 * 函数值一律拒绝（宿主可执行对象不得进入 context；静默丢弃=旁路，明报见 DoD③ 同族纪律）。 */
const CLONE_FACTORY_SOURCE = `(function () {
  "use strict";
  return function cloneWorkflowData(value) {
    var kind = typeof value;
    if (value === null || (kind !== "object" && kind !== "function")) return value;
    if (kind === "function") {
      throw new Error("workflow sandbox: hook 返回值不得是函数——宿主可执行对象不得进入 context");
    }
    return JSON.parse(JSON.stringify(value));
  };
})()`;

/** context 内桥接器工厂：把宿主函数包成 **context realm** 函数（closure 持宿主引用，属性面不可达）。
 * 返回值一律过 `clone`——**异步钩子尤其关键**：宿主 async 函数回传的是宿主 Promise，
 * 若原样交给脚本，`agent("x").constructor.constructor("return process")()` 即可取到宿主 process（探针实证 ②）。 */
const BRIDGE_FACTORY_SOURCE = `(function () {
  "use strict";
  return function makeWorkflowBridge(hostFn, label, clone) {
    var wrapper = function () {
      var out = hostFn.apply(undefined, arguments);
      if (out !== null && typeof out === "object" && typeof out.then === "function") {
        return Promise.resolve(out).then(clone);
      }
      return clone(out);
    };
    try { Object.defineProperty(wrapper, "name", { value: label, configurable: true }); } catch (e) {}
    try {
      Object.defineProperty(wrapper, "toString", {
        value: function () { return "function " + label + "() { [workflow hook] }"; },
        configurable: true,
      });
    } catch (e) {}
    return wrapper;
  };
})()`;

const CONSOLE_FACTORY_SOURCE = `(function () {
  "use strict";
  return function makeWorkflowConsole(emit) {
    function line(args) {
      emit(Array.prototype.map.call(args, function (v) { return typeof v === "string" ? v : String(v); }).join(" "));
    }
    return {
      log: function () { line(arguments); },
      info: function () { line(arguments); },
      debug: function () { line(arguments); },
      warn: function () { line(arguments); },
      error: function () { line(arguments); },
      trace: function () {},
    };
  };
})()`;

const BUDGET_FACTORY_SOURCE = `(function () {
  "use strict";
  return function makeWorkflowBudget(total, spentFn, remainingFn) {
    return { total: total, spent: spentFn, remaining: remainingFn };
  };
})()`;

const REJECT_FACTORY_SOURCE = `(function () {
  "use strict";
  return function makeRejectingHook(message) {
    return function () { return Promise.reject(new Error(message)); };
  };
})()`;

const FACTORY_FILENAME = "workflow-globals.js";

/**
 * 建 vm context：null 原型 sandbox + `codeGeneration {strings:false, wasm:false}` + 守卫 prelude（DoD①②）。
 * sandbox 用 `Object.create(null)`（[CC] §3.2 逐字 `__proto__: null` 的等价形）；守卫在 context 内定义。
 */
export function createWorkflowContext(): Context {
  const sandbox = Object.create(null) as Record<string, unknown>;
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  runInContext(preludeSource(), context, { filename: "workflow-prelude.js" });
  return context;
}

/** 注入 DoD④ 九件全局（全部经 context 内桥接/克隆；宿主引用不出现在任何可属性访问的位置）。 */
export function installWorkflowGlobals(context: Context, options: WorkflowRunOptions): void {
  const clone = runInContext(CLONE_FACTORY_SOURCE, context, { filename: FACTORY_FILENAME }) as (value: unknown) => unknown;
  const bridgeFactory = runInContext(BRIDGE_FACTORY_SOURCE, context, { filename: FACTORY_FILENAME }) as (
    hostFn: (...args: never[]) => unknown,
    label: string,
    cloneFn: (value: unknown) => unknown,
  ) => unknown;
  /** 包一层宿主实现：返回值（同步或 Promise）一律经 context 内 clone 落回 context realm。 */
  const bind = (hostFn: (...args: never[]) => unknown, label: string): unknown => bridgeFactory(hostFn, label, clone);
  const makeConsole = runInContext(CONSOLE_FACTORY_SOURCE, context, { filename: FACTORY_FILENAME }) as (
    emit: unknown,
  ) => unknown;
  const makeBudget = runInContext(BUDGET_FACTORY_SOURCE, context, { filename: FACTORY_FILENAME }) as (
    total: number | null,
    spentFn: unknown,
    remainingFn: unknown,
  ) => unknown;
  const makeRejectingHook = runInContext(REJECT_FACTORY_SOURCE, context, { filename: FACTORY_FILENAME }) as (
    message: string,
  ) => unknown;

  const { hooks } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const emit = bind(((message: unknown) => hooks.log?.(String(message))) as (...args: never[]) => unknown, "workflowLog");

  const agent = bind(
    ((prompt: unknown, opts?: unknown) => hooks.agent(String(prompt), opts as WorkflowAgentOptions | undefined)) as (
      ...args: never[]
    ) => unknown,
    "agent",
  );
  const parallel = bind(
    ((thunks: unknown) => hooks.parallel(thunks as ReadonlyArray<() => Promise<unknown>>)) as (...args: never[]) => unknown,
    "parallel",
  );
  const pipeline = bind(
    ((items: unknown, ...stages: unknown[]) =>
      hooks.pipeline(items as readonly unknown[], ...(stages as WorkflowPipelineStage[]))) as (...args: never[]) => unknown,
    "pipeline",
  );
  const phase = bind(((title: unknown) => hooks.phase?.(String(title))) as (...args: never[]) => unknown, "phase");
  const log = bind(((message: unknown) => hooks.log?.(String(message))) as (...args: never[]) => unknown, "log");
  const workflow = options.child
    ? makeRejectingHook(WORKFLOW_CHILD_NESTING_MESSAGE)
    : bind(
        ((nameOrRef: unknown, args?: unknown) =>
          hooks.workflow
            ? hooks.workflow(String(nameOrRef), args)
            : Promise.reject(new Error(WORKFLOW_HOOK_MISSING_MESSAGE))) as (...args: never[]) => unknown,
        "workflow",
      );

  const globals: Array<[WorkflowGlobalName, unknown]> = [
    ["agent", agent],
    ["parallel", parallel],
    ["pipeline", pipeline],
    ["phase", phase],
    ["log", log],
    ["console", makeConsole(emit)],
    [
      "budget",
      makeBudget(
        budget.total,
        bind((() => budget.spent()) as (...args: never[]) => unknown, "budgetSpent"),
        bind((() => budget.remaining()) as (...args: never[]) => unknown, "budgetRemaining"),
      ),
    ],
    ["args", clone(options.args)],
    ["workflow", workflow],
  ];

  for (const [name, value] of globals) {
    Object.defineProperty(context, name, { value, writable: true, enumerable: true, configurable: false });
  }
}

/**
 * 求值 workflow 脚本：meta 静态校验 → vm context（守卫）→ 九件注入 → `(async () => { <body> })()` 求值（DoD⑥ 超时包装）。
 * @returns 脚本正文顶层 `return` 的值（[自定]①：包装后顶层 return 即 workflow 返回值）；未 return 时为 undefined。
 */
export async function runWorkflowScript(options: WorkflowRunOptions): Promise<unknown> {
  const { body } = parseWorkflowMeta(options.script);
  const context = createWorkflowContext();
  installWorkflowGlobals(context, options);
  const filename = options.filename ?? WORKFLOW_SCRIPT_FILENAME;
  const syncTimeoutMs = options.syncTimeoutMs ?? WORKFLOW_SYNC_TIMEOUT_MS;
  const wrapped = `(async () => {\n${body}\n})()`;
  let evaluation: unknown;
  try {
    evaluation = runInContext(wrapped, context, { filename, timeout: syncTimeoutMs });
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new WorkflowTimeoutError(syncTimeoutMs, filename);
    }
    throw err;
  }
  return await (evaluation as Promise<unknown>);
}
