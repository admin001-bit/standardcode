// WP-01 stdio 真子进程集成（DoD⑥：缺省 spawn 形态+会话 env 注入+溢出断连；DoD③④ 全链状态机）。
// fixture=纯 node stdin/stdout JSON-RPC 回声 server（零外部依赖，M3 task-panel 真子进程先例形制）。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectServer, loadMcpServerConfigs, StdioTransport, type McpServerEntry } from "../src/index.ts";

let dir: string;
let fixture: string;

const FIXTURE = `
// MCP stdio fixture：initialize 回声；initialized 后向 client 发 roots/list；
// 收到应答后把 roots+环境探针写 stderr（测试经 transport.stderrText 观察）。
let buf = "";
const q = [];
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const t = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (t) q.push(JSON.parse(t));
    pump();
  }
});
function send(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
function pump() {
  for (;;) {
    const m = q.shift();
    if (!m) return;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: "fixture-stdio" }, capabilities: {} } });
    } else if (m.method === "notifications/initialized") {
      send({ jsonrpc: "2.0", id: "srv1", method: "roots/list" });
    } else if (m.id === "srv1" && m.result) {
      process.stderr.write("ROOTS " + JSON.stringify(m.result.roots) + "\\n");
      process.stderr.write("ENV " + JSON.stringify({
        dir: process.env.STANDARD_CODE_PROJECT_DIR, sid: process.env.STANDARD_CODE_SESSION_ID, mcp: process.env.STANDARD_CODE_MCP,
        probe: process.env.MCP_TEST_PROBE,
        noKey: process.env.ANTHROPIC_API_KEY === undefined, noSC: process.env.STANDARD_CODE_MODEL === undefined,
        hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
      }) + "\\n");
    }
  }
}
`;

// 溢出 fixture：无 JSON-RPC 边界的巨量 stdout。
const FLOOD_FIXTURE = `
process.stdout.write("x".repeat(200000));
setTimeout(() => process.exit(0), 500);
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-mcp-wp01-"));
  fixture = join(dir, "server.mjs");
  await writeFile(fixture, FIXTURE, "utf8");
  await writeFile(join(dir, "flood.mjs"), FLOOD_FIXTURE, "utf8");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows EBUSY：子进程收尾异步
});

const entry = (config: McpServerEntry["config"]): McpServerEntry => ({ name: "fx", origin: "user", config });

async function waitFor(pred: () => boolean, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("stdio 全链（DoD③④⑥）", () => {
  it("真实握手 connected；会话 env+config.env 插值下沉；API key/STANDARD_CODE_MODEL 不下沉（SEC-080 基底）；roots/list 往返", async () => {
    const cwd = dir;
    const sessionId = "sess-42";
    const envBase = { ...process.env, ANTHROPIC_API_KEY: "sk-must-not-leak", STANDARD_CODE_MODEL: "secret-model", MCP_TEST_SRC: "hello" };
    // 经 loader 终态（${VAR} 插值=装载期语义，config.ts；DoD⑤⑥ 全链整合）。
    const loaded = loadMcpServerConfigs(
      { user: { mcpServers: { fx: { type: "stdio", command: process.execPath, args: [fixture], env: { MCP_TEST_PROBE: "${MCP_TEST_SRC}!" } } } } },
      envBase,
    );
    expect(loaded.issues).toEqual([]);
    let captured: StdioTransport | null = null;
    const conn = await connectServer(
      loaded.servers[0],
      {
        cwd,
        sessionId,
        envBase,
        transportFactory: (config) => {
          captured = new StdioTransport({ config: config as never, cwd, sessionId, baseEnv: envBase });
          return captured;
        },
      },
    );
    expect(conn.status).toBe("connected");
    expect(conn.serverInfo).toEqual({ name: "fixture-stdio" });
    expect(conn.protocolVersion).toBe("2025-06-18");
    await waitFor(() => captured!.stderrText.includes("ENV ") && captured!.stderrText.includes("ROOTS "));
    const envLine = JSON.parse(captured!.stderrText.match(/ENV (\{.*\})/)![1]);
    expect(envLine).toMatchObject({ sid: "sess-42", mcp: "1", probe: "hello!", noKey: true, noSC: true, hasPath: true });
    expect(envLine.dir.replace(/\\/g, "/")).toBe(cwd.replace(/\\/g, "/"));
    const roots = JSON.parse(captured!.stderrText.match(/ROOTS (\[.*\])/)![1]);
    expect(roots[0].uri.startsWith("file:")).toBe(true);
    const base = dir.split(/[\\/]/).pop()!;
    expect(roots[0].uri.replace(/\\/g, "/").toLowerCase()).toContain(base.toLowerCase());
    await conn.close();
  }, 20000);

  it("stdout 无边界巨量输出=溢出断连 failed（不悬挂；文案含 stdout/Disconnecting，形状 :285543）", async () => {
    const conn = await connectServer(
      entry({ type: "stdio", command: process.execPath, args: [join(dir, "flood.mjs")] }),
      { cwd: dir, sessionId: "s-overflow", maxLineBytes: 4096 },
    );
    expect(conn.status).toBe("failed");
    expect(conn.error).toMatch(/stdout/i);
    expect(conn.error).toMatch(/Disconnecting/);
  }, 15000);

  it("spawn 失败（command 不存在）→failed 降级不抛（DoD④）", async () => {
    const conn = await connectServer(
      entry({ type: "stdio", command: "definitely-not-a-real-binary-xyz" }),
      { cwd: dir, sessionId: "s-missing" },
    );
    expect(conn.status).toBe("failed");
    expect(conn.error).toBeTruthy();
  }, 15000);
});
