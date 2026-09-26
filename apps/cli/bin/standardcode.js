#!/usr/bin/env node
// standardcode 入口。--version 短路保持冷启动门禁口径（spawn→输出版本→退出，不加载会话栈）；
// 无参=交互 REPL（WP-03），动态 import 会话栈；uninstall=CLI 子命令（WP-07，非斜杠——命令全集 30 不触）。
// 发布形制（ADR-0044 决策 3）：pack 后 bin 消费 dist bundle；dev 树缺 dist 回落 src/main.ts（冷启动面零变）。
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`standardcode ${pkg.version}`);
  process.exit(0);
}

const hasDist = existsSync(new URL("../dist/standardcode.mjs", import.meta.url));
const mod = await import(hasDist ? "../dist/standardcode.mjs" : "../src/main.ts");

if (arg === "uninstall") {
  process.exit(await mod.runUninstallCli(process.argv.slice(3))); // M8-WP-11：TTY 下装配 --purge 交互确认
}

if (arg === undefined) {
  await mod.main();
  process.exit(process.exitCode ?? 0);
}

console.log(`standardcode ${pkg.version}\nusage: standardcode [--version] [-sdb] | standardcode uninstall [--purge]`);
process.exit(1);
