// M8-WP-07 判据（DoD①）：包元数据卫生——八件 `package.json`（根＋`packages/*`×6＋`apps/cli`）`license` 全在位。
// 判据自足：卡 DoD① 枚举实测；license 值有实据（仓根 LICENSE=Apache-2.0 全文）。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url))); // apps/cli/test → 仓根

/** 枚举面＝根＋packages/*（目录驱动）＋apps/cli；目录驱动使"新增包漏补 license"必红。 */
const manifests = (): string[] => [
  "package.json",
  ...readdirSync(path.join(ROOT, "packages")).sort().map((d) => `packages/${d}/package.json`),
  "apps/cli/package.json",
];

const licenseOf = (rel: string): unknown => (JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as { license?: unknown }).license;

describe("M8-WP-07 DoD① 八件 package.json license 枚举在位", () => {
  it("枚举面恰八件（packages/* 恰六：capabilities/context/executor/harness/platform/providers）", () => {
    const pkgs = readdirSync(path.join(ROOT, "packages")).sort();
    expect(pkgs).toEqual(["capabilities", "context", "executor", "harness", "platform", "providers"]);
    expect(manifests()).toHaveLength(8);
  });

  it("八件 license 全在位且值逐字 Apache-2.0（含 apps/cli 既有字段零改动）", () => {
    for (const rel of manifests()) {
      expect(licenseOf(rel), rel).toBe("Apache-2.0");
    }
  });

  it("license 值有实据：仓根 LICENSE 为 Apache License 2.0 全文", () => {
    const lic = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    expect(lic).toContain("Apache License");
    expect(lic).toContain("Version 2.0, January 2004");
  });
});
