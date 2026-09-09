// UI-001 Tab 补全测试（M1 五命令+M2 /rewind /diff=七命令）。
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.ts";
import { completeInput } from "../src/tab-complete.ts";

describe("completeInput (UI-001)", () => {
  it("唯一前缀 → 补全 + 参数提示", () => {
    const c = completeInput("/he", CLI_COMMANDS);
    expect(c.insert).toBe("/help ");
    expect(c.hint).toBe("list all available commands");
  });

  it("多义前缀 → 候选列表；单命令前缀 → 唯一补全", () => {
    const c = completeInput("/", CLI_COMMANDS);
    expect(c.candidates).toEqual(["/help", "/clear", "/exit", "/model", "/permission", "/rewind", "/context", "/diff", "/new", "/resume", "/rename"]);
    const c2 = completeInput("/e", CLI_COMMANDS); // 恰一命令以 e 开头
    expect(c2.insert).toBe("/exit ");
    expect(c2.candidates).toEqual([]);
  });

  it("参数位 → 提示 usage/description，不再改写行", () => {
    const c = completeInput("/model ", CLI_COMMANDS);
    expect(c.insert).toBeNull();
    expect(c.hint).toContain("[name]");
    expect(c.hint).toContain("switch the model");
  });

  it("非斜杠输入与未知前缀 → 无补全", () => {
    expect(completeInput("hello", CLI_COMMANDS)).toEqual({ insert: null, candidates: [], hint: null });
    expect(completeInput("/zz", CLI_COMMANDS).candidates).toEqual([]);
    expect(completeInput("/zz", CLI_COMMANDS).insert).toBeNull();
  });
});
