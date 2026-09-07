// DoD③：UI-001 五命令 Tab 补全与参数提示。
import { describe, expect, it } from "vitest";
import { M1_COMMANDS } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";

describe("completeInput (UI-001)", () => {
  it("唯一前缀 → 补全 + 参数提示", () => {
    const c = completeInput("/he", M1_COMMANDS);
    expect(c.insert).toBe("/help ");
    expect(c.hint).toBe("list all available commands");
  });

  it("多义前缀 → 候选列表；单命令前缀 → 唯一补全", () => {
    const c = completeInput("/", M1_COMMANDS);
    expect(c.candidates).toEqual(["/help", "/clear", "/exit", "/model", "/permission"]);
    const c2 = completeInput("/e", M1_COMMANDS); // 恰一命令以 e 开头
    expect(c2.insert).toBe("/exit ");
    expect(c2.candidates).toEqual([]);
  });

  it("参数位 → 提示 usage/description，不再改写行", () => {
    const c = completeInput("/model ", M1_COMMANDS);
    expect(c.insert).toBeNull();
    expect(c.hint).toContain("[name]");
    expect(c.hint).toContain("switch the model");
  });

  it("非斜杠输入与未知前缀 → 无补全", () => {
    expect(completeInput("hello", M1_COMMANDS)).toEqual({ insert: null, candidates: [], hint: null });
    expect(completeInput("/zz", M1_COMMANDS).candidates).toEqual([]);
    expect(completeInput("/zz", M1_COMMANDS).insert).toBeNull();
  });
});
