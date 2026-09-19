// WP-08（M4）：CLI 版本号单一来源——apps/cli/package.json（发布=CI 校验 npm 版本与此同源）。
// main.ts 横幅与本包 /update/auto-check 的 currentVersion 缺省共用（registry 比对基准）。
// WP-09（ADR-0047）：独立二进制内 import.meta.url 指向 bun 虚拟根（$bunfs，实测形如 `B:\~BUN\root\...`），
// 运行期读 package.json 必 ENOENT（2026-09-20 实测复现）——故二进制构建期经 `--define __SC_VERSION__`
// 烘焙版本常量；**未注入**（dev 树／测试／esbuild bundle）时回落运行期读盘，从而 tarball 形制下
// `pack-release --version <x.y.z>` 覆写 package.json 的既有语义不变（ADR-0044 决策 3）。
import { readFileSync } from "node:fs";

declare const __SC_VERSION__: string | undefined;

function readPackageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

export const CLI_VERSION: string = typeof __SC_VERSION__ === "string" ? __SC_VERSION__ : readPackageVersion();
