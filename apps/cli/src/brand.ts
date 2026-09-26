// M8-WP-02（v2.8 附录 E 行 631「品牌资源」）：终端产品标识位渲染——logo 置左、tagline 正右方上下居中。
//
// 位图单源 = 入库资产 `apps/cli/assets/dog-logo/dog-logo.ts`（ESM 主源，逐字节与工作区源件一致；
// 本模块零复制位图，直接消费其 asciiFrame——终端形制由资产自身定义，改资产即改渲染）。
// 形制（mini-ADR-0051，[自定]）：
//   ① 零 ANSI——接缝㉔ 渲染单源：颜色字面量仅 theme.ts 一处，本面不着色（故不经 colorize）；
//   ② 仅 TTY 打印——非 TTY（管道/重定向/CI）走行模式，启动输出零打扰（终端兼容矩阵 §2）；
//   ③ 宽度不足降级为纯文本 tagline（不截断 logo 成残图）。
import { asciiFrame } from "../assets/dog-logo/dog-logo.ts";

/** 品牌 tagline（附录 E 行 631 原文，逐字不改）。 */
export const BRAND_TAGLINE = "StandardCode, Born for Engineering.";

/** logo 列（16 格网格；行尾空格已去，左对齐缩进保留＝狗形轮廓所在）。 */
const LOGO_LINES: readonly string[] = asciiFrame("rest")
  .split("\n")
  .map((line) => line.replace(/\s+$/, ""));
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, line.length), 0);

/** logo 与 tagline 之间的水平间距。 */
const LOGO_GAP = "  ";

/** tagline 所在行（0 起；18 行取第 9 行＝上下居中）。 */
const TAGLINE_ROW = Math.floor(LOGO_LINES.length / 2);

/** logo + tagline 并排所需最小列数；窄于此＝降级纯文本。 */
export const BANNER_MIN_COLUMNS = LOGO_WIDTH + LOGO_GAP.length + BRAND_TAGLINE.length;

/**
 * 渲染标识位横幅（纯函数，宽度显式入参便于判别降级形）。
 * 宽度足够：18 行 logo，tagline 落在正中行右侧；不足：单行纯文本 tagline。
 */
export function renderBrandBanner(columns: number): string {
  if (!Number.isFinite(columns) || columns < BANNER_MIN_COLUMNS) return `${BRAND_TAGLINE}\n`;
  return (
    LOGO_LINES.map((line, i) => {
      // 每行右侧 padding 仅服务 tagline 行的定位，行尾空白一律去除（不污染终端选区/日志）
      const padded = line.padEnd(LOGO_WIDTH);
      return (i === TAGLINE_ROW ? `${padded}${LOGO_GAP}${BRAND_TAGLINE}` : padded).replace(/\s+$/, "");
    }).join("\n") + "\n"
  );
}

/**
 * 启动标识位（唯一装配入口）：TTY 输出面 → 横幅文本；非 TTY → null（行模式零输出）。
 * 门控取 `stdout.isTTY` 而非 stdin——决定是否打扰输出的是输出目的地（stdout 被重定向时不写横幅）。
 */
export function startupBrandBanner(stdout: { isTTY?: boolean; columns?: number }): string | null {
  if (!stdout.isTTY) return null;
  return renderBrandBanner(stdout.columns ?? 80);
}
