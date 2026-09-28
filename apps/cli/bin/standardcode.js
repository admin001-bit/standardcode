#!/usr/bin/env node
// standardcode 入口。--version 短路保持冷启动门禁口径（spawn→输出版本→退出，不加载会话栈）；
// 无参=交互 REPL（WP-03），动态 import 会话栈；uninstall=CLI 子命令（WP-07，非斜杠——命令全集 30 不触）。
// 发布形制（ADR-0044 决策 3）：pack 后 bin 消费 dist bundle；dev 树缺 dist 回落 src/main.ts（冷启动面零变）。
// F2（2026-09-28）：收尾退出统一走 bundle 的 finalizeExit（Windows libuv 关闭竞态修复，见 src/main.ts 头注）。
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
  mod.finalizeExit(await mod.runUninstallCli(process.argv.slice(3))); // M8-WP-11：TTY 下装配 --purge 交互确认；F2：统一收尾出口
} else if (arg === undefined || arg === "-sdb") {
  // F9（2026-09-29 真机实测）：`-sdb` 原落 else → 打印 usage 并 rc=1（而 usage 字符串自己就宣传 [-sdb]；
  // main() 里的 sandboxCliFlag 分支因此永远到不了=死代码）。bin 放行并原样转发 argv（main 自持参数守卫）。
  await mod.main(process.argv.slice(2));
  mod.finalizeExit(process.exitCode ?? 0); // F2（2026-09-28）：立即 process.exit 触发 Windows libuv 关闭竞态断言（rc=127）
} else {
  console.log(`standardcode ${pkg.version}\nusage: standardcode [--version] [-sdb] | standardcode uninstall [--purge]`);
  process.exit(1);
}
