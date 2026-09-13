// WP-03：S-3 MCP 供应链 local 层留痕读写（settings.local.json `mcpTrust` 映射；ADR-0037 形制=坏 JSON 拒覆盖+
// 追加式合并+schemaVersion:1；agentTrust 同构，M3 WP-09 先例）。platform 不依赖 capabilities——记录类型此处
// 自持（结构镜像 capabilities/mcp/trust.ts McpTrustRecord，cli 集成测试钉住两形键位一致）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readLocalDoc } from "./agent-discovery.ts";
import { settingsSourcePaths } from "./settings.ts";

/** 留痕记录（键位镜像 capabilities/mcp/trust.ts——approve/reject=decision；enable/disable=disabled；S-3 来源快照=transport/command/url）。 */
export interface McpTrustRecord {
  decision?: "approved" | "rejected";
  disabled?: boolean;
  transport?: "stdio" | "sse" | "http";
  command?: string;
  url?: string;
  confirmedAt?: string;
}
export type McpTrustMap = Record<string, McpTrustRecord>; // key=server 名小写归一

/** 读 local 层 MCP 批准留痕；无文件/坏 JSON=空记录（读侧 fail-open，agentTrust 同构）。 */
export function readMcpTrust(projectRoot: string, file = settingsSourcePaths(projectRoot).projectLocal): McpTrustMap {
  let doc: Record<string, unknown>;
  try {
    doc = readLocalDoc(file);
  } catch {
    return {};
  }
  const mt = doc.mcpTrust;
  const out: McpTrustMap = {};
  if (mt !== null && typeof mt === "object" && !Array.isArray(mt)) {
    for (const [k, v] of Object.entries(mt as Record<string, unknown>)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) out[k.toLowerCase()] = v as McpTrustRecord;
    }
  }
  return out;
}

/** 写/更新一件留痕（approve/reject/enable/disable 落点；ADR-0037 形制=坏 JSON 拒覆盖+追加式合并+schemaVersion:1）。 */
export function recordMcpTrust(projectRoot: string, name: string, record: McpTrustRecord, file = settingsSourcePaths(projectRoot).projectLocal): void {
  const doc = readLocalDoc(file);
  const mt = (doc.mcpTrust !== null && typeof doc.mcpTrust === "object" && !Array.isArray(doc.mcpTrust) ? doc.mcpTrust : {}) as Record<string, unknown>;
  mt[name.toLowerCase()] = record;
  doc.mcpTrust = mt;
  doc.schemaVersion = 1;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
}
