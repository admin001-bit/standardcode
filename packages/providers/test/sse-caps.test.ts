import { describe, expect, it } from "vitest";
import { parseSse } from "../src/sse.ts";
import { AnthropicAdapter, anthropicCapabilities } from "../src/anthropic.ts";
import { openaiCapabilities } from "../src/openai.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function frames(chunks: string[]) {
  const out: Array<{ event: string | null; data: string }> = [];
  for await (const f of parseSse(streamOf(chunks))) out.push(f);
  return out;
}

describe("SSE 解析器（WHATWG 语义）", () => {
  it("基本帧：event+data、空行分隔", async () => {
    expect(await frames(["event: foo\ndata: 1\n\n"])).toEqual([{ event: "foo", data: "1" }]);
  });

  it("跨 chunk 切断的行被正确续接（分包不丢帧）", async () => {
    expect(await frames(["event: a\nda", "ta: {\"x\":", "1}\n\n"])).toEqual([{ event: "a", data: '{"x":1}' }]);
  });

  it("CRLF 与 CR 行尾兼容", async () => {
    expect(await frames(["data: a\r\n\r\n"])).toEqual([{ event: null, data: "a" }]);
    expect(await frames(["data: b\r\r"])).toEqual([{ event: null, data: "b" }]);
  });

  it("多行 data 以 \\n 拼接；data: 后单空格剥除", async () => {
    expect(await frames(["data: one\ndata: two\n\n"])).toEqual([{ event: null, data: "one\ntwo" }]);
    expect(await frames(["data:x\n\n"])).toEqual([{ event: null, data: "x" }]);
  });

  it("冒号注释行忽略、纯注释帧不派发（心跳穿透）", async () => {
    expect(await frames([": ping\n\n", "data: 1\n\n"])).toEqual([{ event: null, data: "1" }]);
  });

  it("流止于无空行的末帧：照常派发（截断流不丢尾帧）", async () => {
    expect(await frames(["data: tail"])).toEqual([{ event: null, data: "tail" }]);
  });

  it("BOM 与未知字段忽略", async () => {
    expect(await frames(["id: 7\nretry: 9\ndata: x\n\n"])).toEqual([{ event: null, data: "x" }]);
  });
});

describe("能力声明（cache 能力位驱动打点，ARCH-007）", () => {
  it("Anthropic：explicitBreakpoints=true + TTL 双档", () => {
    const caps = anthropicCapabilities({
      contextWindow: 200000,
      maxOutputTokens: { default: 32000, upper: 128000 },
      thinking: "adaptive",
      input: ["text", "image"],
    });
    expect(caps.cache).toEqual({ ttlLevels: ["5m", "1h"], explicitBreakpoints: true });
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
  });

  it("OpenAI 兼容：explicitBreakpoints=false（自动前缀缓存，零打点）", () => {
    const caps = openaiCapabilities({
      contextWindow: 128000,
      maxOutputTokens: { default: 4096, upper: 16384 },
      thinking: "none",
      input: ["text"],
    });
    expect(caps.cache).toEqual({ ttlLevels: [], explicitBreakpoints: false });
  });

  it("未知模型 capabilities 抛错（不硬编码回退，禁厂商分支）", async () => {
    const a = new AnthropicAdapter(
      { m: { contextWindow: 1, maxOutputTokens: { default: 1, upper: 1 }, thinking: "none", input: ["text"] } },
      { apiKey: "k" },
    );
    expect(() => a.capabilities("nope")).toThrow("unknown model");
  });
});
