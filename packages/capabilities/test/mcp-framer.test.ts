// WP-01 stdio 分帧与溢出守卫（DoD⑥ 溢出面；BoundedStdio 同构 16MB :45637，文案形状 :285543）。
import { describe, expect, it } from "vitest";
import { interpolateEnv, MCP_STDOUT_MAX_LINE_BYTES, NdjsonFramer, StdoutOverflowError } from "../src/index.ts";

describe("NdjsonFramer（newline-delimited JSON-RPC）", () => {
  it("完整帧/跨 chunk 半帧/多帧一 chunk/空行与非 JSON 行宽容", () => {
    const f = new NdjsonFramer();
    expect(f.push(Buffer.from('{"jsonrpc":"2.0","id":1}\n'))).toEqual([{ jsonrpc: "2.0", id: 1 }]);
    expect(f.push(Buffer.from('{"a":'))).toEqual([]);
    expect(f.push(Buffer.from("1}\n{\"b\":2}\n"))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(f.push(Buffer.from("\r\n\n"))).toEqual([]);
    expect(f.push(Buffer.from("not json\n"))).toEqual([]);
    expect(f.push(Buffer.from('{"c":3}\n'))).toEqual([{ c: 3 }]);
  });
  it("缺省上限=16777216（16MB 同构 [CC] YO :45637）", () => {
    expect(MCP_STDOUT_MAX_LINE_BYTES).toBe(16777216);
    expect(new NdjsonFramer().push(Buffer.from("x")).length).toBe(0);
  });
  it("超限：残行超上限=溢出置位（断连语义）；文案含 stdout/Disconnecting（形状 :285543）", () => {
    const f = new NdjsonFramer(64);
    expect(f.push(Buffer.from("a".repeat(70)))).toEqual([]);
    expect(f.overflowError).toBeInstanceOf(StdoutOverflowError);
    expect(f.overflowError!.message).toContain("stdout");
    expect(f.overflowError!.message).toContain("Disconnecting");
    // 溢出终态：后续帧全弃。
    expect(f.push(Buffer.from('{"id":2}\n'))).toEqual([]);
  });
  it("整行超限同样溢出；行大小恰上限不炸", () => {
    const big = JSON.stringify({ payload: "x".repeat(200) });
    expect(big.length).toBeGreaterThan(100);
    const g = new NdjsonFramer(100);
    expect(g.push(Buffer.from(big + "\n"))).toEqual([]);
    expect(g.overflowError).toBeInstanceOf(StdoutOverflowError);
    const ok = JSON.stringify({ p: "y".repeat(30) });
    expect(ok.length).toBeLessThan(100);
    const h = new NdjsonFramer(100);
    expect(h.push(Buffer.from(ok + "\n")).length).toBe(1);
    expect(h.overflowError).toBeNull();
  });
});

describe("interpolateEnv（DoD⑤ 基元）", () => {
  it("存在→展开；default 语法；缺席无 default=保留字面+登记；非变量形态不动", () => {
    expect(interpolateEnv("a${X}b", { X: "1" })).toEqual({ value: "a1b", unresolved: [] });
    expect(interpolateEnv("${X:-d/f}", {})).toEqual({ value: "d/f", unresolved: [] });
    expect(interpolateEnv("${X:-d}", { X: "v" })).toEqual({ value: "v", unresolved: [] });
    expect(interpolateEnv("${A}${B:-x}", {})).toEqual({ value: "${A}x", unresolved: ["A"] });
    expect(interpolateEnv("100% $cash {curly}", {})).toEqual({ value: "100% $cash {curly}", unresolved: [] });
    expect(interpolateEnv("${X", { X: "1" })).toEqual({ value: "${X", unresolved: [] });
  });
});
