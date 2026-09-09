// WP-11：/config 写 local 层的专用函数（与 WP-07 persistAlwaysAllow 同形制；坏 JSON 不覆盖）。
// settings.local.json 是唯一可写层（ADR-0030/ADR-0037 语义：项目 local=用户显式操作面）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { settingsSourcePaths } from "@standardcode/platform";

/** 写 local 层单键（点路径；value=JSON 值）。返回落盘路径。 */
export function setLocalSetting(projectRoot: string, key: string, value: unknown, file?: string): string {
  const target = file ?? settingsSourcePaths(projectRoot).projectLocal;
  let doc: Record<string, unknown> = { schemaVersion: 1 };
  if (existsSync(target)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      throw new Error(`settings.local.json invalid JSON; refusing to overwrite (fix the file first): ${target}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`settings.local.json is not a JSON object; refusing to overwrite: ${target}`);
    }
    doc = parsed as Record<string, unknown>;
  }
  // 点路径写入（叶子赋值；中间层为对象）
  const segs = key.split(".");
  let cur = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (cur[seg] === null || typeof cur[seg] !== "object" || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
  doc.schemaVersion = 1;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return target;
}
