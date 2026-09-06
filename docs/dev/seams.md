# 接缝清单与差异登记

> 复制自 `D:\StandardCode\StandardCode_v2.8.md` §12.5（2026-09-07，WP-07 迁移，逐字保留，原文为准；两份登记随实现更新于本文件）。

### 12.5 接缝清单与差异登记 `[新增]`（治"抄作业没抄全"）

[CC] 的机制是互相咬合的，只抄一半会在接缝处断裂。MUST 维护两份登记：

1. **接缝清单（seam inventory）**：跨模块咬合点逐条列出，每条=定义+锚点+测试。首批：①流式工具执行器 × isConcurrencySafe × tool_result 保序回填；②cacheScope × AutoCompact × TTL 双通道；③权限仲裁 × hooks × 沙箱三层裁决顺序；④agent 优先级链 × 插件注入点；⑤恢复链 9 级 × stop_reason 协议映射（Anthropic stop_reason 与 OpenAI finish_reason 非一一对应——如 `pause_turn` 无对应物，映射表在 L5 实现）。
2. **差异登记（deviation log）**：凡与参考实现不同的细节，登记 {原版锚点 → 修改点 → 理由 → 影响的相邻机制}。
