// SSE 流解析：text/event-stream → {event, data} 帧序列。
// 按 WHATWG 语义逐块解析：LF/CRLF/CR 行尾兼容、多行 data: 以 \n 拼接、冒号注释行忽略、
// 空行派发帧、流结束时残留行照常派发（含未发空行的末帧）。
// [DONE] 不在本层处理（非标准帧），由各协议适配器识别。

export interface SseFrame {
  event: string | null;
  data: string;
}

const LINE_END_RE = /\r\n|\r|\n/;

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  let event: string | null = null;
  let dataLines: string[] = [];
  let sawField = false;

  function* takeLine(line: string): Generator<SseFrame> {
    if (line === "") {
      // 空行=帧边界：仅当出现过字段才派发（纯注释帧不派发）
      if (sawField) yield { event, data: dataLines.join("\n") };
      event = null;
      dataLines = [];
      sawField = false;
      return;
    }
    if (line.startsWith(":")) return; // 注释/心跳
    if (line.startsWith("event:")) {
      event = line.slice(6).startsWith(" ") ? line.slice(7) : line.slice(6);
      sawField = true;
    } else if (line.startsWith("data:")) {
      const v = line.slice(5);
      dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
      sawField = true;
    }
    // 其余字段（id:/retry:）本协议未用，忽略
  }

  function* flushTail(): Generator<SseFrame> {
    if (buf !== "") {
      const rest = buf;
      buf = "";
      yield* takeLine(rest);
    }
    if (sawField) {
      // 流止于无空行的末帧：照常派发（截断流不丢最后一帧）
      yield { event, data: dataLines.join("\n") };
      event = null;
      dataLines = [];
      sawField = false;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value?.length) buf += decoder.decode(value, { stream: true });
    if (done) {
      buf += decoder.decode();
      break;
    }
    let nl: number;
    while ((nl = buf.search(LINE_END_RE)) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
      yield* takeLine(line);
    }
  }
  yield* flushTail();
}
