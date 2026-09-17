# ADR-0045: 更新原子性——Windows 文件锁下的自更新（M5，v2.8 §13 行 534；M5-1 板 WP-07 交付物）

- 状态：已接受（2026-09-17，M5-WP-07；§13"更新原子性｜Windows 文件锁下的自更新｜M5 设计"清偿）
- 背景：M4-WP-08 落地 `/update` 手动/自动检查路（checkRegistryLatest+runNpmUpdate），更新执行=`npm i -g @standardcode/cli@latest` 单发无重试无校验——Windows 下运行中实例与文件锁（EBUSY/EPERM）可致更新失败或半装态；§13 将原子性设计划入 M5。

## 决策

1. **三层原子性策略（npm 全局目录语义内，不引入双目录切换/回滚面）** [自定]：
   - **层一·锁错重试**：更新失败且失败签名命中 Windows 文件锁族（`EBUSY`/`EPERM`/`ENOTEMPTY`/`EACCES` 于 stderr/error）→ 自动重试（缺省 maxRetries=2、retryDelayMs=1500；重试间无状态残留——npm 自身每轮完整事务）；
   - **层二·装后校验**：status=0 后执行 `npm ls -g @standardcode/cli --json` 解析实装版本（stdout 捕获新增为 NpmRunResult.stdout，additive）——与 expectedVersion（调用方传入，缺省=当前 CLI_VERSION）一致→`verified:true`；不一致或解析失败→`verified:false`；
   - **层三·明确引导**：所有失败终态（重试耗尽/校验失败/非锁错误即败）结构化返回 `guidance` 字段——三件套语义（ADR-0034 同族）：发生了什么/为什么/建议动作（"关闭正在运行的 standardcode 实例后重试，或手动执行 npm i -g @standardcode/cli@latest"）。**无半装态判据=成功当且仅当 status=0 且 verified=true**；其余一切终态均带引导且不谎报成功。
2. **非锁错误不重试**（fail-fast）：网络/registry 类失败（npm exit≠0 且 stderr 无锁签名）不消耗重试预算——直接结构化失败+引导（重试对 npm 网络失败无收益，快速降级承 M4 UPDATE_CHECK_TIMEOUT 同向）。
3. **重试不换通道**：重试命令与首试完全一致（同硬编码 args、同 env 剥离面）——更新原子性不引入第二通道（GitHub Releases 通道=M7 后备位，附录 E"更新走 npm registry 或 GitHub Releases"之后半=登记不实现，B-03）。
4. **运行中自更新语义**：CLI 自身发起 `npm i -g` 替换自身全局目录——Node 不持脚本文件句柄、`npm i` 覆盖在 Windows 对运行中 JS 通常可行；不可行场景=层一/层二/层三兜底（重试→校验→引导）。"更新成功，重启生效"提示语（M4 既有）保持——运行中实例继续用旧代码至退出，属预期非半装态（进程内存态与磁盘态分离，登记）。
5. **卸载原子性同面**：`npm rm -g`（uninstall 默认步）失败=中止后续步（PATH 还原/purge 均不执行，fail-closed）+结构化引导——防半卸态（purge 删用户数据前程序体必须已离场）。

## 影响的相邻机制

- platform/updater.ts：`runNpmUpdateAtomic`（重试+校验+引导封装，`runNpmUpdate` 保留为单发原语）；`defaultNpmRunner` 增 stdout 捕获；`runNpmUninstall`。
- apps/cli /update 面消费 `runNpmUpdateAtomic`（M4 EBUSY 三件套文案与 guidance 文案对齐）。

## 参考

- v2.8 §13 行 534（更新原子性=M5 设计原文）；M4-1-results §WP-08 X 节（EBUSY 形态+三件套先例）与核验 O1；附录 E 行 630（更新走 npm registry 或 GitHub Releases——后半登记不实现）。其余 [自定]。
