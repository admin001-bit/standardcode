#!/usr/bin/env node
// standardcode 入口。--version 短路保持冷启动门禁口径（spawn→输出版本→退出，不加载会话栈）；
// 无参=交互 REPL（WP-03），动态 import 会话栈。
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`standardcode ${pkg.version}`);
  process.exit(0);
}

if (arg === undefined) {
  const { main } = await import("../src/main.ts");
  await main();
  process.exit(process.exitCode ?? 0);
}

console.log(`standardcode ${pkg.version}\nusage: standardcode [--version]`);
process.exit(1);
