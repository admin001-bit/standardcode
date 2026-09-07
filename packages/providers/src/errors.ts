// HTTP/网络错误分类：驱动重试判定（retryable）与 §5.4 恢复链② prompt-too-long 识别。
// ENG-072 错误三件套（发生了什么/为什么/建议动作）由上层 UI 组装，本层保留 status+正文摘录作原料。

export type ProviderErrorKind =
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "invalid_request"
  | "context_length"
  | "network"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts?: { status?: number; retryable?: boolean; retryAfterMs?: number | null; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts?.status ?? null;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs ?? null;
  }
}

// 上下文超限识别（两协议常见措辞）；Anthropic 官方文案 "prompt is too long"
const CONTEXT_LENGTH_RE = /prompt is too long|context[_ ]length|maximum context length/i;

export async function classifyHttpError(res: Response): Promise<ProviderError> {
  const status = res.status;
  const bodyText = await res.text().catch(() => "");
  let retryAfterMs: number | null = null;
  const retryAfterRaw = res.headers.get("retry-after");
  if (retryAfterRaw) {
    const secs = Number(retryAfterRaw);
    if (Number.isFinite(secs) && secs >= 0) retryAfterMs = secs * 1000;
  }

  let kind: ProviderErrorKind;
  let retryable = false;
  if (status === 401 || status === 403) {
    kind = "auth";
  } else if (status === 408) {
    kind = "network";
    retryable = true;
  } else if (status === 429) {
    kind = "rate_limit";
    retryable = true;
  } else if (status === 529) {
    // Anthropic overloaded 专用码
    kind = "overloaded";
    retryable = true;
  } else if (status >= 500) {
    kind = "unknown";
    retryable = true;
  } else if (status === 400 && CONTEXT_LENGTH_RE.test(bodyText)) {
    kind = "context_length";
  } else {
    kind = "invalid_request";
  }
  return new ProviderError(kind, `${status} ${bodyText.slice(0, 300)}`, {
    status,
    retryable,
    retryAfterMs,
  });
}

export function classifyNetworkError(err: unknown): ProviderError {
  return new ProviderError("network", err instanceof Error ? err.message : String(err), {
    retryable: true,
    cause: err,
  });
}
