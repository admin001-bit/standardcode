// WP-06（M6）teammate 消息泵单测（DoD① 五事件逐枚一例，缺一即 DoD② 不通过；DoD② 投递语义=注入为 user turn）。
// 依据 A 级 `claude-code-agent-teams.md` §4.1（L176007-176049 in-process 消息泵）与 §2.2（投递语义描述原文）。
import { describe, expect, it, vi } from "vitest";
import {
  createTeammateMessagePump,
  formatTeammateMessage,
  TEAMMATE_DEFAULT_LEAD_NAME,
  TEAMMATE_MESSAGE_EVENTS,
  type TeammateDelivery,
  type TeammateMessagePumpOptions,
} from "../src/index.ts";

function harness(overrides: Partial<TeammateMessagePumpOptions> = {}) {
  const deliveries: TeammateDelivery[] = [];
  const onAborted = vi.fn();
  const onIdleTimeout = vi.fn();
  const pump = createTeammateMessagePump({
    deliver: (delivery) => deliveries.push(delivery),
    onAborted,
    onIdleTimeout,
    ...overrides,
  });
  return { pump, deliveries, onAborted, onIdleTimeout };
}

function textOf(delivery: TeammateDelivery): string {
  const block = delivery.message.content[0];
  return block && block.type === "text" ? block.text : "";
}

describe("DoD① 五事件穷举（枚举纪律：逐名核对，缺一即失败）", () => {
  it("事件型集合恰为五件且逐名与 A 级 §4.1 一致", () => {
    expect(TEAMMATE_MESSAGE_EVENTS).toHaveLength(5);
    expect([...TEAMMATE_MESSAGE_EVENTS]).toEqual([
      "shutdown_request",
      "new_message",
      "new_messages",
      "aborted",
      "idle_timeout",
    ]);
  });

  it("五事件逐枚可分发且各自计数（每型一例）", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "shutdown_request", originalMessage: "please stop" });
    pump.dispatch({ type: "new_message", from: "researcher", message: "hi" });
    pump.dispatch({ type: "new_messages", messages: [{ from: "a", text: "1" }, { from: "b", text: "2" }] });
    pump.dispatch({ type: "aborted", reason: "user interrupt" });
    pump.dispatch({ type: "idle_timeout", idleMs: 1000 });
    expect(pump.handled).toEqual({
      shutdown_request: 1,
      new_message: 1,
      new_messages: 1,
      aborted: 1,
      idle_timeout: 1,
    });
    // shutdown/new_message×1/new_messages×1 各一条投递（aborted/idle_timeout 无订阅者=零投递）
    expect(deliveries).toHaveLength(3);
  });

  it("未知事件型抛错（静默丢弃=旁路，禁）", () => {
    const { pump } = harness();
    expect(() => pump.dispatch({ type: "nope" } as never)).toThrow(/未知事件型/);
  });
});

describe("DoD①① shutdown_request：转 user 消息由模型决定，不自动终止", () => {
  it("from 取 request.from，缺席回落 team-lead（A 级 §4.1）", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "shutdown_request", originalMessage: "wrap up" });
    expect(deliveries[0]!.meta.from).toBe(TEAMMATE_DEFAULT_LEAD_NAME);
    expect(textOf(deliveries[0]!)).toContain("wrap up");
    pump.dispatch({ type: "shutdown_request", request: { from: "lead-x" }, originalMessage: "wrap up" });
    expect(deliveries[1]!.meta.from).toBe("lead-x");
  });

  it("泵不做终止动作（onAborted 不被触发=不自动终止）", () => {
    const { pump, onAborted } = harness();
    pump.dispatch({ type: "shutdown_request", originalMessage: "stop" });
    expect(onAborted).not.toHaveBeenCalled();
    expect(pump.handled.shutdown_request).toBe(1);
  });
});

describe("DoD① new_message：from===\"user\" 直传，否则渲染 {from,text,color,summary}", () => {
  it("user 直传不做队友前缀渲染", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "new_message", from: "user", message: "raw user text", origin: "cli" });
    expect(textOf(deliveries[0]!)).toBe("raw user text");
    expect(deliveries[0]!.meta.summary).toBe("cli");
  });

  it("队友消息渲染为 `<summary>\\n<from>: <text>`，color 进元数据不进文本", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "new_message", from: "researcher", message: "found it", color: "blue", summary: "调研结果" });
    expect(textOf(deliveries[0]!)).toBe("[调研结果]\nresearcher: found it");
    expect(deliveries[0]!.meta).toMatchObject({ from: "researcher", color: "blue", summary: "调研结果", kind: "message" });
  });
});

describe("DoD① new_messages：批量排空一次注入", () => {
  it("多条积压合成单条 user turn", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({
      type: "new_messages",
      messages: [
        { from: "a", text: "one" },
        { from: "b", text: "two", summary: "s2" },
      ],
    });
    expect(deliveries).toHaveLength(1);
    expect(textOf(deliveries[0]!)).toBe("a: one\n[s2]\nb: two");
    expect(deliveries[0]!.meta.from).toBe("b");
  });
});

describe("DoD① aborted / idle_timeout：回调面 + 一次性 idle 通知", () => {
  it("aborted 触发 onAborted（[自定]②：A 级该分支体省略）", () => {
    const { pump, onAborted, deliveries } = harness();
    pump.dispatch({ type: "aborted", reason: "user interrupt" });
    expect(onAborted).toHaveBeenCalledWith({ type: "aborted", reason: "user interrupt" });
    expect(deliveries).toHaveLength(0);
  });

  it("idle_timeout 触发 onIdleTimeout，并向每个订阅者发**一次性**通知", () => {
    const { pump, onIdleTimeout, deliveries } = harness({ idleSubscribers: () => ["main", "reviewer"] });
    pump.dispatch({ type: "idle_timeout", idleMs: 500 });
    expect(onIdleTimeout).toHaveBeenCalledOnce();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.meta.kind === "idle_notice")).toBe(true);
    expect(deliveries.map((d) => textOf(d))).toEqual([
      "[idle notice] main 已空闲（一次性通知；opt-in 订阅，无轮询）",
      "[idle notice] reviewer 已空闲（一次性通知；opt-in 订阅，无轮询）",
    ]);
  });

  it("无订阅者时 idle_timeout 零投递", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "idle_timeout" });
    expect(deliveries).toHaveLength(0);
  });
});

describe("DoD② 投递语义：作为 user turn 注入由下一轮消费", () => {
  it("每次投递都是 role=user 的文本 turn", () => {
    const { pump, deliveries } = harness();
    pump.dispatch({ type: "new_message", from: "a", message: "x" });
    pump.dispatch({ type: "shutdown_request", originalMessage: "y" });
    for (const delivery of deliveries) {
      expect(delivery.message.role).toBe("user");
      expect(delivery.message.content).toHaveLength(1);
      expect(delivery.message.content[0]!.type).toBe("text");
    }
  });

  it("渲染函数对 summary/无 summary 两态稳定", () => {
    expect(formatTeammateMessage({ from: "a", text: "t" })).toBe("a: t");
    expect(formatTeammateMessage({ from: "a", text: "t", summary: "s" })).toBe("[s]\na: t");
  });
});
