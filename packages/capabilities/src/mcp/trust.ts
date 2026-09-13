// WP-03：S-3 MCP 供应链批准状态机+门控纯函数（无 fs——留痕读写落 platform mcp-trust，M3 WP-09 分层先例）。
// 形状出处：[CC] XPt `_440.js:153552-153560`（disabledMcpjsonServers→rejected 恒赢；enabledMcpjsonServers/
// enableAllProjectMcpServers→approved 且信任无关——DQn `_440.js:153540-153551` 分支先于信任）；ZPt `_440.js:153561-153568`
//（pending+目录信任→approved，dig-05 §7"目录信任已建立"）；未批准不进合并 `_440.js:154575-154589`（nxt 只收 approved）；
// Z1e `_440.js:154480-154492`（单服务器解析 project 需已批准，否则回落低来源——本实现经 docs 级剔除自然获得该回落）。
// enable/disable 停用开关与 approve/reject 批准决定正交两键位 [自定]（[CC] 无四动词逐字形态可考；reject/disable
// 名单对任意来源生效、approved 门仅 projectShared 层——fail-closed 方向）。
import { MCP_SOURCE_ORDER, type McpSourceName } from "./config.ts";

/** local 层留痕记录（settings.local.json `mcpTrust` 映射值；platform mcp-trust 结构镜像，测试钉住）。 */
export interface McpTrustRecord {
  /** S-3 批准决定（approve/reject 落点；reject 恒赢——:153553 形状）。 */
  decision?: "approved" | "rejected";
  /** 用户停用开关（enable/disable 落点；[自定]，与 decision 正交）。 */
  disabled?: boolean;
  /** S-3"来源持久记录"：传输+命令或 URL（approve 时从解析前快照）。 */
  transport?: "stdio" | "sse" | "http";
  command?: string;
  url?: string;
  confirmedAt?: string;
}
export type McpTrustMap = Record<string, McpTrustRecord>; // key=server 名小写归一（agentTrust 同构）

export type McpApprovalState = "approved" | "rejected" | "disabled" | "pending";

/** 批准状态机（卡 DoD②：reject 名单 > enableAllProjectMcpServers > 工作区信任已确认 → approved，否则 pending）。 */
export function resolveServerApproval(input: {
  origin: McpSourceName;
  record?: McpTrustRecord;
  trusted: boolean;
  enableAllProjectMcpServers?: boolean;
}): McpApprovalState {
  if (input.record?.decision === "rejected") return "rejected"; // reject 名单恒赢（任何来源）
  if (input.record?.disabled === true) return "disabled"; // 用户停用恒赢（任何来源）[自定]
  if (input.origin !== "projectShared") return "approved"; // local/user/flag/managed 无 S-3 门（Z1e :154488 local 直胜形状）
  if (input.record?.decision === "approved") return "approved"; // 逐 server 批准（信任无关，DQn :153540-153551 分支形状）
  if (input.enableAllProjectMcpServers === true) return "approved"; // :153556-153557 || 形状
  if (input.trusted) return "approved"; // 工作区信任已确认（ZPt :153561-153568 形状）
  return "pending"; // S-3 安装即确认：默认不生效
}

export interface McpGateEntryState {
  name: string;
  origin: McpSourceName;
  state: McpApprovalState;
}

export interface McpGateResult {
  /** 门控后 docs（非 approved 条目剔除；低来源同名定义自然回落——Z1e :154480-154492 形状）。 */
  docs: Partial<Record<McpSourceName, Record<string, unknown> | null>>;
  /** 逐来源逐 server 批准态（/mcp list 消费）。 */
  states: McpGateEntryState[];
  /** 被剔除条目（审计面）。 */
  dropped: McpGateEntryState[];
}

/**
 * docs 级门控（S-3：未批准项目级 server 不进合并结果，:154575-154589 形状）。
 * 仅动各层 doc 的 mcpServers 键；坏条目原样保留（loader 侧既有告警语义不重复）。
 */
export function gateMcpServerDocs(input: {
  docs: Partial<Record<McpSourceName, Record<string, unknown> | null>>;
  trusted: boolean;
  enableAllProjectMcpServers?: boolean;
  records: McpTrustMap;
}): McpGateResult {
  const docs = { ...input.docs };
  const states: McpGateEntryState[] = [];
  const dropped: McpGateEntryState[] = [];
  for (const source of MCP_SOURCE_ORDER) {
    const doc = docs[source];
    if (!doc) continue;
    const mcpServers = doc.mcpServers;
    if (mcpServers === undefined) continue;
    if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) continue;
    const kept: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        kept[name] = raw; // 坏条目留给 loader 报告警
        continue;
      }
      const state = resolveServerApproval({
        origin: source,
        record: input.records[name.toLowerCase()],
        trusted: input.trusted,
        enableAllProjectMcpServers: input.enableAllProjectMcpServers,
      });
      states.push({ name, origin: source, state });
      if (state === "approved") kept[name] = raw;
      else dropped.push({ name, origin: source, state });
    }
    docs[source] = { ...doc, mcpServers: kept };
  }
  return { docs, states, dropped };
}
