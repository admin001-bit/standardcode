// WP-09（M3）项目级 agent 定义解析+SEC-070 信任门测试（判据自足：板 WP-09 DoD①-⑤；
// frontmatter 逐键锚=A 级 claude-code-subagent.md §5.3 IAo _440.js:70356-70513；信任门锚=v2.8 :459）。
import { describe, expect, it } from "vitest";
import { gateProjectAgentDefinitions, parseAgentMarkdown, splitFrontmatter, type AgentTrustRecord } from "../src/agent-definitions.ts";
import { BUILT_IN_AGENTS, createAgentRegistry } from "../src/agent-registry.ts";

const FULL = [
  "---",
  "schemaVersion: 1",
  "name: db-migration",
  'description: "Handles DB migrations.\\nUse for schema changes"', // `\n` 字面量转真实换行（:70376-70385）
  "model: claude-haiku-4-5",
  "tools: Read, Glob, Grep, Bash",
  "permissionMode: acceptEdits",
  "maxTurns: 12",
  "background: 'true'",
  "isolation: worktree",
  "initialPrompt: start with the diff",
  "color: purple",
  "memory: project",
  "effort: high",
  "---",
  "You are a DB migration agent.",
  "Always snapshot first.",
].join("\n");

describe("DoD① frontmatter 逐键解析", () => {
  it("全键样本逐键落位（正文=systemPrompt；A 级 §5.3 逐行对应）", () => {
    const { def, warnings } = parseAgentMarkdown(FULL, "db-migration.md");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("db-migration");
    expect(def!.description).toBe("Handles DB migrations.\nUse for schema changes"); // \n 字面量已转换
    expect(def!.model).toBe("claude-haiku-4-5");
    expect(def!.tools).toEqual(["Read", "Glob", "Grep", "Bash"]); // mF 逗号列表（:70435）
    expect(def!.permissionMode).toBe("acceptEdits");
    expect(def!.maxTurns).toBe(12);
    expect(def!.background).toBe(true); // 仅 'true'/'false'（:70392-70397）
    expect(def!.isolation).toBe("worktree"); // 标记透传（卡边界）
    expect(def!.initialPrompt).toBe("start with the diff");
    expect(def!.systemPrompt).toBe("You are a DB migration agent.\nAlways snapshot first.");
    // 无 M3 消费面的键：合法值丢键告警（不拒收）
    for (const k of ["color", "effort"]) expect(warnings.some((w) => w.includes(k))).toBe(true); // 【勘误 2026-09-13：WP-06 MEM-030 消费 memory 键（入 def.memory），告警断言移除】
  });

  it("model: inherit 特判位保留（:70386-70391）", () => {
    const { def } = parseAgentMarkdown("---\nschemaVersion: 1\nname: x\ndescription: d\nmodel: inherit\n---\n", "x.md");
    expect(def!.model).toBe("inherit");
  });

  it("name 三规：必填 / 不以 '-' 开头 / NFKC 后不含 ':'（插件命名空间保留，:70359-70375）", () => {
    expect(parseAgentMarkdown("---\ndescription: d\n---\n", "a.md").def).toBeNull();
    expect(parseAgentMarkdown("---\ndescription: d\n---\n", "a.md").warnings[0]).toContain("'name' is required");
    expect(parseAgentMarkdown("---\nname: -lead\ndescription: d\n---\n", "b.md").def).toBeNull();
    const colon = parseAgentMarkdown("---\nname: fullwidth：colon\ndescription: d\n---\n", "c.md"); // 值内全角冒号 NFKC 归一后命中（:70359-70375）
    expect(colon.def).toBeNull();
    expect(colon.warnings[0]).toContain("must not contain ':'");
  });

  it("description 必填（:70376-70385）", () => {
    const r = parseAgentMarkdown("---\nname: x\n---\n", "d.md");
    expect(r.def).toBeNull();
    expect(r.warnings[0]).toContain("'description' is required");
  });

  it("非法值=丢键告警、定义保留（background/permissionMode/maxTurns/isolation 逐键）", () => {
    const { def, warnings } = parseAgentMarkdown(
      "---\nschemaVersion: 1\nname: x\ndescription: d\nbackground: maybe\npermissionMode: superuser\nmaxTurns: 0\nisolation: cloud\n---\n",
      "e.md",
    );
    expect(def).not.toBeNull();
    expect(def!.background).toBeUndefined();
    expect(def!.permissionMode).toBeUndefined();
    expect(def!.maxTurns).toBeUndefined();
    expect(def!.isolation).toBeUndefined();
    expect(warnings.length).toBe(4);
    expect(warnings.some((w) => w.includes("maxTurns must be a positive integer"))).toBe(true);
  });

  it("tools 行内数组与块列表两种形态", () => {
    const inline = parseAgentMarkdown("---\nschemaVersion: 1\nname: x\ndescription: d\ntools: [Read, Grep]\n---\n", "f.md");
    expect(inline.def!.tools).toEqual(["Read", "Grep"]);
    const block = parseAgentMarkdown("---\nschemaVersion: 1\nname: x\ndescription: d\ntools:\n  - Read\n  - Glob\n---\n", "g.md");
    expect(block.def!.tools).toEqual(["Read", "Glob"]);
  });
});

describe("DoD④/⑤ 解析失败告警继续 + schemaVersion 迁移提示", () => {
  it("无/未闭合 frontmatter=整体拒收（def=null，调用方告警继续）", () => {
    const noFm = parseAgentMarkdown("just a body, no frontmatter", "h.md");
    expect(noFm.def).toBeNull();
    expect(noFm.warnings[0]).toContain("frontmatter");
    const unterminated = parseAgentMarkdown("---\nname: x\ndescription: d\nbody...", "i.md");
    expect(unterminated.def).toBeNull();
  });

  it("schemaVersion 缺失=迁移提示不拒收；未知版本=best-effort 告警（ENG-080 DoD⑤）", () => {
    const missing = parseAgentMarkdown("---\nname: x\ndescription: d\n---\n", "j.md");
    expect(missing.def).not.toBeNull();
    expect(missing.warnings.some((w) => w.includes("schemaVersion missing") && w.includes("ENG-080"))).toBe(true);
    const future = parseAgentMarkdown("---\nschemaVersion: 2\nname: x\ndescription: d\n---\n", "k.md");
    expect(future.def).not.toBeNull();
    expect(future.warnings.some((w) => w.includes("unknown schemaVersion"))).toBe(true);
  });

  it("未知键告警忽略；skills=不实现告警（卡边界）；mcpServers=名称引用【勘误 2026-09-14 WP-10 ADR-0043 决策 5：原『M4 不实现』改真接】；hooks 在场=hooksRequested", () => {
    const { def, warnings } = parseAgentMarkdown(
      "---\nschemaVersion: 1\nname: x\ndescription: d\nskills: a\nmcpServers:\n  - alpha\n  - 42\nweirdKey: c\nhooks:\n  - PreToolUse\n---\n",
      "l.md",
    );
    expect(def!.hooksRequested).toBe(true); // 块形 hooks（单行 JSON 不可达）=仅在场标记
    expect(def!.hooks).toBeUndefined();
    expect(warnings.some((w) => w.includes("hooks not a single-line JSON"))).toBe(true);
    expect(warnings.some((w) => w.includes("skills ignored (M4"))).toBe(true);
    expect(def!.mcpServers).toEqual(["alpha", "42"]); // 字符串名引用=真消费（块列表经最小 YAML 子集全为字符串；非字符串条目防御丢弃分支见 parse 面）
    expect(warnings.some((w) => w.includes("mcpServers"))).toBe(false);
    expect(warnings.some((w) => w.includes("unknown frontmatter key 'weirdKey'"))).toBe(true);
  });

  it("WP-10 hooks 单行 JSON 实体解析（ADR-0043 决策 6）+mcpServers 行内列表形", () => {
    const { def, warnings } = parseAgentMarkdown(
      '---\nschemaVersion: 1\nname: hkv\ndescription: d\nhooks: {"PreToolUse":[{"hooks":[{"type":"command","command":"node deny.js"}]}]}\nmcpServers: [srv-a, srv-b]\n---\n',
      "hkv.md",
    );
    expect(def!.hooksRequested).toBe(true);
    expect(Object.keys(def!.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(def!.mcpServers).toEqual(["srv-a", "srv-b"]);
    expect(warnings).toEqual([]);
  });
});

// —— SEC-070 信任门（:459 全规则）——

function escalateDef() {
  return parseAgentMarkdown("---\nschemaVersion: 1\nname: risky\ndescription: d\npermissionMode: bypassPermissions\n---\nbody", "risky.md");
}

describe("DoD② 信任门：未信任一律不加载、仅内置可用", () => {
  it("trusted=false → layerWithheld+loadable=[]（含提权字段与否都不加载）", async () => {
    const defs = [escalateDef(), parseAgentMarkdown("---\nschemaVersion: 1\nname: plain\ndescription: d\n---\n", "plain.md")];
    const r = await gateProjectAgentDefinitions(defs, { trusted: false });
    expect(r.loadable).toEqual([]);
    expect(r.layerWithheld).toBe(true);
    expect(r.warnings.length).toBe(2);
    expect(r.warnings[0]).toContain("SEC-070");
    // "未信任时仅内置 agent 可用"的注册表面断言：project 空注入 → names 恰内置四件
    const reg = createAgentRegistry({ sources: { project: r.loadable } });
    expect(reg.names().sort()).toEqual(BUILT_IN_AGENTS.map((b) => b.name).sort());
  });
});

describe("DoD③ 提权字段二次确认+local 留痕", () => {
  it("无留痕无确认通道 → 提权字段 fail-closed 剥离，定义本体保留", async () => {
    const r = await gateProjectAgentDefinitions([escalateDef()], { trusted: true });
    expect(r.loadable.length).toBe(1);
    expect(r.loadable[0].permissionMode).toBeUndefined();
    expect(r.stripped.length).toBe(1);
    expect(r.stripped[0].fields.join(",")).toContain("bypassPermissions");
    expect(r.warnings.some((w) => w.includes("fail-closed"))).toBe(true);
  });

  it("confirm=true → 字段生效+留痕落盘调用（onConfirmed 收到完整记录）", async () => {
    const written: { name: string; rec: AgentTrustRecord }[] = [];
    const r = await gateProjectAgentDefinitions([escalateDef()], {
      trusted: true,
      confirm: async () => true,
      onConfirmed: (name, rec) => void written.push({ name, rec }),
      now: () => "2026-09-12T00:00:00.000Z",
    });
    expect(r.loadable[0].permissionMode).toBe("bypassPermissions");
    expect(written).toEqual([{ name: "risky", rec: { permissionMode: "bypassPermissions", confirmedAt: "2026-09-12T00:00:00.000Z" } }]);
  });

  it("confirm=false（用户拒绝）→ 剥离；留痕覆盖（permissionMode 匹配）→ 不再请求确认", async () => {
    let asked = 0;
    const denied = await gateProjectAgentDefinitions([escalateDef()], {
      trusted: true,
      confirm: async () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(1);
    expect(denied.loadable[0].permissionMode).toBeUndefined();
    const covered = await gateProjectAgentDefinitions([escalateDef()], {
      trusted: true,
      records: { risky: { permissionMode: "bypassPermissions" } }, // 键小写归一
      confirm: async () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(1); // 留痕在位=零二次确认
    expect(covered.loadable[0].permissionMode).toBe("bypassPermissions");
  });

  it("hooks 在场=提权面：未确认剥离 hooksRequested；确认落 {hooks:true}；非提权模式（plan/default）零打扰", async () => {
    const hooksDef = parseAgentMarkdown("---\nschemaVersion: 1\nname: hk\ndescription: d\nhooks:\n  - PreToolUse\npermissionMode: plan\n---\n", "hk.md");
    let fields: string[] = [];
    const r = await gateProjectAgentDefinitions([hooksDef], {
      trusted: true,
      confirm: async (_n, f) => {
        fields = f;
        return true;
      },
    });
    expect(fields).toEqual(["hooks"]); // plan 非提权（更严）——确认请求只含 hooks
    expect(r.loadable[0].permissionMode).toBe("plan");
    expect(r.loadable[0].hooksRequested).toBe(true); // 确认后保留（块形无实体=仅标记面）
  });

  it("WP-10 实体联动（ADR-0043 决策 6）：单行 JSON hooks 确认=实体保留；拒绝=hooksRequested+def.hooks 同剥", async () => {
    const mk = () => parseAgentMarkdown('---\nschemaVersion: 1\nname: ent\ndescription: d\nhooks: {"PreToolUse":[{"hooks":[{"type":"command","command":"c"}]}]}\n---\n', "ent.md");
    const approved = await gateProjectAgentDefinitions([mk()], { trusted: true, confirm: async () => true });
    expect(approved.loadable[0].hooks).toMatchObject({ PreToolUse: [{}] });
    const declined = await gateProjectAgentDefinitions([mk()], { trusted: true, confirm: async () => false });
    expect(declined.loadable[0].hooks).toBeUndefined();
    expect(declined.loadable[0].hooksRequested).toBeUndefined();
    expect(declined.stripped[0].fields.join(" ")).toContain("hooks");
  });
});

describe("frontmatter 切分边缘", () => {
  it("CRLF 行尾+带引号值+注释行", () => {
    const fm = splitFrontmatter('---\r\n# comment\r\nname: "x"\r\ndescription: d\r\n---\r\nbody');
    expect(fm).not.toBeNull();
    expect(fm!.fields.name).toBe("x");
    expect(fm!.body).toContain("body");
  });
});
