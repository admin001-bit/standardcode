// WP-03 帧协议 TS 端测试：编解码形状 + 双端同源 golden（Rust 实跑帧串内联）+ 坏帧拒收。
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, IPC_PROTOCOL_VERSION, MAX_FRAME_BYTES } from "@standardcode/executor";

describe("wp03 frame codec（镜像 ipc.rs 形制）", () => {
  // 双端同源 golden：以下两串取自 Rust 端 `cargo test serve::` 实跑帧输出（wp02/wp03 会话），
  // TS decode 必收且字段级相等——字段名/版本漂移即红（协议=接口，板头纪律）。
  it("decode 收 Rust 真实帧串（golden 内联，键序无关）", () => {
    const rustHello = '{"kind":"hello","payload":{"protocol":5},"v":5}';
    const rustRequest = '{"id":7,"kind":"request","payload":{"method":"fsWrite","params":{"nope":1}},"v":5}';
    const rustResponse = '{"id":3,"kind":"response","payload":{"result":{"exitCode":0}},"v":5}';
    const rustEvent = '{"kind":"event","payload":{"data":{"data":"hi","reqId":3,"stream":"stdout"},"name":"output"},"v":5}';
    expect(decodeFrame(rustHello)).toEqual({ v: IPC_PROTOCOL_VERSION, kind: "hello", payload: { protocol: 5 } });
    expect(decodeFrame(rustRequest)).toEqual({ v: IPC_PROTOCOL_VERSION, kind: "request", id: 7, payload: { method: "fsWrite", params: { nope: 1 } } });
    expect(decodeFrame(rustResponse)).toEqual({ v: IPC_PROTOCOL_VERSION, kind: "response", id: 3, payload: { result: { exitCode: 0 } } });
    expect(decodeFrame(rustEvent)).toEqual({ v: IPC_PROTOCOL_VERSION, kind: "event", payload: { name: "output", data: { reqId: 3, stream: "stdout", data: "hi" } } });
  });

  it("encode 产出可被自侧 decode round-trip 且单行", () => {
    const line = encodeFrame({ v: IPC_PROTOCOL_VERSION, kind: "request", id: 1, payload: { method: "run", params: { x: "含\n换行与中文" } } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(decodeFrame(line)).toEqual({ v: IPC_PROTOCOL_VERSION, kind: "request", id: 1, payload: { method: "run", params: { x: "含\n换行与中文" } } });
  });

  it("fail-closed 拒收形：坏 JSON/版本不符/非对象/request 缺 id/超长", () => {
    expect(() => decodeFrame("NOT-JSON")).toThrow();
    expect(() => decodeFrame('{"v":4,"kind":"hello","payload":{"protocol":4}}')).toThrow(/version/i);
    expect(() => decodeFrame("[1,2]")).toThrow();
    expect(() => decodeFrame('{"v":5,"kind":"request","payload":{}}')).toThrow(/id/);
    expect(() => decodeFrame('{"v":5,"kind":"mystery"}')).toThrow();
    expect(() => decodeFrame(JSON.stringify({ v: 5, kind: "event", payload: "x".repeat(MAX_FRAME_BYTES + 10) }))).toThrow(/too large/);
    expect(() => encodeFrame({ v: 5, kind: "event", payload: "x".repeat(MAX_FRAME_BYTES + 10) })).toThrow(/too large/);
  });
});
