# ADR-0035: 剪贴板图片格式链（M2，v2.8 §13 行 12 处置）

- 状态：已接受（2026-09-08，M2-WP-12）
- 规格处置：v2.8 §13 行 12（剪贴板图片格式链：Windows 粘贴图片的格式处理→M2 设计）；§7.3 CTX-050（多模态 image MUST；Kimi ReadMediaFile 100MB 上限实证）；§8.1（Ctrl+V 剪贴板：图片+文字）。**设计只到格式链，功能实现挂后续 M**（本卡边界：不实现）。

## 决策（Windows 优先，格式链五段）

1. **剪贴板读取优先序（Windows）**：`CF_PNG`（[CC] 同构首选，无损）→ `CF_DIB`/`CF_DIBV5`（转 PNG 封装）→ 文件 drop（`CF_HDROP`，图片文件路径直接进 Read 流程）。Kimi 参照：Windows 用 Alt-V（A 级报告 :242-243），Linux 走 Wayland/X11、WSL 经 PowerShell 兜底——自研首版 Windows 原生 `CF_PNG`/DIB 即可，跨平台读法留 M4 i18n/生态期。
2. **格式转换段**：DIB→PNG 本地转换（无外部依赖：`CF_DIBV5` BITMAPINFOHEADER 解析+BMP 行序翻转+PNG 封装）；尺寸超限（默认 5MB/图片 [自定]，Kimi 100MB 是文件读取上限，粘贴面取保守值）→ 降采样提示（沿用 Kimi "先创建更小的副本"错误语义，A 级报告 :126）。
3. **消息注入段**：图片以 data URL（`data:image/png;base64`）进 ContentBlock `{type:"image"}`（providers IR 扩展位 CTX-050）；多模态能力位关闭的模型→拒绝注入并提示（能力位驱动，MDL-001/002）。
4. **占位符段**（Kimi :253 同构）：输入框显示 `[image N]` 占位，实际数据提交时随消息发送。
5. **脱敏联动**：剪贴板可能含敏感截图——S-10 不覆盖（不落盘），仅入消息流；transcript 落盘时 base64 数据按 ADR-0028 isMeta 语义登记处理（落盘体积警示，/doctor 提示）。

## 影响的相邻机制

- providers IR image 块（CTX-050 实现 M3+ 随多模态）、apps/cli 输入通道（Ctrl+V 挂钩，§8.1）、S-10/transcript 体积（ADR-0028 消费方注意）。
- §12.5 差异登记：格式优先序（CF_PNG→DIB）与 5MB 阈值为自研综合（[CC] 无本地代码层锚点，Kimi 为行为级参照）→ [自定] 标注。

## 参考

- v2.8 §13 行 12、§7.3 CTX-050、§8.1；A 级《KimiCode的产品细节.md》:115-126（ReadMediaFile 100MB/压缩语义）、:242-253（Alt-V/占位符/WSL 兜底）。
