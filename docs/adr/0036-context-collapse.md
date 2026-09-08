# ADR-0036: context collapse 最小设计（reactive 瀑布第二级）

- 状态：Accepted（2026-09-09）
- 背景与锚点：CTX-037（v2.8:327）瀑布三级"tool result 清理 → context collapse → auto-compact"。清理级与 auto-compact 级有锚点（A 级报告 claude-code-context-control.md §2.4 reactive；CTX-033/035/036 常量与四道闸），**context collapse 无独立 [CC] 锚点**（A 级报告 §2.4 仅一句：压缩头空间被系统占用时不再倒计时）→ v2.8 §12.6"未覆盖级先写 mini-ADR 再动代码"。WP-05 首版（6f2347e）以 reactive.ts 文件头注记代替 mini-ADR，V 退回 R2（2026-09-09），本 ADR 为补救补登（先于复验核销）。

## 裁决

context collapse = 历史收缩操作（压缩路径专用），丢弃"可再生物质"：

1. **assistant thinking 块**（含 signature）——实现唯一启用项（reactive.ts contextCollapse）。思考过程可由模型再生，最终回答不受影响；被丢块整块移除，不存在"无签名 thinking 上送"路径。
2. [REDACTED]/truncated 占位内容——保留扩展位，当前实现未启用（M2 不做；避免与 cleanup 级占位语义互相拆台）。

## 与硬不变量的关系（本裁决核心论证）

CTX-020①/WP-06"thinking 块 signature 原样回传"约束的是**请求构造与流式透传层**（多帧 signature_delta 拼接零加工、回放两跳逐字一致）；collapse 属**历史收缩层**——丢弃后该 assistant 消息不再含 thinking 块，后续请求自然不含该块（API 接受无 thinking 的历史）。两者语义正交，但本裁决缩小了 CTX-020① 的保护面（历史中的 thinking 不再恒久保留），故加两条约束：

- 收缩仅发生在 reactive 瀑布（prompt-too-long 已触发且 cleanup 级未解决）——非默认路径；
- 复验项登记：M5 沙箱/多 provider 方言下，若出现"历史无 thinking 块+请求携带 thinking 配置"的新语义约束，本裁决须复审（与 WP-06 边界③ M5 复验项同批）。

## 参数 [自定]

无阈值参数（丢弃全部 thinking 块，不设量级门槛）；freedChars=被丢块字符和（字符口径非 token 估算，V 观察 O3 勘误后命名）。cleanup 级参数（>10000 字符截断、占位保留 200 字符头）同属 [自定]（无 [CC] 锚点），登记于 reactive.ts 常量注释。

## 与相邻机制

- 顺序：cleanup（>10000 字符 tool_result 截断占位）→ collapse → auto-compact（协调器四道闸+9 段摘要，WP-03/04 交付）——由 nextReactiveStep 状态机钉死"前者未解决才升级"；exhausted=auto-compact 级耗尽后交还用户（loop 内不再重复压缩，重压缩链=协调器 willRetriggerNextTurn 的下轮维度）。
- 运行时接线：harness LoopOptions.reactive（2026-09-09 R1 修复；事件 reactive_step 含 tokenGap=used−window 指标）+repl reactive.execute 闭包（packages/context 三函数）。
- 接缝登记：docs/dev/seams.md（reactive 瀑布 × 恢复链② × 恢复链④续写通道）。

## 替代案（已否）

- 不做 collapse（瀑布退两级）——放弃 CTX-037 字面三级结构。
- 丢弃整条 assistant 消息——过度收缩，连带丢 text/tool_use，破坏对话连续性。
- 保留 thinking 块但剥离 signature——被 API 拒绝（WP-06 已测语义），不可行。

## 影响

packages/context/src/context-store/reactive.ts（contextCollapse/freedChars/CLEANUP_* 常量）、packages/harness（LoopOptions.reactive/reactive_step 事件/agent-loop 恢复链②）、apps/cli/src/repl.ts（reactive 装配）、apps/cli/src/render.ts（reactive_step 上屏）。
