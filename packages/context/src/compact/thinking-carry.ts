// WP-06（CTX-020 工程不变量②）接缝件：压缩请求继承会话 thinking 配置。
// 压缩摘要请求构造（WP-04 compact）MUST 将会话当前 thinking 配置经本函数带入压缩请求的
// LLMRequest.thinking 字段——[CC] 2.1.198 起"compact 请求继承 thinking 配置"（v2.8 §7.5 原文）。
// 本卡先立接缝+断言；WP-04 消费。§12.5 接缝登记：thinking × AutoCompact × prompt cache。

import type { LLMRequest } from "@standardcode/providers";

export type ThinkingSetting = NonNullable<LLMRequest["thinking"]>;

/**
 * 压缩请求的 thinking 配置 = 会话配置原样继承（identity 语义：不改写、不降级、不猜测）。
 * 会话未配置（缺省关闭）→ 压缩请求同样不携带（与主对话一致）。
 */
export function carryThinkingConfig(session: ThinkingSetting | undefined): ThinkingSetting | undefined {
  return session;
}
