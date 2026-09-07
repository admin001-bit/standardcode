// L3 工具契约与元数据（v2.8 §5.3(4)：元数据 {name, description, inputSchema, searchHint, isConcurrencySafe, deferred?}，
// 同构 _440.js:177818）。Tool/ToolContext 契约类型由消费方 harness 定义（L1）——此处仅 type-only 引用，无运行时依赖 [自定]。
import type { Tool, ToolContext } from "@standardcode/harness";
import type { ToolInputSchema } from "@standardcode/providers";

/** 工具元数据注册表条目（§5.3(4) 字段齐备：六字段全显式，deferred 在 M1 六工具恒 false）。 */
export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** 工具选择提示（检索/展示用）。 */
  searchHint: string;
  /** true=可与其他工具并行执行；false=串行（[CC] isConcurrencySafe 同构）。 */
  isConcurrencySafe: boolean;
  /** 延迟加载标记（Task 类工具后续 M 使用；M1 六工具 false）。 */
  deferred: boolean;
}

/** L3 标准工具：元数据 + 执行体（结构兼容 harness Tool——集成测试锁形）。 */
export interface StandardTool extends ToolMetadata {
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

export type { Tool, ToolContext };
