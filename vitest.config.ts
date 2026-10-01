import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "evals/**/test/**/*.test.ts", "evals/benchmark/**/*.test.ts"],
    environment: "node",
    // S7-2（全仓审查 2026-10-01）：全局钉 lang=en——约 12 文件断言 EN 硬编码串却既不传 env 也不传
    // home，resolveLang(process.env, 真实 settings.language) 双泄漏：任一通道 zh 即数十条断言批量红
    //（CI 干净不显＝本机红型；全仓原仅 wp08-release-notes:41 正确自钉）。env 通道优先级最高，覆盖
    // settings.language 泄漏；测试自身显式传 env 覆写者不受影响。属 harness 级隔离基线，非业务断言。
    env: { STANDARD_CODE_LANG: "en" },
  },
});
