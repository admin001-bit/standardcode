// ARCH-008 stdio JSON 帧层 TS 端（镜像 crates/sandbox/src/ipc.rs 形制：行分隔单行 JSON、
// 协议版本 5、16MB 帧闸、坏帧 fail-closed——消费方必须关通道不得跳帧续读）。
// 同源判据：本文件常量与校验规则与 ipc.rs 逐一对位；两端 golden 帧串在各测内联（字符串
// 形同源=漂移即双端测试抓，[自定] 形制登记）。

export const IPC_PROTOCOL_VERSION = 5;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type FrameKind = "hello" | "request" | "response" | "event" | "error";

export interface Frame {
  v: number;
  kind: FrameKind;
  id?: number;
  payload?: unknown;
}

/** 帧对象 → 单行 JSON + `\n`；超帧闸 → 抛（不产出截断帧，同 Rust encode）。 */
export function encodeFrame(frame: Frame): string {
  const obj: Record<string, unknown> = { v: frame.v, kind: frame.kind };
  if (frame.id !== undefined) obj.id = frame.id;
  if (frame.payload !== undefined) obj.payload = frame.payload;
  const text = JSON.stringify(obj);
  if (text.includes("\n")) throw new Error("frame contains embedded newline");
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new Error(`frame too large: ${Buffer.byteLength(text)} > ${MAX_FRAME_BYTES}`);
  return text + "\n";
}

/** 单行 → 帧（严格校验镜像 Rust decode：v/kind/id 规则；任何不符抛错）。 */
export function decodeFrame(line: string): Frame {
  const trimmed = line.replace(/\r?\n$/, "");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_FRAME_BYTES) throw new Error("frame too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("frame is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("frame is not a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== IPC_PROTOCOL_VERSION) throw new Error(`protocol version mismatch: got ${String(obj.v)}`);
  const kind = obj.kind;
  if (kind !== "hello" && kind !== "request" && kind !== "response" && kind !== "event" && kind !== "error") {
    throw new Error(`unknown frame kind: ${String(kind)}`);
  }
  if (kind === "request" || kind === "response" || kind === "error") {
    if (typeof obj.id !== "number" || !Number.isInteger(obj.id)) throw new Error(`${kind} frame requires numeric id`);
  }
  const frame: Frame = { v: IPC_PROTOCOL_VERSION, kind: kind as FrameKind };
  if (typeof obj.id === "number") frame.id = obj.id;
  if (obj.payload !== undefined) frame.payload = obj.payload;
  return frame;
}
