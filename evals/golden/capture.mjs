// WP-10 Golden 快照采集（v2.8 §12.2 Golden 行、§7.1 CTX-100/CTX-004、DP-2 前缀稳定>表达丰富）。
// 口径 [自定]：快照=materializeLayout 产物（segments/system/messages）+六工具定义（请求注入面，经 createStandardTools 元数据），
// 模型固定 claude-sonnet-4-6 夹具；夹具内容全合成（无真实用户数据）。
// 脱敏：home/tmp/cwd/盘符路径 → 占位符；无时间戳/版本号（跨机可比）。基线入库前必须过本脱敏。
// GOLDEN_IDENTITY_EXTRA：演示钩子（DoD③）——向 identity 段追加一行，模拟"对 prompt 分区改动"跑 Golden 对比；
// 生产代码不读此 env，仅本采集器消费。
import { homedir, tmpdir } from "node:os";
import { buildSegments, materializeLayout } from "../../packages/context/src/prompt-layout/layout.ts";
import { createStandardTools } from "../../packages/capabilities/src/tool-factory.ts";

const cwd = process.cwd();
const rules = [];
for (const [label, value] of [
  ["<home>", homedir()],
  ["<tmp>", tmpdir()],
  ["<cwd>", cwd],
]) {
  if (value && value !== "/") rules.push([value, label]);
}
function sanitize(text) {
  let s = text;
  for (const [from, to] of rules) s = s.split(from).join(to);
  s = s.replace(/[A-Za-z]:\\[^\s"']*/g, "<path>");
  s = s.replace(/\/(?:home|Users)\/[^\s"'/]+/g, "<home>");
  return s;
}
function deepSanitize(v) {
  if (typeof v === "string") return sanitize(v);
  if (Array.isArray(v)) return v.map(deepSanitize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSanitize(x)]));
  return v;
}

const extra = process.env.GOLDEN_IDENTITY_EXTRA ?? "";
const identity = [
  "You are StandardCode, an interactive CLI coding agent.",
  "You help the user with software engineering tasks in the current workspace.",
  ...(extra ? [extra] : []),
].join("\n");

const tools = createStandardTools({ cwd: "<cwd-fixture>" });

const input = {
  identity,
  tools: tools.map((t) => ({ name: t.name, description: t.description })),
  dynamic: [{ text: "gitStatus: (clean) on branch main" }],
  history: [
    { role: "user", content: [{ type: "text", text: "List the files in the current directory." }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture_01", name: "Glob", input: { pattern: "**/*" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_fixture_01", content: "README.md" }] },
    { role: "assistant", content: [{ type: "text", text: "The workspace contains README.md." }] },
  ],
  capabilities: {
    contextWindow: 128_000,
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    thinking: "adaptive",
    input: ["text", "image"],
    streaming: true,
    toolCalling: true,
    cache: { ttlLevels: ["5m", "1h"], explicitBreakpoints: true },
  },
};

const layout = materializeLayout(buildSegments(input), input);

const snapshot = {
  schema: "standardcode-golden-snapshot@1",
  model: "claude-sonnet-4-6",
  segments: layout.segments,
  system: layout.system,
  messages: layout.messages,
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
};

process.stdout.write(JSON.stringify(deepSanitize(snapshot), null, 2) + "\n");
