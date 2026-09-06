#!/usr/bin/env node
// M0 骨架占位：仅 --version 输出，零业务逻辑（WP-04 边界）。
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`standardcode ${pkg.version}`);
  process.exit(0);
}

console.log(`standardcode ${pkg.version} — M0 骨架占位（无业务能力，命令随里程碑交付）`);
