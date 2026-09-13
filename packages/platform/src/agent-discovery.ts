// WP-09（M3）：项目级 agent 定义磁盘发现（.standardcode/agents/*.md）+ SEC-070 local 层留痕读写。
// 分层：解析/门控纯函数在 harness（agent-definitions.ts）；磁盘枚举与 settings.local.json 读写在本模块
// （platform=持久化层先例：transcripts/trust/persistAlwaysAllow）。卡交付物字面 "packages/harness …" 的路径
// 差登记为结果页偏差。
// 形状出处：递归收集 .md=[CC] `ebo` _440.js:46444-46459（inode 去重未实现——偏差登记）；
// 写 local=ADR-0037 形制（坏 JSON 拒覆盖、schemaVersion:1、追加式合并）。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAgentMarkdown, type AgentTrustRecord, type ParsedAgentFile } from "@standardcode/harness";
import { settingsSourcePaths } from "./settings.ts";

/** 项目级 agent 定义目录（SEC-070 原文 `.standardcode/agents/*.md`）。 */
export function projectAgentsDir(projectRoot: string): string {
  return path.join(projectRoot, ".standardcode", "agents");
}

function collectMarkdown(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在=无项目级定义（常态，非错误）
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectMarkdown(p, out); // [CC] v1 递归收集同构
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
}

export interface ProjectAgentFiles {
  /** 逐文件解析产物（def=null=拒收件；告警继续在调用方）。 */
  parsed: ParsedAgentFile[];
  /** 汇总告警（含 ENG-080 迁移提示、坏件、丢键）。 */
  warnings: string[];
}

/** 枚举+解析项目级 agent .md（信任门不在本函数——消费方 gateProjectAgentDefinitions，SEC-070）。 */
export function loadProjectAgentDefinitions(projectRoot: string, dir = projectAgentsDir(projectRoot)): ProjectAgentFiles {
  const files: string[] = [];
  collectMarkdown(dir, files);
  files.sort(); // 枚举序稳定（后写覆盖语义的确定性前提）
  const parsed: ParsedAgentFile[] = [];
  const warnings: string[] = [];
  for (const f of files) {
    const rel = path.relative(projectRoot, f);
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch (err) {
      warnings.push(`${rel}: unreadable (${err instanceof Error ? err.message : String(err)}) — skipped`);
      continue; // DoD④：单件失败告警继续
    }
    const p = parseAgentMarkdown(text, rel);
    parsed.push(p);
    warnings.push(...p.warnings);
  }
  return { parsed, warnings };
}

// —— SEC-070 local 层留痕（settings.local.json `agentTrust` 映射）——

/** 读 local 层 doc（坏 JSON/非对象抛错——写侧保守，读侧消费方 fail-open；WP-03 mcp-trust 复用）。 */
export function readLocalDoc(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { schemaVersion: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`settings.local.json invalid JSON; refusing to overwrite (fix the file first): ${file}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`settings.local.json is not a JSON object; refusing to overwrite: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

/** 读 local 层提权留痕（键=name 小写归一）；无文件/坏 JSON=空记录（读侧 fail-open，写侧保守）。 */
export function readAgentTrust(projectRoot: string, file = settingsSourcePaths(projectRoot).projectLocal): Record<string, AgentTrustRecord> {
  let doc: Record<string, unknown>;
  try {
    doc = readLocalDoc(file);
  } catch {
    return {};
  }
  const at = doc.agentTrust;
  const out: Record<string, AgentTrustRecord> = {};
  if (at !== null && typeof at === "object" && !Array.isArray(at)) {
    for (const [k, v] of Object.entries(at as Record<string, unknown>)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) out[k.toLowerCase()] = v as AgentTrustRecord;
    }
  }
  return out;
}

/** 写/更新一件留痕（确认动作落点；ADR-0037 形制=坏 JSON 拒覆盖+追加式合并+schemaVersion:1）。 */
export function recordAgentTrust(projectRoot: string, name: string, record: AgentTrustRecord, file = settingsSourcePaths(projectRoot).projectLocal): void {
  const doc = readLocalDoc(file);
  const at = (doc.agentTrust !== null && typeof doc.agentTrust === "object" && !Array.isArray(doc.agentTrust) ? doc.agentTrust : {}) as Record<string, unknown>;
  at[name.toLowerCase()] = record;
  doc.agentTrust = at;
  doc.schemaVersion = 1;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
}
