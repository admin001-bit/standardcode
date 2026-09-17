# Release 门禁与发布流程（WP-09；ADR-0044 通道集承载）

> 本文=发布前门禁声明落档（WP-08 卡 DoD③ 交付物"workflow 文件+docs/release.md 指针"之指针面）。
> 通道集与外发授权口径=ADR-0044（BLK-02=①）：**一切对外发布动作（npm publish、GitHub 转 public、release 发布）逐项用户明示授权后方可执行**。

## 发布前置（双绿门禁，缺一不发）

1. **CI gate 三平台绿**：`.github/workflows/ci.yml`（version/cold-start/typecheck/test/rust 五门 × windows/macos/ubuntu）。
2. **release-matrix 全绿**：`.github/workflows/release-matrix.yml`（workflow_dispatch 手动触发）——
   - `matrix` job：三平台装（本地 tarball）→ --version → 更（bump overlay）→ 卸（CLI uninstall）→ 残留断言 → purge（cleanup 脚本）；
   - `evals-gate` job（WP-09 挂接，ENG-030~032 行 483"发布前 live 模式"）：
     - **recorded 常绿门**：`pnpm run evals:run`（零网络；报告 `docs/evals/<VERSION>.md` 逐字节守卫）；
     - **live 抽样门**：`pnpm run evals:live`（`STANDARD_CODE_EVALS_LIVE=1` + 真实 provider 抽样 3 任务）。
       - 密钥=repo secrets（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`），模型/base URL 可经 repo vars（`STANDARD_CODE_EVALS_MODEL` / `STANDARD_CODE_EVALS_BASE_URL`）覆写；
       - **凭据缺席=本 job 红（LIVE-NOT-CONFIGURED）非静默假过**——live 抽样未过或未配置，发布不得进行；
       - live 报告落 `docs/evals/live-<VERSION>.md`（结论附模型版本号=行 483 原文要求）。

## 发布步骤（授权到手后）

1. 本地 `node scripts/pack-release.mjs --version <x.y.z>` 产出 tarball+checksum（SEC-040：`node scripts/checksum.mjs verify apps/cli/dist`）；
2. `npm publish`（2FA OTP；scope=`@standardcode-oss`，ADR-0044 决策 10）；
3. 发布后复验链：registry 查询 200 → 真实安装 → 更新路（runNpmUpdateAtomic verified）→ 卸载残留 gone（WP-07 DoD⑦ 形制）。

## 相关文档

- 通道集/签名/uninstall 语义：`docs/adr/0044-release-channels-and-uninstall.md`
- 更新原子性：`docs/adr/0045-update-atomicity.md`
- evals recorded 面：`docs/evals/v2.md`（VERSION=v2 起；v0/v1 存档只读）
- live 抽样族定义：`evals/benchmark/live.ts`（3 任务；destructiveOps=真实 tool_use 派生命中数）
