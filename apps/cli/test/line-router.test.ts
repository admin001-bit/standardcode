// M8 后修复回归（2026-09-28，P0）：createLineRouter 惰性挂死——真 TTY 未信任目录首跑必卡
// （信任提问早于 REPL 消费 lines；waiter 无搬运工）。判别性用例=首例：修复前永不 resolve（vitest 超时=红）。
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createLineRouter } from "../src/main.ts";

function mkRouter() {
  const input = new PassThrough();
  const rl = createInterface({ input, terminal: false });
  const router = createLineRouter(rl);
  return { input, router };
}

describe("createLineRouter（P0 修复回归）", () => {
  it("不消费 lines 时 askLine 也能拿到行（修复前必挂死）", async () => {
    const { input, router } = mkRouter();
    const p = router.askLine("trust? [y/N]: ");
    input.write("y\n");
    await expect(p).resolves.toBe("y");
  });

  it("无 waiter 时行进入 REPL 流（原语义保持）", async () => {
    const { input, router } = mkRouter();
    const it = router.lines[Symbol.asyncIterator]();
    input.write("hello\n");
    await expect(it.next()).resolves.toEqual({ value: "hello", done: false });
  });

  it("askLine 优先消费；其后行归 lines（双路不串）", async () => {
    const { input, router } = mkRouter();
    const it = router.lines[Symbol.asyncIterator]();
    const p = router.askLine("q? ");
    input.write("first\n");
    await expect(p).resolves.toBe("first");
    input.write("second\n");
    await expect(it.next()).resolves.toEqual({ value: "second", done: false });
  });

  it("EOF：挂起 askLine 以 null 收束（S6-1：EOF≠空串，提问方按语义 fail-closed）；挂起 lines 直接终止（不吐空行）", async () => {
    const { input, router } = mkRouter();
    const it = router.lines[Symbol.asyncIterator]();
    const p = router.askLine("q? ");
    const n = it.next(); // lines 的 waiter 先行挂上（覆盖 close 收束路径）
    input.end();
    await expect(p).resolves.toBeNull();
    await expect(n).resolves.toEqual({ value: undefined, done: true });
  });

  it("S6-1 回归：真实空行仍解析为空串（回车=once 缺省档语义不变，与 EOF 可分）", async () => {
    const { input, router } = mkRouter();
    const p = router.askLine("q? ");
    input.write("\n");
    await expect(p).resolves.toBe("");
  });

  it("S6-1 回归：EOF 之后迟到的 askLine 直接得 null（不挂死）", async () => {
    const { input, router } = mkRouter();
    input.end();
    await new Promise((r) => setTimeout(r, 10)); // 等 pump 收束（closed=true）
    await expect(router.askLine("q? ")).resolves.toBeNull();
  });

  it("管道场景：缓冲行取尽后 lines 终止（非 TTY 跑完即退）", async () => {
    const { input, router } = mkRouter();
    input.write("a\nb\n");
    input.end();
    const it = router.lines[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: "a", done: false });
    await expect(it.next()).resolves.toEqual({ value: "b", done: false });
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
