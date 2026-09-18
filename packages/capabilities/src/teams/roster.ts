// M6-WP-07：团队/成员注册表 + 命名校验 + 通讯录（可寻址名单）。
//
// 依据：v2.8 ORC-023（行 295"Agent Teams"）+ Q-4（行 578）；接缝⑳。
// 逐字锚点（A 级 `claude-code-agent-teams.md`）：
//   §3.1 team_name 校验（`_440.js` L176871-176879）：
//     "Invalid team_name: control characters are not allowed in agent or team names"
//     ——控制字符禁令同时覆盖 team 名与 agent（成员）名（原文措辞 "agent or team names"）。
//   §3.2 成员命名：保留名与去重（`mlr(...)`，L176949-176960）：
//     `"main" is a reserved recipient name (SendMessage routes it to the main conversation) — choose another teammate name.`
//     重名**自动加后缀** `-2`、`-3`…（大小写不敏感比较，算法逐字同构）。
//   §3.3 spawn 侧名字冲突保护（L176953、L177717）：
//     `"${"main"}" is reserved — SendMessage routes it to the main conversation`
//     name 参数描述（L177717）："Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running."
//   §9 通讯录（L179075/L179120）：spawn 结果寻址提示——agentId 为内部 ID 不向用户暴露。
//
// [自定] 口径（供 V 核验）：
//   ① 空 team 名 / 空成员名的拒绝（A 级只给控制字符文案；空名必须拒绝=fail-closed），文案 [自定]。
//   ② agentId 生成形 `a<12hex>-<4hex>`（A 级 §2.2 只给格式 `a...-...`；具体长度未定位）。
//   ③ spawn 重名**不拒绝**（§2.2 逐字 "or when a newer agent took the name (latest wins)"——重名允许，最新者胜）；
//      spawn 侧保护只拦保留名与非法字符。成员注册表（teammate 面）重名才走 §3.2 自动去重后缀。
//   ④ 通讯录可寻址集额外含 lead 别名 "team-lead"（A 级 §2.2 协议响应示例逐字 `{"to": "team-lead", ...}` 与
//      §4.1 `M.request?.from || "team-lead"`——teammate 回信 lead 的可达面），与 "main" 同一落点（lead 即主对话）。
//   ⑤ 寻址精确匹配（大小写敏感）——§3.2 的大小写不敏感仅用于**去重**，寻址面 [CC] 无证据，保守精确。
//   ⑥ lead 缺省团名 "default"（A 级 team_name 取值未定位）；装配层可传合法名覆写，仍过 validateTeamName。
//   ⑦ inbox 文件命名规则 A 级未定位（§12 未解②）→ mailbox.ts 头注登记，本模块不臆造 [CC] 路径。

import { randomUUID } from "node:crypto";
import { SEND_MESSAGE_MAIN_RECIPIENT, SEND_MESSAGE_FAILURES, type SendMessagePort } from "./send-message.ts";
import { TEAMMATE_DEFAULT_LEAD_NAME } from "./events.ts";

/** lead 别名（[自定]④：A 级 §2.2 协议响应示例 `{"to": "team-lead", ...}` 逐字值）。 */
export const TEAM_LEAD_ADDRESS = "team-lead";

/** team_name / 成员名共用的控制字符禁令（A 级 §3.1 L176871 文案逐字）。 */
export const TEAM_NAME_CONTROL_CHARS_ERROR =
  "Invalid team_name: control characters are not allowed in agent or team names";

/** 保留名拒绝（A 级 §3.2 L176949 文案逐字，成员注册侧）。 */
export const TEAM_NAME_RESERVED_ERROR =
  '"main" is a reserved recipient name (SendMessage routes it to the main conversation) — choose another teammate name.';

/** spawn 侧保留名保护（A 级 §3.3 L176953 文案逐字模板落形）。 */
export const SPAWN_NAME_RESERVED_ERROR =
  '"main" is reserved — SendMessage routes it to the main conversation';

/** [自定]①：空名拒绝文案。 */
export const TEAM_NAME_EMPTY_ERROR = "Invalid name: must be a non-empty string";

function hasControlChars(raw: string): boolean {
  // 控制字符 = C0（U+0000-001F）+ DEL（U+007F）；A 级未给正则，取最小集 [自定]。
  return /[\u0000-\u001f\u007f]/.test(raw);
}

/** team_name 创建校验（DoD①：空/非法字符拒绝）。返回 null=合法，否则为拒绝原因（机器可读文案）。 */
export function validateTeamName(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return TEAM_NAME_EMPTY_ERROR;
  if (hasControlChars(name)) return TEAM_NAME_CONTROL_CHARS_ERROR;
  return null;
}

/** spawn 侧名字冲突保护（DoD②；A 级 §3.3）。返回 null=可寻址合法名，否则为拒绝文案。 */
export function spawnNameGuard(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return TEAM_NAME_EMPTY_ERROR;
  if (name === SEND_MESSAGE_MAIN_RECIPIENT) return SPAWN_NAME_RESERVED_ERROR;
  if (hasControlChars(name)) return TEAM_NAME_CONTROL_CHARS_ERROR;
  return null; // 重名不拒绝（[自定]③：latest wins，§2.2 逐字）
}

/** [自定]②：agentId 生成（A 级 §2.2 格式 `a...-...`）。 */
export function generateAgentId(): string {
  const hex = randomUUID().replace(/-/g, "");
  return `a${hex.slice(0, 12)}-${hex.slice(12, 16)}`;
}

/**
 * spawn 结果寻址提示（DoD④；A 级 §9 L179075 **逐字**）：
 * `agentId: ${e.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${e.agentId}', summary: '<5-10 word recap>' to continue this agent.)`
 * ——agentId 为内部 ID 不向用户暴露。装配点=spawn 结果组装（本仓 spawn 走 /subtask 程序面，WP-06 偏差⑥同形：
 * 本卡交付纯函数变换面，供装配层/运行器消费）。
 */
export function spawnAddressingNote(init: { agentId: string }): string {
  return `agentId: ${init.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${init.agentId}', summary: '<5-10 word recap>' to continue this agent.)`;
}

export interface TeamMember {
  /** 最终注册名（重名时为自动去重后的 `-2`/`-3` 形）。 */
  name: string;
  agentId: string;
  /** 入队时是否触发了去重改名（DoD② 断言面）。 */
  deduped: boolean;
}

export interface TeamRoster {
  readonly teamName: string;
  /** 成员视图（注册序；不含 lead）。 */
  members(): readonly TeamMember[];
  /** 注册成员（DoD②：main 拒绝 + 大小写不敏感去重）。返回最终名。 */
  addMember(name: string, opts?: { agentId?: string }): TeamMember;
  /** 按 agentId 查成员（通讯录 agentId 寻址面）。 */
  byAgentId(agentId: string): TeamMember | null;
  /** 通讯录解析（DoD④）：main/lead 别名 → main；成员名/agentId → member；其余 → unknown。 */
  resolve(to: string): { kind: "main" } | { kind: "member"; member: TeamMember } | { kind: "unknown" };
  /** 可寻址集（DoD④：成员名与 agentId；"main" 恒在内；lead 别名 [自定]④）。顺序稳定（注册序，别名在前）。 */
  addressable(): readonly string[];
}

/** A 级 §3.2 `mlr` 去重算法的同构落形：重名（大小写不敏感）自动 `-2`/`-3` 后缀。 */
export function dedupeMemberName(name: string, takenLower: ReadonlySet<string>): { name: string; deduped: boolean } {
  if (!takenLower.has(name.toLowerCase())) return { name, deduped: false };
  let n = 2;
  while (takenLower.has(`${name}-${n}`.toLowerCase())) n++;
  return { name: `${name}-${n}`, deduped: true };
}

/** 团队注册表（lead 会话侧；成员注册走 §3.2 规则）。 */
export function createTeamRoster(init: { teamName: string }): TeamRoster {
  const invalid = validateTeamName(init.teamName);
  if (invalid) throw new Error(invalid);
  const teamName = init.teamName;
  const members: TeamMember[] = [];
  const byName = new Map<string, TeamMember>(); // 原名精确键（寻址面：addressable ⊆ resolvable 不变量）
  const byNameLower = new Map<string, TeamMember>(); // 小写键（仅 §3.2 去重面）
  const byId = new Map<string, TeamMember>();

  const addMember = (name: string, opts?: { agentId?: string }): TeamMember => {
    if (name === SEND_MESSAGE_MAIN_RECIPIENT) throw new Error(TEAM_NAME_RESERVED_ERROR);
    if (typeof name !== "string" || name.length === 0) throw new Error(TEAM_NAME_EMPTY_ERROR);
    if (hasControlChars(name)) throw new Error(TEAM_NAME_CONTROL_CHARS_ERROR);
    const dedup = dedupeMemberName(name, new Set(byNameLower.keys()));
    const member: TeamMember = { name: dedup.name, agentId: opts?.agentId ?? generateAgentId(), deduped: dedup.deduped };
    members.push(member);
    byName.set(member.name, member);
    byNameLower.set(member.name.toLowerCase(), member);
    byId.set(member.agentId, member);
    return member;
  };

  const resolve = (to: string): ReturnType<TeamRoster["resolve"]> => {
    if (to === SEND_MESSAGE_MAIN_RECIPIENT || to === TEAM_LEAD_ADDRESS) return { kind: "main" };
    const byIdHit = byId.get(to);
    if (byIdHit) return { kind: "member", member: byIdHit };
    const byNameHit = byName.get(to); // 原名精确匹配（[自定]⑤：与 addressable 同域——注册名原样可寻址必可解析）
    if (byNameHit) return { kind: "member", member: byNameHit };
    return { kind: "unknown" };
  };

  return {
    teamName,
    members: () => [...members],
    addMember,
    byAgentId: (agentId) => byId.get(agentId) ?? null,
    resolve,
    addressable: () => [
      SEND_MESSAGE_MAIN_RECIPIENT,
      TEAM_LEAD_ADDRESS,
      ...members.flatMap((m) => [m.name, m.agentId]),
    ],
  };
}

// —— 通讯录 × SendMessagePort 适配（WP-06 遗留②④的落点：to:"main" 路由落点 + 工具投递口）——

/** 成员投递落点载荷（装配层接 mailbox 文件/in-process 泵）。 */
export interface MemberDelivery {
  /** 收件成员（resolve 命中）。 */
  member: TeamMember;
  /** 按收件人名寻址时=该名（重名 agentId 寻址时=注册名）。 */
  to: string;
  entry: {
    from: string;
    text: string;
    summary?: string;
    color?: string;
    sentAt: string;
    /** 结构化协议原物（纯文本消息无此字段）。 */
    message?: unknown;
  };
}

export interface RosterSendMessagePortOptions {
  roster: TeamRoster;
  /** 发送者名（写进条目 from；lead 面装配=TEAMMATE_DEFAULT_LEAD_NAME，teammate 面=该成员名）。 */
  from: string;
  /** main/lead 别名的投递落点（装配层接主对话 drain 缓冲；渲染后文本）。 */
  deliverToMain(text: string, meta: { from: string; summary?: string }): void;
  /** 成员投递落点（装配层接 mailbox 持久化/in-process 泵）。 */
  deliverToMember(delivery: MemberDelivery): void;
  /** 渲染器注入（默认=formatTeammateMessage 同构；避免 events↔roster 循环依赖由调用方传）。 */
  format?: (envelope: { from: string; text: string; summary?: string; color?: string }) => string;
}

/**
 * 通讯录投递口（WP-06 `SendMessagePort` 消费形制）：
 * - `to` 可寻址集 = roster.addressable()（DoD④：成员名 + agentId + "main" [+ lead 别名]）；
 * - `"main"`（与 lead 别名）**恒路由主对话**（DoD④；Q-4 载体面）；
 * - 成员/agentId → `deliverToMember`（mailbox 持久化落点，BLK-07=① 跨 teammate 载体）；
 * - 未知名 → 传输层原因 `unreachable-namespace`（经 WP-06 `classifySendFailure` 归一为 `not_reachable`）。
 */
export function createRosterSendMessagePort(
  options: RosterSendMessagePortOptions,
): SendMessagePort & { roster: TeamRoster; addressable(): readonly string[] } {
  const format = options.format ?? ((e) => (e.summary ? `[${e.summary}]\n${e.from}: ${e.text}` : `${e.from}: ${e.text}`));
  return {
    roster: options.roster,
    addressable: () => options.roster.addressable(),
    async send(input: { to: string; message: unknown; notifyWhenIdle?: boolean }): Promise<string | null> {
      const route = options.roster.resolve(input.to);
      if (route.kind === "unknown") return "unreachable-namespace";
      if (route.kind === "main") {
        // DoD④："main" 恒路由主对话（lead 别名同落点）。渲染=A 级 §4.1 j3({from,text}) 调用形（无 summary/color）。
        const text = typeof input.message === "string" ? input.message : JSON.stringify(input.message);
        options.deliverToMain(format({ from: options.from, text }), { from: options.from });
        return null;
      }
      const message = input.message;
      options.deliverToMember({
        member: route.member,
        to: input.to,
        entry: {
          from: options.from,
          text: typeof message === "string" ? message : JSON.stringify(message),
          sentAt: new Date().toISOString(),
          ...(typeof message === "object" && message !== null ? { message } : {}),
        },
      });
      return null;
    },
  };
}

/** 失败分类全集（再导出，装配层/测试免跨模块取数）。 */
export { SEND_MESSAGE_FAILURES };
