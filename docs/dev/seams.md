# 接缝清单与差异登记

> 复制自 `D:\StandardCode\StandardCode_v2.8.md` §12.5（2026-09-07，WP-07 迁移，逐字保留，原文为准；两份登记随实现更新于本文件）。

### 12.5 接缝清单与差异登记 `[新增]`（治"抄作业没抄全"）

[CC] 的机制是互相咬合的，只抄一半会在接缝处断裂。MUST 维护两份登记：

1. **接缝清单（seam inventory）**：跨模块咬合点逐条列出，每条=定义+锚点+测试。首批：①流式工具执行器 × isConcurrencySafe × tool_result 保序回填；②cacheScope × AutoCompact × TTL 双通道；③权限仲裁 × hooks × 沙箱三层裁决顺序；④agent 优先级链 × 插件注入点；⑤恢复链 9 级 × stop_reason 协议映射（Anthropic stop_reason 与 OpenAI finish_reason 非一一对应——如 `pause_turn` 无对应物，映射表在 L5 实现）。
2. **差异登记（deviation log）**：凡与参考实现不同的细节，登记 {原版锚点 → 修改点 → 理由 → 影响的相邻机制}。

## 接缝⑥ reactive 瀑布 × 恢复链② × 流级路径（2026-09-09，WP-05 R1 修复补登）

- 定义：prompt-too-long（ProviderError.kind=context_length）在 catch 路径先走 reactive 瀑布（LoopOptions.reactive：decide=nextReactiveStep 状态机、apply=cleanup/collapse 收缩闭包，auto-compact 级 exhausted 落 autocompact 路由），事件 reactive_step（tokenGap=used−window）逐级上屏；瀑布解决则不压缩。
- 锚点：CTX-037（v2.8:327）+A 级报告 §2.4 reactive 行；ADR-0036（collapse 未覆盖级）。
- 测试：packages/harness/test/reactive-route.test.ts（5 例：触发+tokenGap/升级序/exhausted 落协调器/瀑布先于 auto-compact/未配置原行为）。
- 未解决：流级 streamError 路径（agent-loop.ts:255-263【勘误 2026-09-09：原文 225-233 因同提交插入 30 行漂移，复验勘误③】）仍无条件 context_exhausted——reactive 未接（WP-05 边界登记，留 G 门）。
