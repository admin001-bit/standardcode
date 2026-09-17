// WP-07（ADR-0044 决策 3）：CLI 单文件 ESM bundle——发布形制构建步。
// esbuild（platform=node：内置模块外置、workspace 源码全量内联）→ apps/cli/dist/standardcode.mjs。
// 仓内开发树不依赖本产物（bin shim 缺 dist 回落 src/main.ts）；pack/发布与三平台矩阵消费本文件。
import { build } from "esbuild";

await build({
  entryPoints: ["apps/cli/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "apps/cli/dist/standardcode.mjs",
  legalComments: "none",
  logLevel: "info",
  sourcemap: false,
  minify: false,
});
console.log("[build-cli] bundle written: apps/cli/dist/standardcode.mjs");
