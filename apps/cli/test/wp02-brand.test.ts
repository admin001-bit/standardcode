// M8-WP-02 判据：①三件品牌资产字节级入库（sha256 与工作区源件逐条一致）
// ②终端标识位渲染（logo 左 ＋ tagline 正右方上下居中；宽度不足降级纯文本；非 TTY 零输出）
// ③既有渲染测试零改动（本文件不触碰 wp03-theme / wp04-keybindings 既有断言）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BANNER_MIN_COLUMNS, BRAND_TAGLINE, renderBrandBanner, startupBrandBanner } from "../src/brand.ts";

const ASSET_DIR = new URL("../assets/dog-logo/", import.meta.url);
const readAsset = (name: string): Buffer => readFileSync(fileURLToPath(new URL(name, ASSET_DIR)));
const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** 工作区源件（`D:\StandardCode\dog-logo\`）sha256，2026-09-26 入库时记录；改资产即须同步本表。 */
const SOURCE_SHA256: ReadonlyArray<readonly [string, string]> = [
  ["dog-logo.ts", "47d9c13a7a04839af23a11b4d9fca09c643e3207b191159cb66779ae50bc9fcd"],
  ["dog-logo.js", "8cba85c6ac35a8f430b22d16d4122a402ddd732e53568f285dca2a06c170cb46"],
  ["dog-logo.png", "aac05fe2297a9a5f589e92774b014c488dbf695fc4f8861b90f734f89cfd5d13"],
];

describe("WP-02 DoD① 三件品牌资源字节级入库", () => {
  it("三件 sha256 与工作区源件逐条相等（逐字节同一，非改名/重排）", () => {
    for (const [name, want] of SOURCE_SHA256) {
      expect(sha256(readAsset(name)), `${name} 与源件不一致`).toBe(want);
    }
  });

  it("ESM 主源导出渲染所需的 asciiFrame（单源面在位，非空壳占位文件）", async () => {
    const mod = (await import("../assets/dog-logo/dog-logo.ts")) as { asciiFrame?: unknown };
    expect(typeof mod.asciiFrame).toBe("function");
  });
});

describe("WP-02 DoD② 标识位渲染（logo 左 ＋ tagline 右上下居中）", () => {
  it("tagline 逐字等于附录 E 原文", () => {
    expect(BRAND_TAGLINE).toBe("StandardCode, Born for Engineering.");
  });

  it("宽度足够：18 行 logo；tagline 恰出现一次且在正中行右侧", () => {
    const lines = renderBrandBanner(80).replace(/\n$/, "").split("\n");
    expect(lines).toHaveLength(18); // 16x18 网格 → 18 行
    const hits = lines.filter((l) => l.includes(BRAND_TAGLINE));
    expect(hits, "tagline 应恰出现一次").toHaveLength(1);

    const row = lines.indexOf(hits[0]!);
    const centerRow = Math.floor(lines.length / 2); // 18 行取第 9 行（0 起）＝上下居中
    expect(row).toBe(centerRow);
    expect(lines.length - 1 - row).toBe(lines.length / 2 - 1); // 上 9 行 / 下 8 行，居中非贴底

    const col = lines[row]!.indexOf(BRAND_TAGLINE);
    expect(col, "tagline 应在 logo 右侧").toBeGreaterThanOrEqual(BANNER_MIN_COLUMNS - BRAND_TAGLINE.length);
    expect(lines[row]!.slice(0, col), "tagline 左侧应是 logo 图元").toContain("█");
  });

  it("非 tagline 行不含 tagline；行尾无空白（不污染终端选区/日志）", () => {
    const lines = renderBrandBanner(120).replace(/\n$/, "").split("\n");
    const row = lines.findIndex((l) => l.includes(BRAND_TAGLINE));
    lines.forEach((l, i) => {
      if (i !== row) expect(l).not.toContain(BRAND_TAGLINE);
      expect(l).toBe(l.replace(/\s+$/, ""));
    });
  });

  it("宽度不足：降级为纯文本 tagline（不截断 logo 成残图）", () => {
    const out = renderBrandBanner(BANNER_MIN_COLUMNS - 1);
    expect(out).toBe(`${BRAND_TAGLINE}\n`);
    expect(out).not.toContain("█");
  });

  it("边界形双判：恰好最小列数＝含 logo；少一列＝降级（非缺省形必覆盖）", () => {
    expect(renderBrandBanner(BANNER_MIN_COLUMNS)).toContain("█");
    expect(renderBrandBanner(BANNER_MIN_COLUMNS + 1)).toContain("█");
    expect(renderBrandBanner(BANNER_MIN_COLUMNS - 1)).not.toContain("█");
  });

  it("非法列数（NaN）不静默出残图：按降级处理", () => {
    expect(renderBrandBanner(Number.NaN)).toBe(`${BRAND_TAGLINE}\n`);
  });

  it("零 ANSI：两形均无 ESC 字节（接缝㉔ 渲染单源——本面着色须走 theme.ts，不自行内联）", () => {
    for (const out of [renderBrandBanner(80), renderBrandBanner(BANNER_MIN_COLUMNS - 1)]) {
      expect(out.includes("\u001b")).toBe(false);
    }
  });
});

describe("WP-02 DoD② 启动门控（stdout.isTTY）", () => {
  it("非 TTY（false/缺省）＝零输出——管道/重定向/CI 输出不受污染", () => {
    expect(startupBrandBanner({ isTTY: false, columns: 120 })).toBeNull();
    expect(startupBrandBanner({})).toBeNull();
  });

  it("TTY 且列数未知＝回落 80 列（宽形在岗，不因缺省列数误降级）", () => {
    const out = startupBrandBanner({ isTTY: true });
    expect(out).not.toBeNull();
    expect(out).toContain("█");
    expect(out).toContain(BRAND_TAGLINE);
  });

  it("TTY 但终端过窄＝降级纯文本（仍输出 tagline，非静默）", () => {
    expect(startupBrandBanner({ isTTY: true, columns: 40 })).toBe(`${BRAND_TAGLINE}\n`);
  });
});

describe("WP-02 装配接线守卫（启动标识位调用点在岗且先于 version 行）", () => {
  // 扫描型判据：判别力＝调用点被删/被后置即转红（结果页登记其书写形边界：仅认 `startupBrandBanner(` 调用与
  // 既有 version 行的相对次序，语义等价的另写法须随重构同步）。
  const mainSrc = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

  it("main.ts 调用 startupBrandBanner 且横幅写在 `standardcode ${CLI_VERSION}` 启动行之前", () => {
    const callAt = mainSrc.indexOf("startupBrandBanner(");
    expect(callAt, "启动标识位调用点缺位").toBeGreaterThan(-1);
    const versionLineAt = mainSrc.indexOf("standardcode ${CLI_VERSION}");
    expect(versionLineAt).toBeGreaterThan(-1);
    expect(callAt, "横幅须先于启动行印出").toBeLessThan(versionLineAt);
  });

  it("门控取自 stdout（输出目的地；stdout 被重定向时不写横幅）", () => {
    expect(mainSrc).toContain("startupBrandBanner(process.stdout)");
  });

  it("渲染面自身零 ANSI 颜色码（接缝㉔：新增渲染文件不得自带色码）", () => {
    const brandSrc = readFileSync(fileURLToPath(new URL("../src/brand.ts", import.meta.url)), "utf8");
    expect(brandSrc.includes("\u001b")).toBe(false);
  });
});
