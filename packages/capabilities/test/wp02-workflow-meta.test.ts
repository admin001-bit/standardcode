// WP-02（M6）workflow meta 校验单测（DoD⑤）：脚本 MUST 以 `export const meta = {...}` 开头、值 MUST 纯字面量
// （禁变量引用/函数调用/展开/模板插值）、必填 name/description。依据 A 级 workflow 报告 §2.1 L170996。
// 实现形态 [自定]（报告 §12 未解之谜③：`[CC]` 逐字实现未定位）=手写词法+递归下降静态分析，不引 typescript 运行时依赖。
import { describe, expect, it } from "vitest";
import { parseWorkflowMeta, WorkflowMetaError } from "../src/index.ts";

function expectMetaError(source: string, pattern: RegExp): void {
  try {
    parseWorkflowMeta(source);
    throw new Error(`预期拒绝但通过了：${source}`);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowMetaError);
    expect((err as Error).message).toMatch(pattern);
  }
}

describe("DoD⑤ meta 合法路径", () => {
  it("必填 name/description 抽取（含可选 whenToUse/phases）", () => {
    const parts = parseWorkflowMeta(
      `export const meta = {\n  name: "调研编排",\n  description: "并行调研并汇总",\n  whenToUse: "需要扇出时",\n  phases: ["采集", "汇总"],\n};`,
    );
    expect(parts.meta.name).toBe("调研编排");
    expect(parts.meta.description).toBe("并行调研并汇总");
    expect(parts.meta.whenToUse).toBe("需要扇出时");
    expect(parts.meta.phases).toEqual(["采集", "汇总"]);
  });

  it("body 的 `export` 抹为等长空白——偏移与行号逐行对齐", () => {
    const source = `export const meta = { name: "a", description: "b" };\nconst x = 1;\nreturn x;`;
    const parts = parseWorkflowMeta(source);
    expect(parts.body).not.toContain("export");
    expect(parts.body.trimStart().startsWith("const meta")).toBe(true);
    expect(parts.body).toContain("\nconst x = 1;");
    expect(parts.body.split("\n").length).toBe(source.split("\n").length);
    expect(parts.body.length).toBe(source.length);
  });

  it("纯字面量全谱：字符串/数字/布尔/null/嵌套对象与数组/负号", () => {
    const parts = parseWorkflowMeta(
      `export const meta = { name: "a", description: "b", extra: { n: [1, 2.5, -3], flag: true, none: null }, };`,
    );
    expect(parts.meta.extra).toEqual({ n: [1, 2.5, -3], flag: true, none: null });
  });

  it("字符串转义被解码（\\n 与 \\uXXXX）", () => {
    const parts = parseWorkflowMeta(`export const meta = { name: "a\\u0041", description: "line\\nbreak" };`);
    expect(parts.meta.name).toBe("aA");
    expect(parts.meta.description).toBe("line\nbreak");
  });

  it("未知键不拒绝（[自定]②：元数据面前向可扩展）", () => {
    const parts = parseWorkflowMeta(`export const meta = { name: "a", description: "b", futureKey: ["x"] };`);
    expect(parts.meta.futureKey).toEqual(["x"]);
  });

  it("无分号（ASI）与注释/空白前置均容忍", () => {
    expect(parseWorkflowMeta(`// 说明\n  export const meta = { name: "a", description: "b" }\nreturn 1;`).meta.name).toBe("a");
  });
});

describe("DoD⑤ meta 拒绝路径（纯字面量硬约束）", () => {
  it("首句不是 `export const meta` 一律拒绝", () => {
    expectMetaError(`const meta = { name: "a", description: "b" };`, /export const meta/);
    expectMetaError(`export const other = { name: "a", description: "b" };`, /export const meta/);
  });

  it("meta 值必须是对象字面量", () => {
    expectMetaError(`export const meta = ["a"];`, /必须是对象字面量/);
    expectMetaError(`export const meta = "a";`, /必须是对象字面量/);
  });

  it("变量引用被拒", () => {
    expectMetaError(`export const meta = { name: PHASES, description: "b" };`, /不允许变量引用（`PHASES`）/);
  });

  it("函数调用被拒", () => {
    expectMetaError(`export const meta = { name: build("a"), description: "b" };`, /不允许函数调用/);
  });

  it("展开语法被拒", () => {
    expectMetaError(`export const meta = { name: "a", description: "b", ...rest };`, /不允许展开语法/);
  });

  it("模板字符串被拒（含插值）", () => {
    expectMetaError("export const meta = { name: `a${suffix}`, description: \"b\" };", /不允许模板字符串/);
    expectMetaError("export const meta = { name: `plain`, description: \"b\" };", /不允许模板字符串/);
  });

  it("计算属性名被拒", () => {
    expectMetaError(`export const meta = { name: "a", [key]: "b" };`, /不允许计算属性名/);
  });

  it("一元非数字表达式被拒", () => {
    expectMetaError(`export const meta = { name: "a", description: "b", n: -FLAG };`, /不允许一元表达式/);
  });

  it("缺 name / 缺 description / 空串一律拒绝", () => {
    expectMetaError(`export const meta = { description: "b" };`, /必填 `name`/);
    expectMetaError(`export const meta = { name: "a" };`, /必填 `description`/);
    expectMetaError(`export const meta = { name: "", description: "b" };`, /必填 `name`/);
    expectMetaError(`export const meta = { name: "a", description: "" };`, /必填 `description`/);
  });

  it("可选键类型严格", () => {
    expectMetaError(`export const meta = { name: "a", description: "b", whenToUse: 1 };`, /`whenToUse` 必须是字符串/);
    expectMetaError(`export const meta = { name: "a", description: "b", phases: "采集" };`, /`phases` 必须是非空字符串数组/);
    expectMetaError(`export const meta = { name: "a", description: "b", phases: [""] };`, /`phases` 必须是非空字符串数组/);
  });

  it("第二处 `export` 被拒（[自定]①：变换层只抹首个 export）", () => {
    expectMetaError(
      `export const meta = { name: "a", description: "b" };\nexport const extra = 1;`,
      /只允许 `export const meta` 一处 `export`/,
    );
  });

  it("结构损坏（对象未闭合/缺冒号/缺逗号/字符串未闭合）均拒绝", () => {
    expectMetaError(`export const meta = { name: "a", description: "b"`, /meta 对象未闭合/);
    expectMetaError(`export const meta = { name "a" };`, /缺少 `:`/);
    expectMetaError(`export const meta = { name: "a" description: "b" };`, /缺少 `,` 或 `\}`/);
    expectMetaError(`export const meta = { name: "a\n", description: "b" };`, /字符串字面量未闭合/);
  });
});
