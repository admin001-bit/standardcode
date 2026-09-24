// WP-14（M7 收口）收口断言集：①DoD 判据文字与 v2.8 行 115 程序化逐字对质 ②命令全集守恒
// ③实验门候选面守恒 ④附录 E 全通道面在位（勾验表 1-10 的实物侧） ⑤接缝㉒㉓㉔ 登记＋既有接缝零删除基线
// ⑥偏差分桶计数（M7.md 遗留汇总表）。与 M6 `wp12-milestone.test.ts` 同源互补：后者=M6 收口时点零增量复核，
// 本文件=M7 收口时点复核＋附录 E 通道面在位＋活文档（M7.md/seams.md）基线。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveExperimental } from "@standardcode/platform";
import { CLI_COMMANDS } from "../src/commands.ts";
import { activeExperimentalCommandNames, experimentalCommandNames } from "../src/experimental-gate.ts";
import { parseUninstallArgs } from "../src/uninstall.ts";

/** v2.8 §2 行 115（M7 行）判据与范围列原文——逐字硬编码，改一字即红（DoD① 对质面）。 */
const V28_M7_ROW = "| **M7 长尾** | 收尾 | `/goal` `/effort` 细化、主题/快捷键、OTel 导出、Q-5–Q-9 遗留裁决 | 附录 E 全通道可用 |";
const V28_M7_DOD = "附录 E 全通道可用";

const M1 = ["help", "clear", "exit", "model", "permission"];
const M2 = ["new", "resume", "reload", "rename", "compact", "context", "diff", "rewind", "config", "provider", "doctor", "cd", "add-dir"];
const M3 = ["tasks", "background", "subtask", "effort", "init", "status", "usage"];
const M4 = ["mcp", "plugin", "skills", "memory", "update"];
/** §8.2 行 365 M7 分期正式面五件（四长尾走实验门/侧信道，不进基表）。 */
const M7 = ["goal", "theme", "keybindings", "sandbox", "release-notes"];
/** §8.2 行 365 七件实验候选（含侧信道 btw）。 */
const EXPERIMENTAL_CANDIDATES = ["workflows", "batch", "loop", "btw", "branch", "fork", "export"];

/** 附录 E 行 630 通道面实物（勾验表 #1-#10 的载体；缺任一即红）。 */
const CHANNEL_FILES = [
  "packaging/winget/manifests/StandardCode.StandardCode.yaml",
  "packaging/winget/manifests/StandardCode.StandardCode.installer.yaml",
  "packaging/winget/manifests/StandardCode.StandardCode.locale.en-US.yaml",
  "packaging/direct-download/verify.sh",
  "packaging/direct-download/verify.ps1",
  "packaging/homebrew/standardcode.rb",
  "packaging/linux/install.sh",
  "packaging/linux/uninstall.sh",
  "packaging/linux/build-deb.sh",
  "packaging/linux/build-rpm.sh",
  "packaging/linux/standardcode.spec",
  "scripts/build-binaries.mjs",
  "scripts/checksum.mjs",
  "scripts/verify-channel-checksums.mjs",
  "scripts/install.sh",
  "scripts/install.ps1",
  "scripts/cleanup.sh",
  "scripts/cleanup.ps1",
];
/** 包名守卫面：ADR-0044 决策 10 改判后四脚本须为新包名且旧名零命中（WP-11 D1/8fffaa2 防漂移）。 */
const PKG_SCRIPTS = ["scripts/install.sh", "scripts/install.ps1", "scripts/cleanup.sh", "scripts/cleanup.ps1"];

const sorted = (xs: readonly string[]) => [...xs].sort();
const names = CLI_COMMANDS.map((c) => c.name);
const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const readRepo = (rel: string) => readFileSync(repoFile(rel), "utf8");

describe("WP-14 DoD① 判据文字与 v2.8 行 115 程序化逐字对质", () => {
  it("docs/milestones/M7.md 表行（范围列＋DoD 列）与 v2.8 行 115 逐字相等；勾验表该勾已勾", () => {
    const md = readRepo("docs/milestones/M7.md");
    expect(md, "M7.md 表行须与 v2.8 行 115 逐字一致（含 en dash Q-5–Q-9）").toContain(V28_M7_ROW);
    expect(md, "DoD「附录 E 全通道可用」须已勾验 ✓").toContain(`- [x] ${V28_M7_DOD}`);
  });
});

describe("WP-14 收口时点：命令全集与实验门候选面守恒", () => {
  it("命令全集=35 件且集合 ≡ §8.2 M1∪M2∪M3∪M4∪M7（M7 分期五件全在位）", () => {
    expect(names).toHaveLength(35);
    expect(sorted(names)).toEqual(sorted([...M1, ...M2, ...M3, ...M4, ...M7]));
  });

  it("实验门候选面守恒：experimentalCommandNames() 恰 7 件（含侧信道 btw）；缺省关=活跃放行面 []", () => {
    expect(sorted(experimentalCommandNames())).toEqual(sorted(EXPERIMENTAL_CANDIDATES));
    const gate = resolveExperimental({ env: {}, settings: undefined });
    expect(gate.enabled).toBe(false);
    expect([...activeExperimentalCommandNames(gate)]).toEqual([]);
  });
});

describe("WP-14 附录 E 全通道面在位（勾验表 #1-#10 实物侧）", () => {
  it("四通道＋二进制＋清理脚本 18 件实物在位（缺任一即红）", () => {
    const missing = CHANNEL_FILES.filter((f) => !existsSync(repoFile(f)));
    expect(missing, `附录 E 通道面缺件：${missing.join(", ")}`).toEqual([]);
  });

  it("包名守卫：四脚本含 @standardcode-oss/cli 且改判前旧名 @standardcode/cli 零命中", () => {
    for (const s of PKG_SCRIPTS) {
      const text = readRepo(s);
      expect(text, `${s} 须为改判后新包名`).toContain("@standardcode-oss/cli");
      expect(text, `${s} 不得残留改判前旧名`).not.toContain("@standardcode/cli");
    }
  });

  it("更新双源导出在位（npm registry + GitHub Releases）+ 卸载 --purge 解析", () => {
    const updater = readRepo("packages/platform/src/updater.ts");
    expect(updater).toContain("export async function checkRegistryLatest(");
    expect(updater).toContain("export async function checkGitHubLatest(");
    expect(parseUninstallArgs(["--purge"])).toEqual({ purge: true });
    expect(parseUninstallArgs([])).toEqual({ purge: false });
  });

  it("CI binaries 泳道在位（独立二进制通道的 CI 承载面）", () => {
    expect(readRepo(".github/workflows/ci.yml")).toContain("binaries");
  });
});

describe("WP-14 接缝登记：㉒㉓㉔ 追加 + 既有接缝零删除基线", () => {
  it("docs/dev/seams.md 含接缝㉒㉓㉔ 三条；㉑ 门内注册枚举已含 branch/batch/loop 与侧信道 btw", () => {
    const seams = readRepo("docs/dev/seams.md");
    for (const n of ["㉒", "㉓", "㉔"]) expect(seams, `接缝${n} 未登记`).toContain(`## 接缝${n}`);
    // 既有 13 条接缝零删除基线（追加式登记，既有行不得丢失）
    for (const n of ["③", "④", "⑥", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑰", "⑱", "⑲", "⑳", "㉑"]) {
      expect(seams, `既有接缝${n} 被删（违反零删除基线）`).toContain(`接缝${n}`);
    }
    const seam21 = seams.slice(seams.indexOf("## 接缝㉑"), seams.indexOf("## 接缝㉒"));
    for (const cmd of ["branch", "batch", "loop", "btw"]) {
      expect(seam21, `接缝㉑ 门内注册枚举缺 ${cmd}（活文档陈旧未订正）`).toContain(cmd);
    }
  });
});

describe("WP-14 DoD⑤ 偏差分桶计数（M7.md 遗留汇总表）", () => {
  it("23 条＝A 5（随收口登记）＋B 6（留 G 门）＋C 12（留后续卡）；逐条唯一归属且逐格解析", () => {
    const md = readRepo("docs/milestones/M7.md");
    const section = md.slice(md.indexOf("## 全板遗留与未验证面汇总"), md.indexOf("## 顺带处理说明"));
    const rows = section.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    // 逐格解析（非整行 includes）：格数不符即红——单元格内裸竖线会撑破列并被本断言捕获（V-A D-A2 订正面）。
    const cellsOf = (r: string) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
    expect(rows.filter((r) => cellsOf(r).length !== 5).map((r) => r.slice(0, 70)), "遗留表每行须恰 5 格").toEqual([]);
    const bucket = rows.map((r) => cellsOf(r)[3]); // 第 4 格＝处置
    const count = (marker: string) => bucket.filter((x) => x.startsWith(marker)).length;
    const a = count("**A 已做（收口）**") + count("**A 已闭合"); // 含「已闭合」与「已闭合（追溯认定）」两形
    const b = count("**B 留 G 门**");
    const c = count("**C 留后续卡**");
    expect({ a, b, c, total: rows.length }).toEqual({ a: 5, b: 6, c: 12, total: 23 });
    expect(a + b + c).toBe(rows.length); // 分桶互斥：无未分桶条目
  });
});
