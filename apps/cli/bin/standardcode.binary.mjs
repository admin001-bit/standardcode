// WP-09（ADR-0047 决策 1/3/4）：**独立二进制专用入口**——由 `scripts/build-binaries.mjs` 经
// `bun build --compile` 打进单文件产物；路由与 bin/standardcode.js（npm 形制 shim）同形：
// `--version`/`-v` 短路 → 输出版本并退出（冷启动门口径）；`uninstall` 子命令；无参=交互 REPL；其余=usage+exit 1。
// 与 shim 的两处刻意差异：
//   ① dist bundle 为**静态 import**（编译期内联进产物，二进制无运行期分派/无 dist 路径依赖）；
//   ② 版本取构建期注入的 `__SC_VERSION__`（`--define`，免运行期读盘——二进制内 import.meta.url 指向
//      bun 虚拟根，读 package.json 必 ENOENT，2026-09-20 实测）；直接用 node 跑本文件时回落读盘（测试用）。
// 边界（ADR-0047 决策 6）：Rust 沙箱臂（-sdb）不内嵌本产物——其随包分发归 WP-10；产物内沙箱探测缺位时
// 沿用既有 fail-closed 语义（executor resolveSandboxBinary 抛 SandboxUnavailableError，B-12）。
import { readFileSync } from "node:fs";
import { main, runUninstallCli } from "../dist/standardcode.mjs"; // M8-WP-11

const VERSION = typeof __SC_VERSION__ === "string"
  ? __SC_VERSION__
  : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`standardcode ${VERSION}`);
  process.exit(0);
}

if (arg === "uninstall") {
  process.exit(await runUninstallCli(process.argv.slice(3))); // M8-WP-11：TTY 下装配 --purge 交互确认
}

if (arg === undefined) {
  await main();
  process.exit(process.exitCode ?? 0);
}

console.log(`standardcode ${VERSION}\nusage: standardcode [--version] [-sdb] | standardcode uninstall [--purge]`);
process.exit(1);
