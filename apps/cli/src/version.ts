// WP-08（M4）：CLI 版本号单一来源——apps/cli/package.json（发布=CI 校验 npm 版本与此同源）。
// main.ts 横幅与本包 /update/auto-check 的 currentVersion 缺省共用（registry 比对基准）。
import { readFileSync } from "node:fs";

export const CLI_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
