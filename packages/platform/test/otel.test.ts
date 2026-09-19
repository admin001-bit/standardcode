// WP-05（M7）OTel 导出测试（v2.8 ENG-090 行 433「OTel 导出可插拔」× SEC-050 行 458 × §5.2 行 226；判据自足：板 WP-05 DoD①-⑤）。
// 零网络原则：导出器一律用 InMemorySpanExporter 注入（真实 OTLP 外发=外发动作，不本卡实跑）。
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTelemetryFacade, type TelemetrySink } from "../src/telemetry.ts";
import { OTEL_ENDPOINT_ENV_KEY, createOtelSink, resolveOtelEndpoint } from "../src/otel.ts";

// SDK 加载计数：经 createOtelSink 的 loadOtlpExporter 注入点计数（vi.mock 对该 ESM 包不生效，
// 直接 mock 计数会恒 0=假证据；注入计数才是可判别形式——针 B 曾因此 0 红）。
function countingLoader(): { fn: () => Promise<{ OTLPTraceExporter: new (cfg: { url: string }) => unknown }>; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      const mod = (await import("@opentelemetry/exporter-trace-otlp-http")) as unknown as { OTLPTraceExporter: new (cfg: { url: string }) => unknown };
      return mod;
    },
    calls: () => calls,
  };
}

function spansOf(exporter: InMemorySpanExporter) {
  return exporter.getFinishedSpans();
}

describe("DoD① 默认关=零构造零外发（负查）", () => {
  it("无 endpoint → createOtelSink 返回 null（零构造）", async () => {
    await expect(createOtelSink({})).resolves.toBeNull();
    await expect(createOtelSink({ endpoint: undefined })).resolves.toBeNull();
    await expect(createOtelSink({ endpoint: "" })).resolves.toBeNull();
  });

  it("零构造=SDK 亦不加载（注入计数：关态 0 次 / 门开 1 次，双向确证）", async () => {
    const off = countingLoader();
    await createOtelSink({ loadOtlpExporter: off.fn }); // 关态（endpoint 缺席）
    expect(off.calls()).toBe(0); // 关态不加载 SDK
    const on = countingLoader();
    const sink = (await createOtelSink({
      endpoint: "http://127.0.0.1:4318/v1/traces",
      loadOtlpExporter: on.fn,
    })) as TelemetrySink & { shutdown(): Promise<void> };
    expect(on.calls()).toBe(1); // 门开才加载（判别力双向）
    if (sink?.shutdown !== undefined) await sink.shutdown();
  });

  it("门关时 facade emit → exporter 收到 0 span（零外发，接缝㉒ 关侧）", async () => {
    const exporter = new InMemorySpanExporter();
    const sink = (await createOtelSink({ endpoint: "http://127.0.0.1:4318/v1/traces", exporter })) as TelemetrySink & { shutdown(): Promise<void> };
    expect(sink).not.toBeNull();
    try {
      // 门关（env 未开、settings 未开 → 默认关）
      const facade = createTelemetryFacade({ sessionId: "s-1", env: {}, settingsEnabled: undefined, sink });
      expect(facade.isEnabled()).toBe(false);
      facade.turnEnd({ terminalReason: "completed", durationMs: 12 });
      facade.queryError({ message: "boom" });
      await facade.flush();
      expect(spansOf(exporter)).toHaveLength(0); // 门关零外发
    } finally {
      await sink.shutdown();
    }
  });
});

describe("DoD② 开启后事件经单源脱敏可断言 + DoD③ 接缝㉒ 开侧", () => {
  it("门开：事件入 span 且字符串属性已过 redactSecrets 单源", async () => {
    const exporter = new InMemorySpanExporter();
    const sink = (await createOtelSink({ endpoint: "http://127.0.0.1:4318/v1/traces", exporter })) as TelemetrySink & { shutdown(): Promise<void> };
    try {
      const facade = createTelemetryFacade({ sessionId: "s-2", env: { STANDARD_CODE_TELEMETRY: "1" }, sink });
      expect(facade.isEnabled()).toBe(true);
      const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      facade.queryError({ message: `failed with ${secret}` });
      await facade.flush();
      const spans = spansOf(exporter);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("sc_query_error"); // span 名=事件名（ENG-090 名逐字）
      const msg = spans[0]!.attributes["message"] as string;
      expect(msg).toBeDefined();
      expect(msg).not.toContain(secret); // 脱敏单源生效（SEC-030/接缝⑮ 同一函数）
      expect(msg).toContain("[REDACTED"); // redactSecrets 占位形
    } finally {
      await sink.shutdown();
    }
  });

  it("门开：多事件逐枚入 span（turn_end 参数逐字对位 ENG-090）", async () => {
    const exporter = new InMemorySpanExporter();
    const sink = (await createOtelSink({ endpoint: "http://127.0.0.1:4318/v1/traces", exporter })) as TelemetrySink & { shutdown(): Promise<void> };
    try {
      const facade = createTelemetryFacade({ sessionId: "s-3", env: { STANDARD_CODE_TELEMETRY: "1" }, sink });
      facade.turnEnd({ terminalReason: "completed", durationMs: 42 });
      facade.toolUseCancelled();
      facade.subagentLaunch({ outcome: "launched", taskId: "t-1" });
      await facade.flush();
      const spans = spansOf(exporter);
      expect(spans.map((s) => s.name)).toEqual(["sc_turn_end", "sc_tool_use_cancelled", "sc_subagent_launch"]);
      const turnEnd = spans[0]!;
      expect(turnEnd.attributes["terminal_reason"]).toBe("completed");
      expect(turnEnd.attributes["turn_count"]).toBe(1);
      expect(turnEnd.attributes["duration_ms"]).toBe(42);
      expect(spans[2]!.attributes["outcome"]).toBe("launched");
    } finally {
      await sink.shutdown();
    }
  });
});

describe("endpoint 配置键与解析序（ADR-0030 家族：env > settings > 缺省）", () => {
  it("env 逃逸舱凌驾 settings；空串/非字符串=undefined（fail-closed 不猜）", () => {
    const envVal = "http://env:4318/v1/traces";
    expect(resolveOtelEndpoint({ env: { [OTEL_ENDPOINT_ENV_KEY]: envVal }, settingsEndpoint: "http://settings:4318/v1/traces" })).toBe(envVal);
    expect(resolveOtelEndpoint({ env: {}, settingsEndpoint: "http://settings:4318/v1/traces" })).toBe("http://settings:4318/v1/traces");
    expect(resolveOtelEndpoint({ env: { [OTEL_ENDPOINT_ENV_KEY]: "" }, settingsEndpoint: "http://settings:4318/v1/traces" })).toBe("http://settings:4318/v1/traces");
    expect(resolveOtelEndpoint({ env: {}, settingsEndpoint: 123 })).toBeUndefined();
    expect(resolveOtelEndpoint({})).toBeUndefined();
  });
});

describe("DoD④ SDK 依赖锁版本登记（精确版本，无 ^/~ 漂移）", () => {
  it("packages/platform/package.json 三依赖为精确版本", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
    const deps = pkg["dependencies"] ?? {};
    expect(deps["@opentelemetry/api"]).toBe("1.9.1");
    expect(deps["@opentelemetry/sdk-trace-base"]).toBe("2.11.0");
    expect(deps["@opentelemetry/exporter-trace-otlp-http"]).toBe("0.222.0");
    // 精确版本=不含区间前缀（锁版本口径）
    for (const v of [deps["@opentelemetry/api"], deps["@opentelemetry/sdk-trace-base"], deps["@opentelemetry/exporter-trace-otlp-http"]]) {
      expect(v).not.toMatch(/^[\^~]/);
    }
  });
});
