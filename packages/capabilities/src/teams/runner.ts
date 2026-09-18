// M6-WP-08：teammate 面 per-member 运行器（承接 WP-07 遗留「per-member port 与运行器回灌」）。
//
// 依据：v2.8 ORC-023 / §5.3(4) / ORC-050；A 级 `claude-code-agent-teams.md` §6.3（处理链 L175784、L176009-176018）。
// 逐字锚点：shutdown_request → 转 user 消息由模型决定、**不自动终止**（L176009-176018）；`from` 缺省回落 `team-lead`
// （L176014 `M.request?.from || "team-lead"`）。
//
// [自定] 口径（供 V 核验）：
//   ① 幂等：进程内存游标 `cursor`（已处理 inbox 条目数）；重复 `receive()` 不重复回灌（用例证明）。
//   ② 投递：main/lead → `deliverToMain`；成员 → `appendMailbox(teammateInboxPath(...))`；unknown → 返回
//      `"unreachable-namespace"`（交 `classifySendFailure` 归一 `not_reachable`）。self-target 由工具层预检（不重复实现）。
//   ③ shutdown 应答 `approve:true` → `terminate()` **恰好一次**（内部 `terminated` 标志去重）+ 后果文案；
//      `approve:false` → 不终止 + 继续文案；非法/未配对应答（request_id 不在 known/open 集）→ 抛错点名。
//   ④ plan_approval：`requestApproval` 注入回调 → `{approve, feedback?}` → 构造 response → 回灌**发起方**
//      （缺省回落 `team-lead`）；**拒绝=发起方继续修改**。fail-closed：`requestApproval` 缺席 = 判定拒绝（构造
//      `approve:false` 响应并回灌）+ **告警不静默**。
//   ⑤ 复用既有泵（events.ts `createTeammateMessagePump`）——**不复制平行实现**（DoD② 硬约束）。

import {
  createTeammateMessagePump,
  TEAMMATE_DEFAULT_LEAD_NAME,
  type TeammateDelivery,
} from "./events.ts";
import { type SendMessagePort } from "./send-message.ts";
import { TEAM_LEAD_ADDRESS, type TeamRoster } from "./roster.ts";
import { appendMailbox, readMailbox, teammateInboxPath, type MailboxFs, type MailboxEntry } from "./mailbox.ts";
import {
  buildPlanApprovalResponse,
  createProtocolPairing,
  isTeamsProtocolRequest,
  isTeamsProtocolResponse,
  isTeamsProtocolType,
  parseProtocolMessage,
  TEAMS_PROTOCOL_CONSEQUENCES,
  type TeamsProtocolMessage,
  type TeamsProtocolResponse,
} from "./protocol.ts";

export interface TeammateRunnerOptions {
  roster: TeamRoster;
  selfName: string;
  teamsRoot: string;
  /** 出站到 main/lead 的投递落点（渲染后文本）。缺省=无操作。 */
  deliverToMain?(text: string, meta: { from: string; summary?: string }): void;
  /** 入站消息注入 teammate 模型 turn（user turn）。缺省=无操作。 */
  deliverToModel?(delivery: TeammateDelivery): void;
  /** 终止自己（shutdown 批准时调用，恰好一次）。缺省=无操作。 */
  terminate?(): void;
  /** plan_approval 决策注入回调；缺席=fail-closed 拒绝。 */
  requestApproval?(req: { request_id: string; content: string }): Promise<{ approve: boolean; feedback?: string }> | { approve: boolean; feedback?: string };
  now?(): string;
  idGen?(): string;
  fs?: MailboxFs;
  /** 告警（fail-closed / 坏条目）。缺省=写 stderr。 */
  warn?(message: string): void;
}

export interface TeammateRunner {
  readonly selfName: string;
  readonly roster: TeamRoster;
  readonly inboxPath: string;
  /** SendMessagePort（teammate 出站投递）。 */
  readonly port: SendMessagePort;
  /** 读本人 inbox 并分派（幂等游标）。 */
  receive(): Promise<void>;
  /** 是否已触发终止（恰好一次判定面）。 */
  isTerminated(): boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTeammateRunner(options: TeammateRunnerOptions): TeammateRunner {
  const { roster, selfName, teamsRoot } = options;
  const fs = options.fs;
  const now = options.now ?? (() => new Date().toISOString());
  const warn = options.warn ?? ((m: string) => {
    try {
      process.stderr.write(`${m}\n`);
    } catch {
      /* 告警不静默但不因写入失败而崩溃 */
    }
  });

  const inboxPath = teammateInboxPath(teamsRoot, roster.teamName, selfName);
  const pairing = createProtocolPairing();

  /** 收到的请求 request_id（shutdown_request / plan_approval_request incoming）。 */
  const knownRequestIds = new Set<string>();
  /** 本 teammate 发出的请求 request_id（经 pairing 开）。 */
  const openRequestIds = new Set<string>();

  let cursor = 0;
  let terminated = false;

  const pump = createTeammateMessagePump({
    deliver: (delivery: TeammateDelivery): void => {
      options.deliverToModel?.(delivery);
    },
  });

  function triggerTerminate(): void {
    if (terminated) return; // 恰好一次
    terminated = true;
    warn(TEAMS_PROTOCOL_CONSEQUENCES.shutdownApproved); // 后果文案：批准 shutdown=终止自己
    options.terminate?.();
  }

  function isPairedResponse(requestId: string): boolean {
    return knownRequestIds.has(requestId) || openRequestIds.has(requestId);
  }

  const port: SendMessagePort = {
    addressable: () => roster.addressable(),
    async send(input: { to: string; message: unknown; notifyWhenIdle?: boolean }): Promise<string | null> {
      const route = roster.resolve(input.to);
      if (route.kind === "unknown") return "unreachable-namespace"; // 归一 not_reachable

      const message = input.message;
      if (isPlainObject(message) && isTeamsProtocolType(message.type)) {
        const typed = message as unknown as TeamsProtocolMessage;
        if (isTeamsProtocolRequest(typed)) {
          // 出站请求：登记以便后续响应可 settle
          try {
            pairing.open(typed);
            openRequestIds.add(typed.request_id);
          } catch (e) {
            warn(`[WP-08] ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (isTeamsProtocolResponse(typed)) {
          // 出站响应：必须配对被收到/已开的请求，否则抛错点名
          if (!isPairedResponse(typed.request_id)) {
            throw new Error(
              `teammate runner: unpaired protocol response \`${typed.type}\` with request_id \`${typed.request_id}\` (no matching received/open request)`,
            );
          }
          if (typed.type === "shutdown_response") {
            if (typed.approve === true) {
              triggerTerminate(); // approve:true → 恰好一次终止
            } else {
              warn(TEAMS_PROTOCOL_CONSEQUENCES.shutdownRejected); // approve:false → 不终止 + 继续文案
            }
          }
        }
      }

      if (route.kind === "main") {
        const text = typeof message === "string" ? message : JSON.stringify(message);
        options.deliverToMain?.(text, { from: selfName });
        return null;
      }
      // 成员：落 inbox（[自定]②）
      const entry: MailboxEntry = {
        from: selfName,
        text: typeof message === "string" ? message : JSON.stringify(message),
        sentAt: now(),
        ...(isPlainObject(message) ? { message } : {}),
      };
      appendMailbox(teammateInboxPath(teamsRoot, roster.teamName, route.member.name), entry, fs);
      return null;
    },
  };

  async function receive(): Promise<void> {
    const { entries } = readMailbox(inboxPath, fs);
    const plain: Array<{ from: string; text: string }> = [];
    for (let i = cursor; i < entries.length; i++) {
      const entry = entries[i]!;
      const proto = entry.message;
      if (isPlainObject(proto) && isTeamsProtocolType(proto.type)) {
        const parsed = parseProtocolMessage(proto);
        if (!parsed.ok) {
          warn(`[WP-08] dropped schema-invalid protocol entry: ${parsed.error}`);
          continue;
        }
        const msg = parsed.message;
        if (msg.type === "shutdown_request") {
          // DoD②：转 user 消息由模型决定，不自动终止（泵的既有分支）
          knownRequestIds.add(msg.request_id);
          pump.dispatch({
            type: "shutdown_request",
            request: { from: entry.from || TEAMMATE_DEFAULT_LEAD_NAME },
            originalMessage: msg.content ?? "",
          });
        } else if (msg.type === "plan_approval_request") {
          // DoD③：进 plan_approval 链
          knownRequestIds.add(msg.request_id);
          const initiator = entry.from || TEAM_LEAD_ADDRESS;
          let decision: { approve: boolean; feedback?: string };
          if (options.requestApproval) {
            decision = await options.requestApproval({ request_id: msg.request_id, content: msg.content ?? "" });
          } else {
            // fail-closed：判定拒绝 + 告警不静默
            warn(
              `[WP-08] plan_approval_request ${msg.request_id} received but no requestApproval handler — failing closed to REJECT`,
            );
            decision = { approve: false };
          }
          const response = buildPlanApprovalResponse({
            request_id: msg.request_id,
            approve: decision.approve,
            content: decision.feedback,
          });
          // 回灌发起方（缺省回落 team-lead，经投递路由）
          await port.send({ to: initiator, message: response });
          warn(
            decision.approve
              ? TEAMS_PROTOCOL_CONSEQUENCES.planApproved
              : TEAMS_PROTOCOL_CONSEQUENCES.planRejected,
          ); // 拒绝=发起方继续修改
        } else {
          // 响应型（对本 teammate 发出请求的应答）：进 settle
          try {
            pairing.settle(msg.request_id, msg as TeamsProtocolResponse);
          } catch (e) {
            warn(`[WP-08] ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        plain.push({ from: entry.from, text: entry.text });
      }
    }
    cursor = entries.length; // [自定]① 幂等游标推进
    if (plain.length === 1) {
      pump.dispatch({ type: "new_message", from: plain[0]!.from, message: plain[0]!.text });
    } else if (plain.length > 1) {
      pump.dispatch({ type: "new_messages", messages: plain.map((p) => ({ from: p.from, text: p.text })) });
    }
  }

  return {
    selfName,
    roster,
    inboxPath,
    port,
    receive,
    isTerminated: () => terminated,
  };
}
