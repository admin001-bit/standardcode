// M6-WP-06：SendMessage 工具（DoD③ 参数四字段 + 失败分类；DoD④ 协议对象字段白名单）。
//
// 依据：v2.8 ORC-023（行 295"Agent Teams"）+ ORC-050（行 299 默认关闭）。
// 逐字锚点（A 级 `claude-code-agent-teams.md`）：
//   §2.1 参数 schema（`nkr(e)`，L209394 附近）：`to`（单行收件人；regex 约束）/`summary`（上限 200，**截断而非拒绝**）/
//        `message`（纯文本或结构化协议 JSON）/`notify_when_idle`（本机会话一次性 idle 通知订阅，opt-in、无轮询）
//   §2.2 工具描述（L208382）："Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool."
//   §2.3 发送失败归一（`M4e(e)`，L209430 附近）：requester-refuses-inbound→permission_denied；
//        no-inbox/unreachable-namespace/peer-unsupported→not_reachable；self-target→invalid_target；peer-gone→stale_socket；
//        send-failed/send-uncertain→（报告该分支体被省略）
//   §6.1 协议对象白名单（L37104）：`["type","recipient","content","request_id","approve"]`
//
// 寻址面（DoD③ `to`）：teammate 名 / `"main"`（保留名，恒路由主对话）/ 后台 agent 的 agentId；通讯录与命名规则属 WP-07
// （`addressable()` 为该面的注入点，本卡只消费）——[自定] 口径见下。
//
// [自定] 口径（供 V 核验）：
//   ① `send-failed`/`send-uncertain` 归一为 `send_failed`（A 级 §2.3 该分支体省略）。
//   ② `to` 上限 `SEND_MESSAGE_RECIPIENT_MAX=128`（A 级只给"max ${Qwr} characters"，未给数值）。
//   ③ 结构化 `message` 的校验口径：必须是对象、必须含字符串 `type`、键集 MUST ⊆ 白名单（越界键=拒绝并点名）。
//   ④ `notify_when_idle` 的订阅登记由投递口（WP-07 运行器）承担；本卡只把该位透传并回执文案。
//   ⑤ 工具本体**不注册进 `createStandardTools`**（DoD⑥ 默认关=工具零注册）；注册门映射见 apps/cli `experimental-gate.ts`。

import type { StandardTool } from "../contract.ts";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

/** `summary` 上限（A 级 §2.1 逐字 `max(X5)`，`X5 = 200` @L37101）——超限**截断而非拒绝**。 */
export const SEND_MESSAGE_SUMMARY_MAX = 200;

/** [自定]②：收件人字符串上限（A 级只给"max ${Qwr} characters"未给值）。 */
export const SEND_MESSAGE_RECIPIENT_MAX = 128;

/** 协议对象字段白名单（A 级 §6.1 L37104 逐字）。 */
export const SEND_MESSAGE_PROTOCOL_FIELDS = ["type", "recipient", "content", "request_id", "approve"] as const;

/** 保留收件人名（A 级 §2.1："main" 恒路由主对话）。 */
export const SEND_MESSAGE_MAIN_RECIPIENT = "main";

/** 归一化后的机器可读失败分类（A 级 §2.3）。 */
export const SEND_MESSAGE_FAILURES = [
  "permission_denied",
  "not_reachable",
  "invalid_target",
  "stale_socket",
  "send_failed",
] as const;

export type SendMessageFailure = (typeof SEND_MESSAGE_FAILURES)[number];

/** 传输层原因 → 机器可读分类（A 级 §2.3 逐条；[自定]① 补 send_failed 两员）。 */
export const SEND_MESSAGE_FAILURE_MAP: Readonly<Record<string, SendMessageFailure>> = {
  "requester-refuses-inbound": "permission_denied",
  "no-inbox": "not_reachable",
  "unreachable-namespace": "not_reachable",
  "peer-unsupported": "not_reachable",
  "self-target": "invalid_target",
  "peer-gone": "stale_socket",
  "send-failed": "send_failed",
  "send-uncertain": "send_failed",
};

/** 归一失败分类；未知原因回落 `send_failed`（不静默、不抛）。 */
export function classifySendFailure(reason: string): SendMessageFailure {
  return SEND_MESSAGE_FAILURE_MAP[reason] ?? "send_failed";
}

/** 投递口（WP-07 运行器/邮箱提供方；本卡只消费）。 */
export interface SendMessagePort {
  /** 投递；返回 null=成功，否则返回传输层原因字符串（经 classifySendFailure 归一）。 */
  send(input: { to: string; message: unknown; notifyWhenIdle?: boolean }): Promise<string | null>;
  /** 可寻址集（通讯录面；缺席=不校验存在性，只做形状校验）。 */
  addressable?(): readonly string[];
}

export interface SendMessageToolOptions {
  port: SendMessagePort;
  /** 发送者自身名（self-target 预检 → invalid_target；A 级 §2.3）。 */
  selfName?: string;
}

export type SendMessageResult =
  | { ok: true; receipt: string }
  | { ok: false; failure: SendMessageFailure; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 纯函数投递核（工具与测试共用；工具只负责把结果串化）。 */
export async function sendMessage(
  input: unknown,
  options: SendMessageToolOptions,
): Promise<SendMessageResult> {
  if (!isPlainObject(input)) {
    return { ok: false, failure: "invalid_target", reason: "input must be an object" };
  }
  const to = input.to;
  if (typeof to !== "string" || to.length === 0) {
    return { ok: false, failure: "invalid_target", reason: "`to` must be a non-empty string" };
  }
  if (/[\r\n]/.test(to)) {
    return { ok: false, failure: "invalid_target", reason: "`to` must be a single-line recipient name or address" };
  }
  if (to.length > SEND_MESSAGE_RECIPIENT_MAX) {
    return {
      ok: false,
      failure: "invalid_target",
      reason: `recipient longer than any listed name or address (max ${SEND_MESSAGE_RECIPIENT_MAX} characters)`,
    };
  }
  if (options.selfName !== undefined && to === options.selfName) {
    // self-target 预检（A 级 §2.3：self-target → invalid_target）
    return { ok: false, failure: "invalid_target", reason: `cannot send a message to self (\`${to}\`)` };
  }
  const addressable = options.port.addressable?.();
  if (addressable && !addressable.includes(to)) {
    return { ok: false, failure: "not_reachable", reason: `unknown recipient: ${to}` };
  }

  const summary = normalizeSummary(input.summary);
  if (summary.error) return { ok: false, failure: "invalid_target", reason: summary.error };

  const message = input.message;
  if (message === undefined) {
    return { ok: false, failure: "invalid_target", reason: "`message` is required (plain text or a protocol object)" };
  }
  const protocolCheck = checkProtocolMessage(message);
  if (protocolCheck.error) return { ok: false, failure: "invalid_target", reason: protocolCheck.error };

  const notifyWhenIdle = input.notify_when_idle === true;
  const failureReason = await options.port.send({
    to,
    message,
    ...(notifyWhenIdle ? { notifyWhenIdle: true } : {}),
  });
  if (failureReason !== null) {
    const failure = classifySendFailure(failureReason);
    return { ok: false, failure, reason: failureReason };
  }
  const receipt = notifyWhenIdle
    ? `delivered to ${to}; notify_when_idle subscribed (one-shot, no polling)`
    : `delivered to ${to}${summary.truncated ? ` (summary truncated to ${SEND_MESSAGE_SUMMARY_MAX} characters)` : ""}`;
  return { ok: true, receipt };
}

/** `summary`：超限**截断**（A 级 §2.1 明示"truncated rather than rejected"）。 */
function normalizeSummary(raw: unknown): { truncated: boolean; error?: string } {
  if (raw === undefined) return { truncated: false };
  if (typeof raw !== "string") return { truncated: false, error: "`summary` must be a string when provided" };
  return { truncated: raw.length > SEND_MESSAGE_SUMMARY_MAX };
}

/** 结构化 `message`：含字符串 `type`、键集 ⊆ 白名单（DoD④）。 */
function checkProtocolMessage(message: unknown): { error?: string } {
  if (!isPlainObject(message)) return {};
  if (typeof message.type !== "string" || message.type.length === 0) {
    return { error: "structured `message` must carry a non-empty string `type`" };
  }
  for (const key of Object.keys(message)) {
    if (!(SEND_MESSAGE_PROTOCOL_FIELDS as readonly string[]).includes(key)) {
      return {
        error: `unknown protocol field \`${key}\` (allowed: ${SEND_MESSAGE_PROTOCOL_FIELDS.join(", ")})`,
      };
    }
  }
  return {};
}

/** 必发文案（A 级 §2.2 工具描述首句逐字口径：纯文本输出对队友不可见）。 */
export const SEND_MESSAGE_DESCRIPTION =
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. " +
  "Messages from teammates are delivered automatically; you don't check an inbox. " +
  `Refer to agents by name — names keep working after an agent completes. \`to\` accepts a teammate name, "${SEND_MESSAGE_MAIN_RECIPIENT}" (the main conversation), or a background agent's agentId. ` +
  "Don't send structured JSON status messages — report progress through your task tools if you have them, otherwise in plain prose.";

/** 构造 SendMessage 工具（**不**并入 `createStandardTools`：DoD⑥ 默认关=工具零注册）。 */
export function createSendMessageTool(options: SendMessageToolOptions): StandardTool {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description: SEND_MESSAGE_DESCRIPTION,
    searchHint: "teammate messaging, team communication",
    isConcurrencySafe: false,
    deferred: false,
    inputSchema: {
      type: "object",
      required: ["to", "message"],
      properties: {
        to: {
          type: "string",
          description: `Recipient: a teammate name, "${SEND_MESSAGE_MAIN_RECIPIENT}", or a background agent's agentId`,
        },
        summary: {
          type: "string",
          description: `A 5-10 word summary shown as a one-line preview. Defaults to the first line of a plain-text message; longer summaries are truncated to ${SEND_MESSAGE_SUMMARY_MAX} characters rather than rejected.`,
        },
        message: {
          // A 级 §2.1 union（纯文本或结构化协议 JSON）——WP-06 V 观察 O2 收敛：runtime 本就放行字符串，
          // schema 由 `type:"object"` 收敛为 anyOf 两枝，消除声明面与运行时面不一致。
          anyOf: [{ type: "string" }, { type: "object" }],
          description: "Plain text message content, or a structured protocol object",
        },
        notify_when_idle: {
          type: "boolean",
          description:
            "Ask a session ON THIS MACHINE to send you ONE notice when it next goes idle or exits — opt-in, one-shot, no polling.",
        },
      },
    },
    execute: async (input: unknown): Promise<string> => {
      const result = await sendMessage(input, options);
      if (result.ok) return result.receipt;
      return `send failed (${result.failure}): ${result.reason}`;
    },
  };
}
