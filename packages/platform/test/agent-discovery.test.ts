// WP-09（M3）platform 装配面测试：磁盘发现（.standardcode/agents/*.md）+ local 层留痕读写。
// 判据自足（板 WP-09 DoD）：②未信任仅内置（discovery→gate→registry 端到端）④解析失败告警继续（真文件竞态面）
// ③留痕=ADR-0037 形制（坏 JSON 拒覆盖/追加合并/schemaVersion:1）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gateProjectAgentDefinitions, createAgentRegistry, BUILT_IN_AGENTS } from "@standardcode/harness";
import { loadProjectAgentDefinitions, projectAgentsDir, readAgentTrust, recordAgentTrust } from "../src/agent-discovery.ts";
import { settingsSourcePaths } from "../src/settings.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-wp09-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string): string {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("loadProjectAgentDefinitions 枚举+告警继续（DoD④）", () => {
  it("递归收集 .md；坏件不毁好件；无目录=空集非错误", () => {
    const proj = project("p1");
    const agents = projectAgentsDir(proj);
    mkdirSync(join(agents, "nested"), { recursive: true });
    writeFileSync(join(agents, "good.md"), "---\nschemaVersion: 1\nname: good\ndescription: d\n---\nbody", "utf8");
    writeFileSync(join(agents, "broken.md"), "no frontmatter at all", "utf8");
    writeFileSync(join(agents, "nested", "deep.md"), "---\nschemaVersion: 1\nname: deep\ndescription: d\n---\n", "utf8");
    writeFileSync(join(agents, "notes.txt"), "ignored", "utf8");
    const r = loadProjectAgentDefinitions(proj);
    expect(r.parsed.map((x) => x.file).sort()).toEqual([join(".standardcode", "agents", "broken.md"), join(".standardcode", "agents", "good.md"), join(".standardcode", "agents", "nested", "deep.md")].sort());
    const defs = r.parsed.filter((x) => x.def).map((x) => x.def!.name).sort();
    expect(defs).toEqual(["deep", "good"]); // 好两件（deep 递归在位）、坏件 def=null 不计
    expect(r.warnings.some((w) => w.includes("broken.md") && w.includes("frontmatter"))).toBe(true);
    // 无 agents 目录=常态空集
    const empty = loadProjectAgentDefinitions(project("p2"));
    expect(empty.parsed).toEqual([]);
    expect(empty.warnings).toEqual([]);
  });
});

describe("DoD②端到端：未信任工作区 → discovery→gate→registry 仅内置可用", () => {
  it("trusted=false：project 层整体不加载，注册表 names=内置四件；trusted=true 非提权定义注册成功", async () => {
    const proj = project("p3");
    const agents = projectAgentsDir(proj);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "plain.md"), "---\nschemaVersion: 1\nname: plain\ndescription: d\n---\n", "utf8");
    const r = loadProjectAgentDefinitions(proj);
    const untrusted = await gateProjectAgentDefinitions(r.parsed, { trusted: false });
    const reg = createAgentRegistry({ sources: { project: untrusted.loadable } });
    expect(untrusted.layerWithheld).toBe(true);
    expect(reg.names().sort()).toEqual(BUILT_IN_AGENTS.map((b) => b.name).sort());
    const trusted = await gateProjectAgentDefinitions(r.parsed, { trusted: true });
    const reg2 = createAgentRegistry({ sources: { project: trusted.loadable } });
    expect(reg2.get("plain")).toMatchObject({ source: "project" }); // project 层注入生效
  });
});

describe("DoD③ 留痕落盘（settings.local.json agentTrust，ADR-0037 形制）", () => {
  it("recordAgentTrust 写 local 层（键小写归一/追加合并/schemaVersion:1）；readAgentTrust 读回；门控经留痕免二次确认", async () => {
    const proj = project("p4");
    const localFile = settingsSourcePaths(proj).projectLocal;
    mkdirSync(join(proj, ".standardcode"), { recursive: true });
    expect(readAgentTrust(proj, localFile)).toEqual({}); // 无文件=空记录
    recordAgentTrust(proj, "Risky", { permissionMode: "bypassPermissions", confirmedAt: "t1" }, localFile);
    const doc = JSON.parse(readFileSync(localFile, "utf8"));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.agentTrust.risky).toEqual({ permissionMode: "bypassPermissions", confirmedAt: "t1" });
    recordAgentTrust(proj, "other", { hooks: true }, localFile); // 追加不丢前件
    expect(Object.keys(readAgentTrust(proj, localFile))).toEqual(["risky", "other"]); // 键小写归一
    // 端到端：留痕在位 → 确认通道缺席也不剥离、零打扰
    const agents = projectAgentsDir(proj);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "risky.md"), "---\nschemaVersion: 1\nname: Risky\ndescription: d\npermissionMode: bypassPermissions\n---\n", "utf8");
    const parsed = loadProjectAgentDefinitions(proj);
    const gated = await gateProjectAgentDefinitions(parsed.parsed, { trusted: true, records: readAgentTrust(proj, localFile) });
    expect(gated.stripped).toEqual([]);
    expect(gated.loadable[0]).toMatchObject({ name: "Risky", permissionMode: "bypassPermissions" });
    // onConfirmed 钩子真落盘（确认动作→local 层留痕闭环）
    const gated2 = await gateProjectAgentDefinitions(parsed.parsed, {
      trusted: true,
      confirm: async () => true,
      onConfirmed: (name, rec) => recordAgentTrust(proj, name, rec, localFile),
    });
    expect(gated2.loadable[0].permissionMode).toBe("bypassPermissions");
    expect(readAgentTrust(proj, localFile).risky).toMatchObject({ permissionMode: "bypassPermissions", confirmedAt: expect.any(String) });
  });

  it("坏 settings.local.json → 写侧拒覆盖（read 侧空容忍），与 persistAlwaysAllow 同形制", () => {
    const proj = project("p5");
    mkdirSync(join(proj, ".standardcode"), { recursive: true });
    const localFile = settingsSourcePaths(proj).projectLocal;
    writeFileSync(localFile, "{broken", "utf8");
    expect(readAgentTrust(proj, localFile)).toEqual({});
    expect(() => recordAgentTrust(proj, "x", { hooks: true }, localFile)).toThrow(/refusing to overwrite/);
  });
});
