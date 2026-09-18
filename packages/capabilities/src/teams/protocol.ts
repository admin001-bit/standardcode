// M6-WP-08：Teams 协议消息生成器 / 解析器 / 配对（DoD① 四类对称 + request_id 配对可回溯；DoD④ 白名单同源）。
//
// 依据：v2.8 ORC-023（行 295）/ §5.3(4) Hook 协议（行 268）/ ORC-050（行 299）；A 级 `claude-code-agent-teams.md`
//   §6.1（字段白名单 L37104）/ §6.2（类型判定与生成 L56327-56331、L56485-56520）/ §6.3（处理链 L175784、L176009-176018）。
//
// [自定] 裁决（WP-08 卡 two-mismatch，作者登记，禁止伪装 [CC]）：
//   (a) shutdown 应答在证据中为两个离散型 `shutdown_approved`/`shutdown_rejected`（L56327-56331）；本卡统一为
//       `shutdown_response` + 布尔 `approve`（与白名单键 `approve` 一致），四类（request/response 对称）行文。
//   (b) 证据的富字段 `planFilePath`/`planContent`/`timestamp`/`from`/`reason` 不在白名单 `Zrt`
//       （=`SEND_MESSAGE_PROTOCOL_FIELDS`，L37104）内。**硬要求：本卡四类协议对象的键集 MUST ⊆
//       `SEND_MESSAGE_PROTOCOL_FIELDS`（type/recipient/content/request_id/approve）**——理由=与 DoD④ 白名单同源且
//       必须能原样穿过 SendMessage 结构化通路。富信息一律折进 `content`（内容为字符串；计划正文/拒绝理由/反馈均作
//       `content` 文本），`from` 由投递层信封（`MailboxEntry.from`）承载而非协议体。

import { SEND_MESSAGE_PROTOCOL_FIELDS } from "./send-message.ts";

/** 四类协议消息类型（request/response 对称）。 */
export const TEAMS_PROTOCOL_TYPES = [
  "shutdown_request",
  "shutdown_response",
  "plan_approval_request",
  "plan_approval_response",
] as const;

export type TeamsProtocolType = (typeof TEAMS_PROTOCOL_TYPES)[number];

const PROTOCOL_FIELD_SET: ReadonlySet<string> = new Set(SEND_MESSAGE_PROTOCOL_FIELDS);

const REQUEST_TYPES: ReadonlySet<TeamsProtocolType> = new Set<TeamsProtocolType>([
  "shutdown_request",
  "plan_approval_request",
]);
const RESPONSE_TYPES: ReadonlySet<TeamsProtocolType> = new Set<TeamsProtocolType>([
  "shutdown_response",
  "plan_approval_response",
]);

/** request 型 → 其合法 response 型（跨类型错配判定）。 */
const RESPONSE_OF: Readonly<Record<"shutdown_request" | "plan_approval_request", TeamsProtocolType>> = {
  shutdown_request: "shutdown_response",
  plan_approval_request: "plan_approval_response",
};

// —— 构造器产物类型（键集 ⊆ 白名单）——
export interface ProtocolShutdownRequest {
  readonly type: "shutdown_request";
  readonly request_id: string;
  /** 折进 content：shutdown 理由文本（[自定] (b)）。 */
  readonly content: string;
  readonly recipient?: string;
}
export interface ProtocolShutdownResponse {
  readonly type: "shutdown_response";
  readonly request_id: string;
  readonly approve: boolean;
  /** 折进 content：可选说明文本。 */
  readonly content?: string;
  readonly recipient?: string;
}
export interface ProtocolPlanApprovalRequest {
  readonly type: "plan_approval_request";
  readonly request_id: string;
  /** 折进 content：计划正文文本（[自定] (b)：planContent 折入）。 */
  readonly content: string;
  readonly recipient?: string;
}
export interface ProtocolPlanApprovalResponse {
  readonly type: "plan_approval_response";
  readonly request_id: string;
  readonly approve: boolean;
  /** 折进 content：反馈文本（[自定] (b)：feedback 折入）。 */
  readonly content?: string;
  readonly recipient?: string;
}

export type TeamsProtocolRequest = ProtocolShutdownRequest | ProtocolPlanApprovalRequest;
export type TeamsProtocolResponse = ProtocolShutdownResponse | ProtocolPlanApprovalResponse;
export type TeamsProtocolMessage =
  | ProtocolShutdownRequest
  | ProtocolShutdownResponse
  | ProtocolPlanApprovalRequest
  | ProtocolPlanApprovalResponse;

export function isTeamsProtocolType(value: unknown): value is TeamsProtocolType {
  return typeof value === "string" && (TEAMS_PROTOCOL_TYPES as readonly string[]).includes(value);
}
export function isTeamsProtocolRequest(value: TeamsProtocolMessage): value is TeamsProtocolRequest {
  return REQUEST_TYPES.has(value.type);
}
export function isTeamsProtocolResponse(value: TeamsProtocolMessage): value is TeamsProtocolResponse {
  return RESPONSE_TYPES.has(value.type);
}

// —— request_id 生成（可注入，稳定可测）——
let _seq = 0;
/** 缺省 id 生成器：[自定] 形 `wp08-req-<time36>-<seq36>`（测试可注入固定值）。 */
export function defaultProtocolIdGen(): string {
  _seq += 1;
  return `wp08-req-${Date.now().toString(36)}-${_seq.toString(36)}`;
}

interface BuildCommon {
  request_id?: string;
  content?: string;
  recipient?: string;
  idGen?: () => string;
}

/** 构造 shutdown_request（content=理由文本；request_id 缺省由 idGen 产生）。 */
export function buildShutdownRequest(opts: BuildCommon = {}): ProtocolShutdownRequest {
  const idGen = opts.idGen ?? defaultProtocolIdGen;
  const msg: ProtocolShutdownRequest = {
    type: "shutdown_request",
    request_id: opts.request_id ?? idGen(),
    content: opts.content ?? "",
  };
  if (opts.recipient !== undefined) (msg as { recipient?: string }).recipient = opts.recipient;
  return msg;
}

/** 构造 shutdown_response（approve 必填布尔；content=可选说明）。 */
export function buildShutdownResponse(opts: {
  request_id: string;
  approve: boolean;
  content?: string;
  recipient?: string;
}): ProtocolShutdownResponse {
  const msg: ProtocolShutdownResponse = {
    type: "shutdown_response",
    request_id: opts.request_id,
    approve: opts.approve,
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(opts.recipient !== undefined ? { recipient: opts.recipient } : {}),
  };
  return msg;
}

/** 构造 plan_approval_request（content=计划正文文本；request_id 缺省由 idGen 产生）。 */
export function buildPlanApprovalRequest(opts: BuildCommon = {}): ProtocolPlanApprovalRequest {
  const idGen = opts.idGen ?? defaultProtocolIdGen;
  const msg: ProtocolPlanApprovalRequest = {
    type: "plan_approval_request",
    request_id: opts.request_id ?? idGen(),
    content: opts.content ?? "",
    ...(opts.recipient !== undefined ? { recipient: opts.recipient } : {}),
  };
  return msg;
}

/** 构造 plan_approval_response（approve 必填布尔；content=反馈文本）。 */
export function buildPlanApprovalResponse(opts: {
  request_id: string;
  approve: boolean;
  content?: string;
  recipient?: string;
}): ProtocolPlanApprovalResponse {
  const msg: ProtocolPlanApprovalResponse = {
    type: "plan_approval_response",
    request_id: opts.request_id,
    approve: opts.approve,
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(opts.recipient !== undefined ? { recipient: opts.recipient } : {}),
  };
  return msg;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ParseProtocolResult =
  | { ok: true; message: TeamsProtocolMessage }
  | { ok: false; error: string };

/**
 * 解析协议消息：非对象 / 缺空 `type` / 未知 type / 越界键 / 缺 request_id / response 缺布尔 approve ——
 * **全部点名报错，禁静默**。合法时返回浅克隆（保留所有键），保证 round-trip 对称。
 */
export function parseProtocolMessage(value: unknown): ParseProtocolResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "protocol message must be a plain object" };
  }
  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, error: "protocol message must carry a non-empty string `type`" };
  }
  if (!isTeamsProtocolType(type)) {
    return { ok: false, error: `unknown protocol type \`${type}\` (allowed: ${TEAMS_PROTOCOL_TYPES.join(", ")})` };
  }
  for (const key of Object.keys(value)) {
    if (!PROTOCOL_FIELD_SET.has(key)) {
      return {
        ok: false,
        error: `unknown protocol field \`${key}\` (allowed: ${SEND_MESSAGE_PROTOCOL_FIELDS.join(", ")})`,
      };
    }
  }
  const requestId = value.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ok: false, error: "protocol message must carry a non-empty string `request_id`" };
  }
  if (isTeamsProtocolResponse({ ...value, type } as unknown as TeamsProtocolMessage)) {
    if (typeof value.approve !== "boolean") {
      return { ok: false, error: `protocol response \`${type}\` must carry a boolean \`approve\`` };
    }
  }
  // 浅克隆保留所有（已校验）键，round-trip 深等于 build 产物。
  return { ok: true, message: { ...value } as unknown as TeamsProtocolMessage };
}

// —— 配对（request_id 可回溯；未知 id / 二次 settle / 跨类型错配 抛错点名）——
export interface ProtocolPairing {
  /** 开一个请求，返回其 request_id（request_id 必须唯一，重复开抛错点名）。 */
  open(request: TeamsProtocolRequest): string;
  /** 枚举在途（未 settle）请求。 */
  pending(): ReadonlyArray<{ request_id: string; request: TeamsProtocolRequest; type: TeamsProtocolType }>;
  /** 结算一个响应；未知 id / 二次 settle / 跨类型错配 抛错点名。 */
  settle(requestId: string, response: TeamsProtocolMessage): { request: TeamsProtocolRequest; response: TeamsProtocolResponse };
}

export function createProtocolPairing(): ProtocolPairing {
  const open2 = new Map<string, TeamsProtocolRequest>();
  return {
    open(request) {
      if (!REQUEST_TYPES.has(request.type)) {
        throw new Error(`protocol pairing: cannot open non-request type \`${request.type}\``);
      }
      if (open2.has(request.request_id)) {
        throw new Error(`protocol pairing: duplicate open request_id \`${request.request_id}\``);
      }
      open2.set(request.request_id, request);
      return request.request_id;
    },
    pending() {
      return [...open2.entries()].map(([request_id, request]) => ({ request_id, request, type: request.type }));
    },
    settle(requestId, response) {
      const request = open2.get(requestId);
      if (!request) {
        throw new Error(`protocol pairing: unknown request_id \`${requestId}\` (no matching open request to settle)`);
      }
      const expected = RESPONSE_OF[request.type as "shutdown_request" | "plan_approval_request"];
      if (response.type !== expected) {
        throw new Error(
          `protocol pairing: type mismatch for request_id \`${requestId}\` — request \`${request.type}\` expects response \`${expected}\` but got \`${response.type}\``,
        );
      }
      open2.delete(requestId); // 二次 settle → 此后变 unknown id，抛错点名
      return { request, response: response as TeamsProtocolResponse };
    },
  };
}

// —— 后果文案常量（英文，与既有面一致；中文注释说明例外后果）——
export const TEAMS_PROTOCOL_CONSEQUENCES = {
  /** 批准 shutdown：该 teammate 终止自己。 */
  shutdownApproved:
    "APPROVED shutdown_request — this teammate terminates itself (approved by model decision).",
  /** 拒绝 shutdown：不终止，继续运行。 */
  shutdownRejected: "REJECTED shutdown_request — this teammate continues running; no termination is performed.",
  /** 批准 plan：发起方（lead）按批准推进计划。 */
  planApproved: "APPROVED plan_approval_request — the requester (team lead) may proceed with the plan.",
  /** 拒绝 plan：发起方（lead）继续修改计划（DoD③/④ 双路）。 */
  planRejected: "REJECTED plan_approval_request — the requester (team lead) continues modifying the plan.",
} as const;
