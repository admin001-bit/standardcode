// DoD①：四模式各一解析测试（v2.8 §8.1）。
import { describe, expect, it } from "vitest";
import { parseInput } from "../src/input-modes.ts";

describe("parseInput (§8.1 四模式)", () => {
  it("prompt（默认）", () => {
    expect(parseInput("hello world")).toEqual({ kind: "prompt", text: "hello world" });
  });

  it("shell（行首 !，本地直接执行）", () => {
    expect(parseInput("!git status")).toEqual({ kind: "shell", command: "git status" });
    expect(parseInput("!")).toEqual({ kind: "shell", command: "" });
  });

  it("@file（路径+可选提示语）", () => {
    expect(parseInput("@src/a.ts explain this")).toEqual({ kind: "file", path: "src/a.ts", rest: "explain this" });
    expect(parseInput("@src/a.ts")).toEqual({ kind: "file", path: "src/a.ts", rest: "" });
    expect(parseInput("@")).toEqual({ kind: "file", path: "", rest: "" });
  });

  it("slash（命令名+参数）", () => {
    expect(parseInput("/help")).toEqual({ kind: "slash", name: "help", args: "" });
    expect(parseInput("/model claude-opus-5")).toEqual({ kind: "slash", name: "model", args: "claude-opus-5" });
    expect(parseInput("/")).toEqual({ kind: "slash", name: "", args: "" });
  });
});
