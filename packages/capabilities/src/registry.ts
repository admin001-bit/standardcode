// L3 工具注册表（v2.8 §5.3(4)）：元数据访问面。M1 只读 get/list——按名解析与枚举（供 /help 与提示词组装）。
import type { ToolRegistry } from "@standardcode/harness";
import type { StandardTool } from "./contract.ts";

export class CapabilityRegistry implements ToolRegistry {
  private readonly byName = new Map<string, StandardTool>();

  constructor(tools: StandardTool[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  get(name: string): StandardTool | undefined {
    return this.byName.get(name);
  }

  /** 注册表全量条目（提示词组装与 /help 列表用；M1 六工具无 deferred）。 */
  list(): StandardTool[] {
    return [...this.byName.values()];
  }
}
