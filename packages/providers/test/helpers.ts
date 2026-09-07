import type { LLMEvent } from "../src/events.ts";

/** 将 SSE 文本包成 200 响应（单 chunk 投喂；解析器自行缓冲分行）。 */
export function sseResponse(frames: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

/** 非 200 响应（重试/分类测试用）。 */
export function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

export async function collect(events: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
