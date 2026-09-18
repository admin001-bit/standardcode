// WP-06（M6）SendMessage 工具单测：DoD③（参数四字段 to/summary/message/notify_when_idle + 失败分类
// permission_denied/not_reachable/…）＋DoD④（协议对象字段白名单逐字五件）。
// 依据 A 级 `claude-code-agent-teams.md` §2.1（L209394 schema）·§2.2（描述）·§2.3（L209430 失败归一）·§6.1（L37104 白名单）。
import { describe, expect, it, vi } from "vitest";
import {
  classifySendFailure,
  createSendMessageTool,
  SEND_MESSAGE_FAILURE_MAP,
  SEND_MESSAGE_FAILURES,
  SEND_MESSAGE_MAIN_RECIPIENT,
  SEND_MESSAGE_PROTOCOL_FIELDS,
  SEND_MESSAGE_RECIPIENT_MAX,
  SEND_MESSAGE_SUMMARY_MAX,
  SEND_MESSAGE_TOOL_NAME,
  sendMessage,
  type SendMessagePort,
} from "../src/index.ts";
import type { ToolContext } from "@standardcode/harness";

function ctx(): ToolContext {
  return { signal: new AbortController().signal, registerProcess: () => {} };
}

function port(failureReason: string | null = null, addressable?: readonly string[]): SendMessagePort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      return failureReason;
    },
    ...(addressable ? { addressable: () => addressable } : {}),
  };
}

describe("DoD③ 参数四字段与常量", () => {
  it("工具名与 schema 四字段齐备（required=to/message）", () => {
    expect(SEND_MESSAGE_TOOL_NAME).toBe("SendMessage");
    const tool = createSendMessageTool({ port: port() });
    expect(tool.name).toBe("SendMessage");
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual([
      "message",
      "notify_when_idle",
      "summary",
      "to",
    ]);
    expect([...((tool.inputSchema.required ?? []) as readonly string[])].sort()).toEqual(["message", "to"]);
  });

  it("summary 上限 200（A 级 §2.1 逐字 max(X5)=200）", () => {
    expect(SEND_MESSAGE_SUMMARY_MAX).toBe(200);
  });

  it("成功投递：透传到投递口并回执", async () => {
    const p = port(null);
    const result = await sendMessage({ to: "researcher", message: "ping" }, { port: p });
    expect(result).toEqual({ ok: true, receipt: "delivered to researcher" });
    expect(p.calls).toEqual([{ to: "researcher", message: "ping" }]);
  });

  it("notify_when_idle 透传并回执一次性订阅（§2.1 opt-in、无轮询）", async () => {
    const p = port(null);
    const result = await sendMessage({ to: "a", message: "x", notify_when_idle: true }, { port: p });
    expect(result.ok).toBe(true);
    expect(result.ok && result.receipt).toContain("notify_when_idle subscribed (one-shot, no polling)");
    expect(p.calls).toEqual([{ to: "a", message: "x", notifyWhenIdle: true }]);
  });

  it("summary 超限**截断而非拒绝**（A 级 §2.1 逐字）", async () => {
    const long = "s".repeat(SEND_MESSAGE_SUMMARY_MAX + 50);
    const result = await sendMessage({ to: "a", message: "x", summary: long }, { port: port() });
    expect(result.ok).toBe(true);
    expect(result.ok && result.receipt).toContain("summary truncated to 200 characters");
  });

  it("to 多行/超长/空一律拒绝", async () => {
    expect((await sendMessage({ to: "a\nb", message: "x" }, { port: port() })).ok).toBe(false);
    expect((await sendMessage({ to: "a".repeat(SEND_MESSAGE_RECIPIENT_MAX + 1), message: "x" }, { port: port() })).ok).toBe(false);
    expect((await sendMessage({ to: "", message: "x" }, { port: port() })).ok).toBe(false);
  });
});

describe("DoD③ 失败分类（A 级 §2.3 逐条归一）", () => {
  it("映射表逐条与 A 级一致（枚举纪律）", () => {
    expect(SEND_MESSAGE_FAILURE_MAP).toEqual({
      "requester-refuses-inbound": "permission_denied",
      "no-inbox": "not_reachable",
      "unreachable-namespace": "not_reachable",
      "peer-unsupported": "not_reachable",
      "self-target": "invalid_target",
      "peer-gone": "stale_socket",
      "send-failed": "send_failed",
      "send-uncertain": "send_failed",
    });
    expect([...SEND_MESSAGE_FAILURES]).toEqual([
      "permission_denied",
      "not_reachable",
      "invalid_target",
      "stale_socket",
      "send_failed",
    ]);
  });

  it("逐原因归一（每类一例）+ 未知原因回落 send_failed（不静默）", () => {
    expect(classifySendFailure("requester-refuses-inbound")).toBe("permission_denied");
    expect(classifySendFailure("no-inbox")).toBe("not_reachable");
    expect(classifySendFailure("self-target")).toBe("invalid_target");
    expect(classifySendFailure("peer-gone")).toBe("stale_socket");
    expect(classifySendFailure("send-uncertain")).toBe("send_failed");
    expect(classifySendFailure("brand-new-reason")).toBe("send_failed");
  });

  it("传输失败经工具出口串化携带分类标记", async () => {
    const tool = createSendMessageTool({ port: port("peer-gone") });
    await expect(tool.execute({ to: "a", message: "x" }, ctx())).resolves.toBe(
      "send failed (stale_socket): peer-gone",
    );
  });

  it("self-target：本名预检 + 传输层 self-target 双路都归一 invalid_target", async () => {
    const precheck = await sendMessage({ to: "me", message: "x" }, { port: port(), selfName: "me" });
    expect(precheck).toMatchObject({ ok: false, failure: "invalid_target" });
    const transmitted = await sendMessage({ to: "other", message: "x" }, { port: port("self-target") });
    expect(transmitted).toMatchObject({ ok: false, failure: "invalid_target" });
  });

  it("通讯录存在性：addressable 缺席=只做形状校验；出席=未知收件人 not_reachable", async () => {
    const open = await sendMessage({ to: "ghost", message: "x" }, { port: port() });
    expect(open.ok).toBe(true);
    const constrained = await sendMessage({ to: "ghost", message: "x" }, { port: port(null, ["researcher"]) });
    expect(constrained).toMatchObject({ ok: false, failure: "not_reachable" });
    const listed = await sendMessage({ to: "researcher", message: "x" }, { port: port(null, ["researcher"]) });
    expect(listed.ok).toBe(true);
  });
});

describe("DoD④ 协议对象字段白名单（A 级 §6.1 L37104 逐字五件）", () => {
  it("白名单逐字", () => {
    expect([...SEND_MESSAGE_PROTOCOL_FIELDS]).toEqual(["type", "recipient", "content", "request_id", "approve"]);
    expect(SEND_MESSAGE_MAIN_RECIPIENT).toBe("main");
  });

  it("纯文本 message 放行；白名单内结构化对象放行", async () => {
    expect((await sendMessage({ to: "a", message: "plain" }, { port: port() })).ok).toBe(true);
    const protocol = { type: "shutdown_response", request_id: "r1", approve: true };
    expect((await sendMessage({ to: "a", message: protocol }, { port: port() })).ok).toBe(true);
  });

  it("越界键=拒绝并点名；缺 type=拒绝", async () => {
    const extra = await sendMessage({ to: "a", message: { type: "shutdown_response", feedback: "no" } }, { port: port() });
    expect(extra).toMatchObject({ ok: false });
    expect(extra.ok === false && extra.reason).toContain("unknown protocol field `feedback`");
    const missing = await sendMessage({ to: "a", message: { approve: true } }, { port: port() });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.ok === false && missing.reason).toContain("must carry a non-empty string `type`");
  });

  it("`main` 作为保留收件人可寻址（恒路由主对话）", async () => {
    const p = port(null);
    const result = await sendMessage({ to: SEND_MESSAGE_MAIN_RECIPIENT, message: "x" }, { port: p });
    expect(result.ok).toBe(true);
    expect(p.calls).toEqual([{ to: "main", message: "x" }]);
  });

  it("缺 message 拒绝（不静默投递空消息）", async () => {
    const result = await sendMessage({ to: "a" }, { port: port() });
    expect(result).toMatchObject({ ok: false, failure: "invalid_target" });
  });
});

describe("工具元数据与契约", () => {
  it("描述含必发口径（纯文本对队友不可见）且工具非 deferred/串行", () => {
    const tool = createSendMessageTool({ port: port() });
    expect(tool.description).toContain("Your plain text output is NOT visible to other agents");
    expect(tool.description).toContain("you MUST call this tool");
    expect(tool.deferred).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
  });

  it("成功路径 execute 返回回执字符串", async () => {
    const tool = createSendMessageTool({ port: port() });
    await expect(tool.execute({ to: "a", message: "x" }, ctx())).resolves.toBe("delivered to a");
    expect(vi.isMockFunction(tool.execute)).toBe(false);
  });
});
