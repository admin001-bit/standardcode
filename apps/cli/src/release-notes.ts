// M7-WP-08：/release-notes 数据源约定（[自定]，mini-ADR 落 docs/adr/0048-release-notes-data-source.md）。
//
// 读法（卡内定并登记）：数据源=**项目根 `CHANGELOG.md`**（`join(session.cwd, "CHANGELOG.md")`）。
//   · 节头形 `## <version>`（如 `## 2.1.0` 或 `## v2.1.0`，`v` 前缀可选；`###` 不视为节头）；
//   · 节头下每一非空行即该版本的条目行（条目行不限 `-` 前缀——本仓约定用 `-`，但解析不为此设限）；
//   · 一级标题 `# Changelog` 等节外内容忽略。
// 语义：无参=展示当前版本（`CLI_VERSION` 单源）与其条目；带参=按版本号选节（精确命中优先，其次唯一前缀命中）。
//   **文件缺省/版本未命中一律明报（不得静默返回空）**；**禁止臆造历史条目**——本模块只解析数据源既有文本。
//
// [CC] 锚（evidence 检索，2026-09-23）：`evidence/claude-src-extracted/_440.js:278632`（命令定义
//   `{description:"View release notes", name:"release-notes", type:"local-jsx"}`）与 `_704.js:11`（分类
//   `"release-notes":"info"`=只读信息面）；`evidence/harness参考项目/claude-code/CHANGELOG.md:5723`
//   「New /release-notes command lets you view release notes at any time」、`:3020`「/release-notes is now an
//   interactive version picker」（=版本选择面）、`:863`（只读边界：查看行为不得写入模型上下文）。
//   [CC] 数据源=远端拉取；本仓取**仓内 CHANGELOG.md** 属数据源约定 [自定]（网络请求不属本卡边界）。

/** 数据源文件名（仓根；[自定] 约定）。 */
export const CHANGELOG_FILENAME = "CHANGELOG.md";

export interface ChangelogSection {
  /** 节头里的版本号原文（去 `## ` 前缀后的原样文本，可能带 `v` 前缀）。 */
  version: string;
  /** 该节下的条目行（已去首尾空白；空行忽略）。 */
  entries: string[];
}

/**
 * 解析 CHANGELOG 文本为节列表。仅识别 `## <version>` 形节头；节外内容（含一级标题）忽略；
 * 节头之后至下一节头之间的每一非空行收为该节条目。纯函数（零 IO、零 i18n，便于单测）。
 */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^##(?!#)\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { version: heading[1]!, entries: [] };
      sections.push(current);
      continue;
    }
    if (current && line !== "") current.entries.push(line);
  }
  return sections;
}

/** 版本号规范化（去首尾空白、转小写、去前导 `v`）——用于比较，不改展示文本。 */
export function normalizeVersion(version: string): string {
  return version.trim().toLowerCase().replace(/^v/, "");
}

/** 按版本号选节：精确命中优先；否则唯一前缀命中；命中 0 或 >1 个=undefined（不猜、不静默取值）。 */
export function selectSection(sections: readonly ChangelogSection[], query: string): ChangelogSection | undefined {
  const q = normalizeVersion(query);
  if (q === "") return undefined;
  const exact = sections.find((s) => normalizeVersion(s.version) === q);
  if (exact) return exact;
  const prefixed = sections.filter((s) => normalizeVersion(s.version).startsWith(q));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
