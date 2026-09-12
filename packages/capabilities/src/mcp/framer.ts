// stdio 换行分帧 + 溢出守卫（BoundedStdioClientTransport 同构：YO=16777216 dig-05 §6 :45637，
// 溢出断连+文案形状 :285543——server 把日志写 stdout=协议污染，宁可断不可猜）。

export const MCP_STDOUT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class StdoutOverflowError extends Error {}

/** newline-delimited JSON-RPC 分帧器：feed 原始 chunk，返回完整帧（对象）。 */
export class NdjsonFramer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private overflow: StdoutOverflowError | null = null;

  constructor(private readonly maxLineBytes: number = MCP_STDOUT_MAX_LINE_BYTES) {}

  /** 喂入原始字节；溢出=置位终态错误（后续帧全部丢弃，由调用方断连）。 */
  push(chunk: Buffer | string): unknown[] {
    if (this.overflow) return [];
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const out: unknown[] = [];
    let rest = Buffer.concat([...this.chunks, buf]);
    this.chunks = [];
    this.bytes = 0;
    let idx: number;
    while ((idx = rest.indexOf(0x0a)) >= 0) {
      const line = rest.subarray(0, idx);
      rest = rest.subarray(idx + 1);
      const msg = this.decode(line);
      if (msg !== undefined) out.push(msg);
      if (this.overflow) return out;
    }
    // 残行守卫：未收满一行但已超限=非协议巨量输出（无 JSON-RPC 消息边界）→ 溢出。
    if (rest.length > this.maxLineBytes) {
      this.fail(rest.length);
      return out;
    }
    if (rest.length > 0) {
      this.chunks = [rest];
      this.bytes = rest.length;
    }
    return out;
  }

  private decode(line: Buffer): unknown | undefined {
    if (line.length > this.maxLineBytes) {
      this.fail(line.length);
      return undefined;
    }
    const text = line.toString("utf8").trim();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined; // 非 JSON 行（污染输出）：忽略帧但计入溢出判定外的宽容面——[自定] 宽容度：单行坏 JSON 不炸连（server 混发日志行仍可工作，直到超限断连）。
    }
  }

  private fail(size: number): void {
    this.overflow = new StdoutOverflowError(
      `MCP stdio server wrote >${Math.floor(this.maxLineBytes / (1024 * 1024))}MB to stdout without a JSON-RPC message boundary. ` +
        `The server is likely writing logs or other non-protocol data to stdout instead of stderr. Disconnecting... (offending segment: ${size} bytes)`,
    );
  }

  get overflowError(): StdoutOverflowError | null {
    return this.overflow;
  }
}
