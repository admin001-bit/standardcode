// M6-WP-06：teammate 消息泵（DoD② 直接载体——"五事件齐"，缺一即 DoD② 不通过）。
//
// 依据：v2.8 ORC-023（行 295"Agent Teams"）+ Q-4（行 578"跨会话 SendMessage 载体=本地 transcript 存储 +
// 事件总线（M6，与 ORC-041 同协议）"）+ ORC-050（行 299 默认关闭）；BLK-07=①（2026-09-18 用户裁决）——
// teammate 运行形态=**in-process 运行器**，不引入 tmux、不做独立进程 spawn；本模块即该运行器的**消息消费半边**。
//
// 逐字锚点：A 级 `claude-code-agent-teams.md` §4.1（L176007-176049 in-process 消息泵五事件）：
//   shutdown_request → `W = j3({from: M.request?.from || "team-lead", text: M.originalMessage})` → 注入 user 消息（由模型决定响应）
//   new_message      → `from === "user"` 直传；否则 `j3({from, text: M.message, color, summary})` → 注入
//   new_messages     → 批量排空注入（`qat(M.messages, {recipientIsLead: false})`）
//   aborted / idle_timeout → 分支体在报告中被省略（§4.1 以 `...` 收敛）→ 本实现为 [自定]，见下
//
// 投递语义（DoD②，A 级 §2.2 描述原文「Messages from teammates are delivered automatically; you don't check an inbox.」）：
// 消息被格式化后作为 **user turn** 注入 teammate 对话，由该 teammate 的**下一次查询**消费——本模块产出 `LLMMessage`
// 并交给注入口（`deliver`），自身不持有会话状态（注入点/回灌由 WP-07 运行器接线）。
//
// [自定] 口径（供 V 核验）：
//   ① 渲染格式=`.j3({from,text,color,summary})` 的**同构**实现——A 级只给出调用形、未给渲染逐字；本实现
//      `[summary]\n<from>: <text>`；color 不进文本（作结构元数据随投递，UI 区分面=M7）。
//   ② `aborted` / `idle_timeout` 两分支：报告省略其体，本实现为"回调通知"（onAborted / onIdleTimeout），
//      且 idle_timeout 另外向订阅者各发**一次性**通知（§2.1 `notify_when_idle` 语义："ONE notice when it next
//      goes idle — opt-in, one-shot, no polling"）。
//   ③ `new_messages` 批量为**单条** user turn 注入（[CC] 排空后一次注入），逐条 message 各自格式化后换行拼接。

import type { LLMMessage } from "@standardcode/providers";

/** 五事件类型（A 级 §4.1 逐字；缺一即 DoD② 不通过）。 */
export const TEAMMATE_MESSAGE_EVENTS = [
  "shutdown_request",
  "new_message",
  "new_messages",
  "aborted",
  "idle_timeout",
] as const;

export type TeammateMessageEventType = (typeof TEAMMATE_MESSAGE_EVENTS)[number];

/** shutdown_request 缺省发起方（A 级 §4.1 逐字 `M.request?.from || "team-lead"`）。 */
export const TEAMMATE_DEFAULT_LEAD_NAME = "team-lead";

/** 消息渲染元组（[CC] `j3({from, text, color, summary})` 的四字段）。 */
export interface TeammateMessageEnvelope {
  from: string;
  text: string;
  color?: string;
  summary?: string;
}

export interface TeammateShutdownRequestEvent {
  type: "shutdown_request";
  /** `request.from` 缺席时回落 TEAMMATE_DEFAULT_LEAD_NAME（A 级 §4.1）。 */
  request?: { from?: string };
  originalMessage: string;
}

export interface TeammateNewMessageEvent {
  type: "new_message";
  from: string;
  message: string;
  color?: string;
  summary?: string;
  /** `from === "user"` 时的来源标记（A 级 §4.1 `H = M.origin`；直传路径）。 */
  origin?: string;
}

export interface TeammateNewMessagesEvent {
  type: "new_messages";
  messages: ReadonlyArray<TeammateMessageEnvelope>;
}

export interface TeammateAbortedEvent {
  type: "aborted";
  reason?: string;
}

export interface TeammateIdleTimeoutEvent {
  type: "idle_timeout";
  /** 触发前的空闲时长（信息面）。 */
  idleMs?: number;
}

export type TeammateMessageEvent =
  | TeammateShutdownRequestEvent
  | TeammateNewMessageEvent
  | TeammateNewMessagesEvent
  | TeammateAbortedEvent
  | TeammateIdleTimeoutEvent;

/** 投递载荷：user turn（DoD② 消费面）+ 结构元数据（UI 颜色/摘要，M7）。 */
export interface TeammateDelivery {
  message: LLMMessage;
  meta: {
    kind: "message" | "shutdown_request" | "idle_notice";
    from: string;
    color?: string;
    summary?: string;
  };
}

/** [自定]①：`j3({from,text,color,summary})` 同构渲染（A 级未给逐字渲染）。 */
export function formatTeammateMessage(envelope: TeammateMessageEnvelope): string {
  const head = envelope.summary ? `[${envelope.summary}]\n` : "";
  return `${head}${envelope.from}: ${envelope.text}`;
}

function userTurn(text: string): LLMMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export interface TeammateMessagePumpOptions {
  /** 注入口：把投递物作为 user turn 注入 teammate 对话（DoD②：由下一轮消费）。 */
  deliver(delivery: TeammateDelivery): void;
  /** aborted 分支回调（[自定]②）。 */
  onAborted?(event: TeammateAbortedEvent): void;
  /** idle_timeout 分支回调（[自定]②）。 */
  onIdleTimeout?(event: TeammateIdleTimeoutEvent): void;
  /** idle 一次性通知的收件集（§2.1 notify_when_idle；缺省=无订阅者、零投递）。 */
  idleSubscribers?(): readonly string[];
}

export interface TeammateMessagePump {
  /** 分发一个事件（五型穷举；未知型抛错——静默丢弃=旁路，禁）。 */
  dispatch(event: TeammateMessageEvent): void;
  /** 各型已处理计数（逐枚断言面）。 */
  readonly handled: Readonly<Record<TeammateMessageEventType, number>>;
}

/** in-process 消息泵（A 级 §4.1 五事件分发）。 */
export function createTeammateMessagePump(options: TeammateMessagePumpOptions): TeammateMessagePump {
  const handled: Record<TeammateMessageEventType, number> = {
    shutdown_request: 0,
    new_message: 0,
    new_messages: 0,
    aborted: 0,
    idle_timeout: 0,
  };

  const dispatch = (event: TeammateMessageEvent): void => {
    switch (event.type) {
      case "shutdown_request": {
        // A 级 §4.1：转 user 消息「passing to model」——由模型决定响应，**不自动终止**。
        handled.shutdown_request++;
        const from = event.request?.from ?? TEAMMATE_DEFAULT_LEAD_NAME;
        const text = `${from} (shutdown request): ${event.originalMessage}`;
        options.deliver({ message: userTurn(text), meta: { kind: "shutdown_request", from } });
        return;
      }
      case "new_message": {
        handled.new_message++;
        if (event.from === "user") {
          // 直传路径：不做 teammate 前缀渲染（A 级 §4.1 `W = M.message`）。
          options.deliver({
            message: userTurn(event.message),
            meta: { kind: "message", from: event.from, ...(event.origin ? { summary: event.origin } : {}) },
          });
          return;
        }
        const envelope: TeammateMessageEnvelope = {
          from: event.from,
          text: event.message,
          ...(event.color !== undefined ? { color: event.color } : {}),
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        };
        options.deliver({
          message: userTurn(formatTeammateMessage(envelope)),
          meta: { kind: "message", from: event.from, ...(event.color !== undefined ? { color: event.color } : {}), ...(event.summary !== undefined ? { summary: event.summary } : {}) },
        });
        return;
      }
      case "new_messages": {
        // 批量排空：一次注入（[自定]③）。
        handled.new_messages++;
        const text = event.messages.map((m) => formatTeammateMessage(m)).join("\n");
        const last = event.messages.at(-1);
        options.deliver({
          message: userTurn(text),
          meta: { kind: "message", from: last?.from ?? TEAMMATE_DEFAULT_LEAD_NAME },
        });
        return;
      }
      case "aborted": {
        handled.aborted++;
        options.onAborted?.(event);
        return;
      }
      case "idle_timeout": {
        handled.idle_timeout++;
        options.onIdleTimeout?.(event);
        for (const subscriber of options.idleSubscribers?.() ?? []) {
          options.deliver({
            message: userTurn(`[idle notice] ${subscriber} 已空闲（一次性通知；opt-in 订阅，无轮询）`),
            meta: { kind: "idle_notice", from: TEAMMATE_DEFAULT_LEAD_NAME },
          });
        }
        return;
      }
      default: {
        throw new Error(`teammate 消息泵：未知事件型 ${String((event as { type?: unknown }).type)}`);
      }
    }
  };

  return { dispatch, handled };
}
