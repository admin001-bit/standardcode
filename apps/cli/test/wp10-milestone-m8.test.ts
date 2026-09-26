// WP-10（M8 收口）收口断言集：①DoD 判据文字与 v2.8 行 116 程序化逐字对质 ②附录 E M8 终态表（11 条，#11 缺口闭合）
// ③CI 对账表（16 run）④接缝㉕㉖ 登记 ⑤偏差分桶计数（M8.md A/B/C 表，逐行解析实测）⑥M7 遗留 23 条 M8 终态分桶
// ⑦命令全集守恒＝35（与 M5 `wp10-milestone`／M6 `wp12-milestone`／M7 `wp14-milestone` 同源互补；本卡=收口时点零增量复核）。
// 判据自足：M8-1 板 WP-10 DoD①–⑥；文件与既有两个同名「wp10-milestone」分属 M5/本卡（跨里程碑同名，2026-09-26 更名 -m8 后缀）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";

/** v2.8 §2 行 116（M8 行）三格原文——逐字硬编码，改一字即红（DoD① 对质面；2026-09-26 由 v2.8 行 116 程序化抄录）。 */
const V28_M8_GOAL = "发布外发收口与遗留清偿";
const V28_M8_SCOPE =
  "GitHub Release（按 tag M7=e8b27f8 重建三平台单文件＋checksum，附录 E 行 630）＋README 安装说明与未签名声明（Q-7 行 586）＋npm 0.1.0 复核；M7 全板遗留 B/C 桶逐条落点：品牌资源 dog-logo 入库（附录 E 品牌资源条款）、harness deny 缺省类型（规格变更，mini-ADR）、teams 关侧判别面、M6 接线义务剩余段（M6-1-results §G）、GitHub 源接线 `/update`（ADR-0050）、根/各包 `package.json` license 字段（Q-9 行 588 卫生建议）、未验证面实跑收窄";
const V28_M8_DOD =
  "①发布外发最小集落地：GitHub Release v0.1.0 在线（三平台单文件按 tag M7=e8b27f8 重建＋`SHA256SUMS.txt`，sha 逐条一致）、产品仓 README 安装说明按步骤装出可运行二进制、npm 0.1.0 在线复核；②M7 全板遗留 B/C 桶 18 条核销或如实登记（环境受阻项以复验＋登记闭合）；③各卡零回归（全量失败∩变更集=∅＋八包 tsc rc=0）；④M8 收口（CI 对账＋seams 增量＋偏差汇总）";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
const M7 = ["goal", "theme", "keybindings", "sandbox", "release-notes"];

const sorted = (xs: readonly string[]) => [...xs].sort();
const readRepo = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

const M8_MD = readRepo("docs/milestones/M8.md");

/** 取 `## ` 节（到下一个二级标题为止）。 */
function section(title: string): string {
  const i = M8_MD.indexOf(title);
  if (i < 0) throw new Error("section not found: " + title);
  const j = M8_MD.indexOf("\n## ", i + 1);
  return M8_MD.slice(i, j < 0 ? M8_MD.length : j);
}
/** 表体逐行解析（条目行=/^\| \d+ \|/；转义竖线 `\|` 不作分隔；格数按表形验，防裸竖线致列错位）。 */
function tableRows(sec: string, cols: number): string[][] {
  const rows = sec
    .split(/\r?\n/)
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => l.split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, "|")));
  for (const r of rows) expect(r.length, `列数须为 ${cols}+2：${r.slice(0, 4).join(" | ")}`).toBe(cols + 2);
  return rows;
}

describe("WP-10 DoD① 判据文字与 v2.8 行 116 程序化逐字对质", () => {
  it("docs/milestones/M8.md 表行三格与 v2.8 行 116 逐字相等；勾验表四勾已勾", () => {
    expect(M8_MD).toContain(`| **M8 维护** | ${V28_M8_GOAL} | ${V28_M8_SCOPE} | ${V28_M8_DOD} |`);
    expect((M8_MD.match(/- \[x\]/g) ?? []).length).toBe(4);
  });
});

describe("WP-10 DoD① 附录 E M8 终态表", () => {
  it("11 条逐行在表；#11 品牌资源结论含 ✓（M7 缺口闭合）；全表无 ✗", () => {
    const sec = section("## 附录 E");
    const rows = tableRows(sec, 4);
    expect(rows).toHaveLength(11);
    expect(rows[10]![3], "#11 结论列须含 ✓").toContain("✓");
    expect(sec).not.toContain("✗");
  });
});

describe("WP-10 DoD② CI 对账表", () => {
  it("16 run 逐行在表（首=36186941764 failure／尾=36250502259 success）", () => {
    const rows = tableRows(section("## CI 对账记录"), 5);
    expect(rows).toHaveLength(16);
    expect(rows[0]![2]).toBe("36186941764");
    expect(rows[0]![5]).toContain("failure");
    expect(rows[15]![2]).toBe("36250502259");
    expect(rows[15]![5]).toBe("success");
  });
});

describe("WP-10 DoD④ 接缝登记", () => {
  it("seams.md 含 ㉕㉖ 两条（关键词在位）且 ㉔ 仍在岗（零删除基线侧证）", () => {
    const seams = readRepo("docs/dev/seams.md");
    expect(seams).toContain("接缝㉕ harness deny × 缺省类型 × 两通道");
    expect(seams).toContain("DEFAULT_SUBAGENT_TYPE");
    expect(seams).toContain("接缝㉖ 更新双源 × `/update` × 探测");
    expect(seams).toContain("STANDARD_CODE_UPDATE_SOURCE");
    expect(seams).toContain("接缝㉔ 主题/快捷键 × 终端渲染单源");
  });
});

describe("WP-10 DoD④ 偏差分桶计数（逐行解析实测）", () => {
  it("偏差表 32 行＝A 16／B 9／C 7（分桶互斥、逐条唯一归属）", () => {
    const rows = tableRows(section("## 偏差汇总"), 5);
    expect(rows).toHaveLength(32);
    const buckets = rows.map((r) => r[4]);
    expect(buckets.filter((b) => b === "A")).toHaveLength(16);
    expect(buckets.filter((b) => b === "B")).toHaveLength(9);
    expect(buckets.filter((b) => b === "C")).toHaveLength(7);
    expect(buckets.every((b) => ["A", "B", "C"].includes(b!))).toBe(true);
  });
});

describe("WP-10 DoD⑤ M7 遗留 23 条 M8 终态对账", () => {
  it("23 行＝已核销闭合 17／如实登记 4／留 G 1／不落卡 1", () => {
    const rows = tableRows(section("## M7 遗留与未验证面 23 条 M8 终态对账"), 4);
    expect(rows).toHaveLength(23);
    const buckets = rows.map((r) => r[3]);
    expect(buckets.filter((b) => b === "已核销闭合")).toHaveLength(17);
    expect(buckets.filter((b) => b === "如实登记")).toHaveLength(4);
    expect(buckets.filter((b) => b === "留 G")).toHaveLength(1);
    expect(buckets.filter((b) => b === "不落卡")).toHaveLength(1);
  });
});

describe("WP-10 DoD⑥ 收口时点：命令全集与发布面负查（承 M5/M6/M7 同源）", () => {
  it("命令全集=35 件且集合 ≡ §8.2 M1∪M2∪M3∪M4∪M7（M8 零新增）；postinstall 零生命周期脚本", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(names).toHaveLength(35);
    expect(sorted(names)).toEqual(sorted([...M1, ...M2, ...M3, ...M4, ...M7]));
    const pkg = JSON.parse(readRepo("apps/cli/package.json")) as { scripts?: Record<string, string> };
    const lifecycle = ["preinstall", "install", "postinstall", "prepublish", "prepublishOnly", "prepare"];
    expect(Object.keys(pkg.scripts ?? {}).filter((s) => lifecycle.includes(s))).toEqual([]);
  });
});
