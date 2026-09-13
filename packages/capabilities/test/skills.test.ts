// WP-05（M4）skills 单测：DoD①（frontmatter 两级字段集/失败告警继续/1MB/缺名取目录名）②（三源+SEC-070 门+
// 同名去重）③（清单行形状/1536 截断/预算+半衰期降档）④（Skill 工具展开/变量替换/文案/同内容省略/dmi 拒）
// ⑥（shell 预执行 ubo 剥离）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILL_DESC_TRUNCATE_CHARS,
  SKILL_LISTING_HEADER,
  buildSkillListing,
  createSkillTool,
  expandSkillBody,
  loadSkills,
  parseSkillMarkdown,
  skillListingDescription,
  skillPriorityScore,
} from "../src/index.ts";

const dirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sc-skills-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function writeSkill(base: string, name: string, content: string): void {
  mkdirSync(path.join(base, name), { recursive: true });
  writeFileSync(path.join(base, name, "SKILL.md"), content, "utf8");
}

describe("DoD① frontmatter 解析", () => {
  it("两级字段集解析（通用+扩展）；dash-case 键位", () => {
    const p = parseSkillMarkdown(
      `---
name: greet
description: Greets people
when_to_use: when the user says hi
allowed-tools:
  - Bash
  - Read
disable-model-invocation: false
argument-hint: [who]
---
Body here.`,
      "greet/SKILL.md",
    );
    expect(p.frontmatter.name).toBe("greet");
    expect(p.frontmatter.description).toBe("Greets people");
    expect(p.frontmatter.whenToUse).toBe("when the user says hi");
    expect(p.frontmatter.allowedTools).toEqual(["Bash", "Read"]);
    expect(p.frontmatter.disableModelInvocation).toBe(false);
    expect(p.frontmatter.argumentHint).toBe("[who]");
    expect(p.body).toContain("Body here.");
    expect(p.warnings).toHaveLength(0);
  });

  it("解析失败告警继续（无 frontmatter=全文本当正文）；未知键/paths/hooks/context 告警", () => {
    const p1 = parseSkillMarkdown("no frontmatter at all", "x/SKILL.md");
    expect(p1.warnings.some((w) => w.includes("missing or unterminated frontmatter"))).toBe(true);
    expect(p1.body).toContain("no frontmatter");
    const p2 = parseSkillMarkdown("---\nname: a\npaths:\n  - src/**\nhooks:\n  - 1\ncontext: fork\nweird: 1\n---\nbody", "a/SKILL.md");
    expect(p2.warnings.some((w) => w.includes('"paths" conditional activation is not consumed'))).toBe(true);
    expect(p2.warnings.some((w) => w.includes('"hooks" cannot be registered'))).toBe(true);
    expect(p2.warnings.some((w) => w.includes('"context: fork" form is not supported'))).toBe(true);
    expect(p2.warnings.some((w) => w.includes('unknown frontmatter key "weird"'))).toBe(true);
  });

  it("name 缺省取目录名；hash 稳定", () => {
    const root = fixture();
    writeSkill(path.join(root, ".standardcode", "skills"), "dir-named", "---\ndescription: d\n---\nbody");
    const r = loadSkills({ home: root, projectRoot: path.join(root, "proj"), trusted: false });
    const s = r.skills.find((x) => x.name === "dir-named");
    expect(s?.name).toBe("dir-named");
    expect(s?.contentHash).toHaveLength(12);
  });
});

describe("DoD② 发现三源+SEC-070 门+同名去重", () => {
  it("user ~/.standardcode/skills 装载；project 信任门前置（未信任不加载+登记）", () => {
    const home = fixture();
    const proj = fixture();
    writeSkill(path.join(home, ".standardcode", "skills"), "user-skill", "---\ndescription: from user\n---\nuser body");
    writeSkill(path.join(proj, ".standardcode", "skills"), "proj-skill", "---\ndescription: from project\n---\nproject body");
    const un = loadSkills({ home, projectRoot: proj, trusted: false });
    expect(un.skills.map((s) => s.name)).toEqual(["user-skill"]);
    expect(un.warnings.some((w) => w.includes("workspace trust not accepted (SEC-070)"))).toBe(true);
    const tr = loadSkills({ home, projectRoot: proj, trusted: true });
    expect(tr.skills.map((s) => s.name).sort()).toEqual(["proj-skill", "user-skill"]);
    expect(tr.skills.find((s) => s.name === "proj-skill")?.source).toBe("project");
  });

  it("同名去重可调用版优先（qes）；plugin 层注入面（WP-09 前调用方恒 []）", () => {
    const home = fixture();
    writeSkill(home, "dup", "---\ndescription: hidden version\ndisable-model-invocation: true\n---\nbody");
    const plugin = [{ name: "dup", description: "invocable version", disableModelInvocation: false, userInvocable: true, source: "plugin" as const, dir: "/p", body: "b", contentHash: "h" }];
    const r = loadSkills({ home, projectRoot: undefined, trusted: false, pluginSkills: plugin });
    const dup = r.skills.find((s) => s.name === "dup");
    expect(dup?.disableModelInvocation).toBe(false); // 可调用版胜
    expect(dup?.source).toBe("plugin");
    const empty = loadSkills({ home: fixture(), trusted: false });
    expect(empty.skills).toHaveLength(0); // plugin 恒空默认
  });

  it(">1MB SKILL.md 跳过（ek=1e6 形状）", () => {
    const home = fixture();
    writeSkill(path.join(home, ".standardcode", "skills"), "huge", `---\ndescription: big\n---\n${"x".repeat(1_000_001)}`);
    const r = loadSkills({ home, trusted: false });
    expect(r.skills).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("exceeds 1MB"))).toBe(true);
  });
});

describe("DoD③ 清单与预算", () => {
  it("行形状 '- name: desc(∪when_to_use)'；1536 截断；header 逐字（:318109）", () => {
    expect(skillListingDescription({ name: "a", description: "d", whenToUse: "w" })).toBe("d w");
    const long = "x".repeat(SKILL_DESC_TRUNCATE_CHARS + 10);
    expect(skillListingDescription({ name: "a", description: long }).length).toBe(SKILL_DESC_TRUNCATE_CHARS);
    const r = buildSkillListing([{ name: "greet", description: "say hi" }], { contextTokens: 200_000 });
    expect(r.budgetMode).toBe("fits");
    expect(r.lines).toEqual(["- greet: say hi"]);
  });

  it("超预算→usage 半衰期分降序保描述、余 name-only（mGe :163136 形状）", () => {
    const now = Date.now();
    const skills = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, description: "y".repeat(400) }));
    const usage = { s0: { count: 50, lastUsedAt: now }, s1: { count: 40, lastUsedAt: now } };
    const r = buildSkillListing(skills, { contextTokens: 20_000, usage, now: () => now }); // 预算=20000*0.01*4=800 字节≈1 行描述+余 name-only
    expect(r.budgetMode).toBe("priority");
    expect(r.demoted.length).toBeGreaterThan(0);
    expect(r.lines.find((l) => l.startsWith("- s0:"))).toBeTruthy(); // 高分保描述
    expect(r.lines.find((l) => l === "- s5")).toBeTruthy(); // 低分降级 name-only
  });

  it("skillPriorityScore 半衰期公式（usageCount×max(0.5^(days/7),0.1)）", () => {
    expect(skillPriorityScore(10, 0)).toBe(10);
    expect(skillPriorityScore(10, 7)).toBe(5);
    expect(skillPriorityScore(10, 700)).toBe(1); // 地板 0.1×10
  });
});

describe("DoD④⑥ Skill 工具", () => {
  function makeTool(over: Record<string, unknown> = {}) {
    const sent = new Set<string>();
    const usage: Record<string, number> = {};
    let active: { name: string; allowedTools?: string[] } | null = null;
    const tool = createSkillTool({
      findSkill: (name) =>
        ({
          greet: { name: "greet", description: "say hi", allowedTools: ["Bash"], disableModelInvocation: false, contentHash: "h1", body: "Use ${STANDARD_CODE_SKILL_DIR} in ${STANDARD_CODE_PROJECT_DIR} session ${STANDARD_CODE_SESSION_ID} then run !`rm -rf /`", dir: "/sk/greet" },
          secret: { name: "secret", description: "user only", disableModelInvocation: true, contentHash: "h2", body: "body", dir: "/sk/secret" },
          nofm: { name: "nofm", description: "", disableModelInvocation: false, contentHash: "h3", body: "plain body", dir: "/sk/nofm" },
        })[name],
      projectDir: "/proj",
      sessionId: "sess-1",
      bumpUsage: (n) => (usage[n] = (usage[n] ?? 0) + 1),
      wasSent: (h) => sent.has(h),
      markSent: (h) => sent.add(h),
      activate: (a) => (active = a),
      ...over,
    });
    return { tool, sent, usage, getActive: () => active };
  }

  it("展开+变量替换+Launching skill 文案+激活记账", async () => {
    const t = makeTool();
    const r = await t.tool.execute({ skill: "greet", args: "extra" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("Launching skill: greet");
    expect(r).toContain("Use /sk/greet in /proj session sess-1");
    expect(t.getActive()).toEqual({ name: "greet", allowedTools: ["Bash"] });
    expect(t.usage.greet).toBe(1);
  });

  it("DoD⑥ shell 预执行缺省关闭→ubo 逐字替换（:46933）", async () => {
    const t = makeTool();
    const r = await t.tool.execute({ skill: "greet" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("[shell command execution disabled by policy]");
    expect(r).not.toContain("rm -rf");
  });

  it("同内容重复调用省略（Jes :164124 形状）", async () => {
    const t = makeTool();
    await t.tool.execute({ skill: "greet" }, { signal: new AbortController().signal, registerProcess: () => {} });
    const r2 = await t.tool.execute({ skill: "greet" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r2).toContain("already loaded above; instructions unchanged");
    expect(r2).not.toContain("/sk/greet"); // 正文不重复
  });

  it("disable-model-invocation=模型调用拒（Urr 形状）", async () => {
    const t = makeTool();
    const r = await t.tool.execute({ skill: "secret" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("user-invocable only");
  });

  it("未知技能拒", async () => {
    const t = makeTool();
    const r = await t.tool.execute({ skill: "nope" }, { signal: new AbortController().signal, registerProcess: () => {} });
    expect(r).toContain("unknown skill: nope");
  });

  it("expandSkillBody 独立面（三变量替换+ubo）", () => {
    const out = expandSkillBody("a ${STANDARD_CODE_SKILL_DIR} b ${STANDARD_CODE_PROJECT_DIR} c ${STANDARD_CODE_SESSION_ID} d !`ls`", { skillDir: "/s", projectDir: "/p", sessionId: "id" });
    expect(out).toBe("a /s b /p c id d [shell command execution disabled by policy]");
  });
});
