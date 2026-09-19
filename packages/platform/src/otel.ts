// L6 OTel 导出（M7-WP-05；v2.8 ENG-090 行 433「OTel 导出可插拔」× SEC-050 行 458 遥测默认关/opt-in/可一键关
// × §5.2 行 226 platform-services L6（[CC] `_367.js`（OTel）同面）× §1.4 行 94 默认零上报）。
// 架构位置：本模块只提供**导出通道**（TelemetrySink 实现之一），事件契约/opt-in 门/脱敏单源仍在 telemetry.ts——
// 接缝㉒（OTel 导出 × 遥测 opt-in 门）：门关=零构造零外发（**SDK 亦不加载**：动态 import 只在门开且 endpoint 在位时）；
// 门开=事件经上游 sanitizeProps→redactSecrets **同一单源**后入 span（本模块不另写脱敏=禁旁路）。
// SDK 依赖（DoD④ 锁版本登记）：@opentelemetry/api 1.9.1 / sdk-trace-base 2.11.0 / exporter-trace-otlp-http 0.222.0
// （精确版本，无 ^ 漂移；packages/platform/package.json 与 pnpm-lock.yaml 同步）。

// type-only import：编译期擦除，运行时不产生任何 SDK 加载（关态零构造硬要求）。
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TelemetryEnvelope, TelemetrySink } from "./telemetry.ts";

// —— 配置键（ADR-0030 家族 [自定]：env 逃逸舱 > settings > 缺省无 endpoint；与 telemetry.enabled 同门序形制）——
export const OTEL_ENDPOINT_ENV_KEY = "STANDARD_CODE_OTLP_ENDPOINT";
export const OTEL_ENDPOINT_SETTINGS_KEY = "telemetry.otlpEndpoint";
/** tracer/service.name 缺省（[自定]；与包名 @standardcode-oss/cli 同源）。 */
export const OTEL_DEFAULT_SERVICE_NAME = "standardcode";

export interface OtelEndpointInput {
  env?: Record<string, string | undefined>;
  settingsEndpoint?: unknown;
}

/**
 * endpoint 解析序：env `STANDARD_CODE_OTLP_ENDPOINT` > settings `telemetry.otlpEndpoint` > undefined。
 * 空串/非字符串 = undefined（fail-closed 不猜、不外发）；endpoint 缺席即不启用 OTel 通道（门开也不外发）。
 */
export function resolveOtelEndpoint(input: OtelEndpointInput): string | undefined {
  const raw = input.env?.[OTEL_ENDPOINT_ENV_KEY];
  if (raw !== undefined && raw !== "") return raw;
  const s = input.settingsEndpoint;
  if (typeof s === "string" && s !== "") return s;
  return undefined;
}

export interface CreateOtelSinkOptions {
  /** OTLP/HTTP endpoint（缺省 undefined=不启用，见 resolveOtelEndpoint）。 */
  endpoint?: string | undefined;
  serviceName?: string;
  /** 测试注入 exporter（缺席=真实 OTLPTraceExporter 通道）。 */
  exporter?: SpanExporter | undefined;
  /**
   * OTLP exporter 模块加载器（缺席=真实动态 import）。
   * 注入面存在的理由：vitest 对该 ESM 包的 `vi.mock` 不生效（externalize），「关态是否加载 SDK」
   * 无法经 mock 计数判别——经本注入点计数方为可判别判据（避免恒真的假证据）。
   */
  loadOtlpExporter?: (() => Promise<{ OTLPTraceExporter: new (cfg: { url: string }) => unknown }>) | undefined;
}

/** 事件→span 属性（原语直通；undefined 跳过；**不做二次脱敏**——脱敏单源在上游 emit，禁旁路复制）。 */
function toAttributes(props: TelemetryEnvelope["properties"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 创建 OTel 导出 sink。门关或 endpoint 缺席 → 返回 null（**零构造、零 SDK 加载、零外发**）。
 * 门开 → 动态 import SDK（关态不付加载成本），事件逐个映射为 instant span（span 名=事件名，
 * attributes=属性，start=end=事件时间戳 [自定]：遥测事件是离散点，非区间）。
 */
export async function createOtelSink(opts: CreateOtelSinkOptions = {}): Promise<TelemetrySink | null> {
  const endpoint = opts.endpoint;
  if (endpoint === undefined || endpoint === "") return null; // 零构造（SEC-050 默认关口径）
  const { BasicTracerProvider, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  let exporter = opts.exporter;
  if (exporter === undefined) {
    const mod =
      opts.loadOtlpExporter !== undefined
        ? await opts.loadOtlpExporter()
        : ((await import("@opentelemetry/exporter-trace-otlp-http")) as unknown as { OTLPTraceExporter: new (cfg: { url: string }) => unknown });
    exporter = new mod.OTLPTraceExporter({ url: endpoint }) as unknown as SpanExporter;
  }
  // resource：service.name 走官方 Resource（OTel 语义属性；后端按此分组）。resources 与 sdk-trace-base 同版本族（2.11.0）。
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName ?? OTEL_DEFAULT_SERVICE_NAME }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer(opts.serviceName ?? OTEL_DEFAULT_SERVICE_NAME);
  const sink: TelemetrySink & { flush(): Promise<void>; shutdown(): Promise<void> } = {
    write(events: readonly TelemetryEnvelope[]): void {
      for (const e of events) {
        const span = tracer.startSpan(e.event, { startTime: e.timestamp, attributes: toAttributes(e.properties) });
        span.end(e.timestamp);
      }
    },
    async flush(): Promise<void> {
      await provider.forceFlush();
    },
    async shutdown(): Promise<void> {
      await provider.shutdown();
    },
  };
  return sink;
}
