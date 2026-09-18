// WP-07（M6）文件型 mailbox 单测。判据自足（板 WP-07 DoD③⑤）：
//   ③inbox 顶层非数组或非对象/缺 text 条目＝丢弃并告警（错误文案同构 A 级 §5，禁静默）
//   ⑤flag 默认关=零文件零副作用（读取半边：缺文件=空零告警零落盘；写入半边懒 mkdir——装配层 gate 关=永不触达）
// 锚点：A 级 claude-code-agent-teams.md §5（`_440.js` L55647-55680 五段文案逐字）；命名规则 [自定]①（A 级 §12 未解②）。
import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  MAILBOX_DROP_MISSING_TEXT,
  MAILBOX_DROP_NOT_OBJECT,
  MAILBOX_TOP_LEVEL_DETAIL,
  MAILBOX_TOP_LEVEL_TITLE,
  appendMailbox,
  mailboxDropTitle,
  parseInboxFile,
  readMailbox,
  sanitizeMailboxSegment,
  teammateInboxPath,
  type MailboxFs,
} from "../src/index.ts";

/** 内存 fs（记录调用序；写失败可注入——容错须可证伪）。 */
function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  let failWrite: Error | null = null;
  const fs: MailboxFs = {
    existsSync: (p) => (calls.push(`exists:${p}`), files.has(p)),
    readFileSync: (p) => (calls.push(`read:${p}`), files.get(p)!),
    writeFileSync: (p, data) => {
      calls.push(`write:${p}`);
      if (failWrite) throw failWrite;
      files.set(p, data);
    },
    mkdirSync: (dir) => {
      calls.push(`mkdir:${dir}`);
      for (const k of files.keys()) if (k.startsWith(`${dir}/`)) return;
      files.set(`${dir}/.dir`, ""); // 目录占位（mkdir 非递归语义在 fake 中不展开）
    },
  };
  return { fs, files, calls, failWith: (e: Error) => (failWrite = e) };
}

describe("DoD③ schema 校验与告警（A 级 §5 文案逐字）", () => {
  it("顶层数组+合法条目全保留（其余字段透传）", () => {
    const { entries, warnings } = parseInboxFile(
      JSON.stringify([{ from: "lead", text: "hello", color: "blue", sentAt: "2026-09-18T00:00:00Z", extra: 1 }]),
    );
    expect(warnings).toEqual([]);
    expect(entries).toEqual([{ from: "lead", text: "hello", color: "blue", sentAt: "2026-09-18T00:00:00Z", extra: 1 }]);
  });

  it("顶层非数组（对象/字符串/数字）＝按空处理+两段告警逐字，禁静默", () => {
    for (const bad of [JSON.stringify({ not: "an array" }), JSON.stringify("str"), JSON.stringify(7)]) {
      const { entries, warnings } = parseInboxFile(bad);
      expect(entries).toEqual([]);
      expect(warnings).toEqual([`${MAILBOX_TOP_LEVEL_TITLE} — ${MAILBOX_TOP_LEVEL_DETAIL}`]);
    }
  });

  it("非对象条目（null/数组/标量）＝丢弃并告警（标题带索引+详情逐字）", () => {
    const { entries, warnings } = parseInboxFile(JSON.stringify([null, ["x"], "str", 3, { from: "a", text: "keep" }]));
    expect(entries).toEqual([{ from: "a", text: "keep" }]);
    expect(warnings).toEqual([
      `${mailboxDropTitle(0)} ${MAILBOX_DROP_NOT_OBJECT}`,
      `${mailboxDropTitle(1)} ${MAILBOX_DROP_NOT_OBJECT}`,
      `${mailboxDropTitle(2)} ${MAILBOX_DROP_NOT_OBJECT}`,
      `${mailboxDropTitle(3)} ${MAILBOX_DROP_NOT_OBJECT}`,
    ]);
  });

  it("缺 text 条目＝丢弃并告警（详情逐字）；text 非字符串同规（[自定]④）；空串 text 放行", () => {
    const { entries, warnings } = parseInboxFile(
      JSON.stringify([{ from: "a" }, { from: "b", text: 42 }, { from: "c", text: "" }]),
    );
    expect(entries).toEqual([{ from: "c", text: "" }]);
    expect(warnings).toEqual([`${mailboxDropTitle(0)} ${MAILBOX_DROP_MISSING_TEXT}`, `${mailboxDropTitle(1)} ${MAILBOX_DROP_MISSING_TEXT}`]);
  });

  it("JSON 损坏/半截写＝空 inbox+告警（[自定]③，禁静默）", () => {
    const { entries, warnings } = parseInboxFile('[{"from":"a","text":"trunc');
    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[TeammateMailbox] inbox file unreadable");
  });
});

describe("DoD⑤ 零副作用与懒创建（fs 注入面）", () => {
  it("读缺文件＝空数组零告警零落盘（read 半边零副作用）", () => {
    const t = memFs();
    expect(readMailbox("/root/t/a.inbox.json", t.fs)).toEqual({ entries: [], warnings: [] });
    expect(t.calls.every((c) => c.startsWith("exists:") || c.startsWith("read:"))).toBe(true);
    expect([...t.files.keys()].filter((k) => !k.endsWith(".dir"))).toEqual([]);
  });

  it("append 懒 mkdir+读改写往返（跨实例持久化语义），写入前既有坏条目告警上浮", () => {
    const t = memFs();
    const p = "/root/t/a.inbox.json";
    const w1 = appendMailbox(p, { from: "lead", text: "one" }, t.fs);
    expect(w1).toEqual([]);
    expect(t.calls.some((c) => c.startsWith("mkdir:"))).toBe(true); // 懒创建（首次写才触盘）
    appendMailbox(p, { from: "lead", text: "two" }, t.fs);
    const after = readMailbox(p, t.fs);
    expect(after.entries.map((e) => e.text)).toEqual(["one", "two"]); // 追加不覆盖
    // 预置含坏条目的文件：append 读改写时告警上浮（禁静默），坏条目被清洗。
    const t2 = memFs({ [p]: JSON.stringify([{ from: "x" }, { from: "y", text: "ok" }]) });
    const w2 = appendMailbox(p, { from: "lead", text: "new" }, t2.fs);
    expect(w2).toEqual([`${mailboxDropTitle(0)} ${MAILBOX_DROP_MISSING_TEXT}`]);
    expect(readMailbox(p, t2.fs).entries.map((e) => e.text)).toEqual(["ok", "new"]);
  });

  it("写失败原样抛出（可证伪，非静默吞）", () => {
    const t = memFs();
    t.failWith(new Error("ENOSPC: no space left on device"));
    expect(() => appendMailbox("/root/t/a.inbox.json", { from: "a", text: "x" }, t.fs)).toThrow(/ENOSPC/);
  });
});

describe("[自定]① 文件命名与净化（A 级 §12 未解②——不臆造 [CC] 路径）", () => {
  it("净化：非 [A-Za-z0-9._-] → x<hex>（防穿越），整段为 \".\"/\"..\" 回落 x，空段回落 x", () => {
    expect(sanitizeMailboxSegment("researcher")).toBe("researcher");
    expect(sanitizeMailboxSegment("../etc/passwd")).not.toContain("/");
    expect(sanitizeMailboxSegment("..")).toBe("x"); // 纯点段=相对路径语义，回落（防穿越）
    expect(sanitizeMailboxSegment(".")).toBe("x");
    expect(sanitizeMailboxSegment("a..b")).toBe("a..b"); // 段内点无害（非相对路径语义）
    expect(sanitizeMailboxSegment("a b/c:d")).toBe("ax20bx2fcx3ad");
    expect(sanitizeMailboxSegment("")).toBe("x");
  });

  it("teammateInboxPath 组合形状：<teamsDir>/<净化 teamName>/<净化成员名>.inbox.json（平台路径分隔符无关）", () => {
    expect(teammateInboxPath(path.join("/root", "teams"), "design-team", "researcher")).toBe(
      path.join("/root", "teams", "design-team", "researcher.inbox.json"),
    );
    const hostile = teammateInboxPath(path.join("/root", "teams"), "../../evil", "../..");
    expect(hostile.startsWith(path.join("/root", "teams"))).toBe(true);
    // 穿越判定=路径段级：净化把 "/" 与 "\" 编码为 x2f/x5c，任何段都不再是相对路径语义（".."）。
    const segments = hostile.slice(path.join("/root", "teams").length + 1).split(/[\\/]/);
    expect(segments.length).toBe(2); // 恰两段：<净化 teamName>/<净化成员名>.inbox.json
    for (const seg of segments) expect(seg === ".." || seg === ".").toBe(false);
    expect(hostile.endsWith(".inbox.json")).toBe(true);
  });
});
