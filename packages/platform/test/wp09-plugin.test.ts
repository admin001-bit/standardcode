// M4-WP-09：platform plugin 三件套单测（DoD① manifest/DoD② marketplace/DoD③ 安装确认+留痕/DoD⑤ remove+目录级清理）。
// git 源=runGit 注入桩（本卡 git clone 子进程形制断言，不触真实网络——离线纪律）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPluginDocs,
  componentCounts,
  installPlugin,
  loadInstalledPlugins,
  loadPluginsDoc,
  parseMarketplace,
  parsePluginManifest,
  pluginsRecordFile,
  readPluginManifest,
  removePlugin,
  sanitizePluginName,
} from "../src/index.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "sc-wp09-p-"));
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

function freshDirs(tag: string): { baseDir: string; srcDir: string } {
  const dir = path.join(root, tag);
  return { baseDir: path.join(dir, "base"), srcDir: path.join(dir, "src") };
}

function writePlugin(srcDir: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  for (const [rel, text] of Object.entries(extra)) {
    const p = path.join(srcDir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  }
}

const GOOD_MANIFEST = {
  schemaVersion: 1,
  name: "Demo Plugin",
  version: "0.3.1",
  description: "fixtures everything",
  commands: ["hello", "world"],
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node deny.js" }] }] },
  mcpServers: { "demo-srv": { type: "stdio", command: "node", args: ["server.js"] } },
};

describe("DoD① plugin.json 解析（schemaVersion:1+坏件告警继续）", () => {
  it("正件：五组件键位+缺省目录位（agents/ skills/ 存在即生效）", () => {
    const { srcDir } = freshDirs("m1");
    writePlugin(srcDir, GOOD_MANIFEST, { "agents/helper.md": "---\nname: helper\ndescription: d\n---\nbody\n", "skills/s1/SKILL.md": "---\ndescription: s1\n---\nb\n" });
    const r = readPluginManifest(srcDir);
    expect(r.manifest).not.toBeNull();
    expect(r.manifest!.name).toBe("Demo Plugin");
    expect(r.manifest!.version).toBe("0.3.1");
    expect(r.manifest!.components.commands).toEqual(["hello", "world"]);
    expect(r.manifest!.components.hooks).not.toBeNull();
    expect(r.manifest!.components.mcpServers).not.toBeNull();
    expect(r.manifest!.components.agentsDirs.length).toBe(1); // 缺省 agents/ 目录存在
    expect(r.manifest!.components.skillsDirs.length).toBe(1);
    expect(r.warnings).toEqual([]);
  });
  it("坏件四形：非 JSON/非对象/缺 name/缺 version → manifest null+告警继续（不抛）", () => {
    const cases: [string, string][] = [["broken JSON {", "bad"], [JSON.stringify([1, 2]), "arr"], [JSON.stringify({ version: "1" }), "noname"], [JSON.stringify({ name: "n" }), "nover"]];
    for (const [text, why] of cases) {
      const r = parsePluginManifest(text, path.join(root, `${why}.json`), root);
      expect(r.manifest, why).toBeNull();
      expect(r.warnings.length, why).toBeGreaterThan(0);
    }
  });
  it("schemaVersion 不符/缺失=告警不拒收（agent manifest 同口径 ENG-080）", () => {
    const r = parsePluginManifest(JSON.stringify({ ...GOOD_MANIFEST, schemaVersion: 99 }), path.join(root, "v99.json"), root);
    expect(r.manifest).not.toBeNull();
    expect(r.warnings.join("\n")).toMatch(/schemaVersion/);
    const noVer = JSON.parse(JSON.stringify({ ...GOOD_MANIFEST, schemaVersion: undefined }));
    const r2 = parsePluginManifest(JSON.stringify(noVer), path.join(root, "nov.json"), root);
    expect(r2.manifest).not.toBeNull();
    expect(r2.warnings.join("\n")).toMatch(/schemaVersion missing/);
  });
  it("目录声明越出 pluginRoot=拒绝+告警（路径消毒）", () => {
    const { srcDir } = freshDirs("m2");
    writePlugin(srcDir, { ...GOOD_MANIFEST, agents: ["../../outside"] });
    const r = readPluginManifest(srcDir);
    expect(r.manifest!.components.agentsDirs).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/escapes plugin root/);
  });
});

describe("DoD② marketplace.json 索引解析", () => {
  it("正件：name/version/source 条目；缺省 name 落文件路径", () => {
    const r = parseMarketplace(JSON.stringify({ schemaVersion: 1, name: "official-ish", plugins: [{ name: "p1", version: "1.0.0", source: "https://example.invalid/p1.git" }, { name: "p2", source: "D:/local/p2" }] }), path.join(root, "mp.json"));
    expect(r.marketplace!.entries.map((e) => e.name)).toEqual(["p1", "p2"]);
    expect(r.marketplace!.name).toBe("official-ish");
  });
  it("坏件：非 JSON/缺 plugins 数组/无有效条目 → null+告警；缺 name/source 条目丢弃", () => {
    expect(parseMarketplace("{", path.join(root, "b1.json")).marketplace).toBeNull();
    expect(parseMarketplace(JSON.stringify({ name: "x" }), path.join(root, "b2.json")).marketplace).toBeNull();
    const r = parseMarketplace(JSON.stringify({ plugins: [{ name: "only-name" }, { name: "ok", source: "s" }] }), path.join(root, "b3.json"));
    expect(r.marketplace!.entries).toHaveLength(1);
    expect(r.warnings.join("\n")).toMatch(/name\+source/);
  });
});

describe("DoD③ 安装=确认门（once 落/非 once 零落地）+留痕持久（来源+版本）", () => {
  it("once 确认：复制 baseDir/plugins/<name>/ + plugins.json 记录（schemaVersion:1，来源/版本/时间戳/dir）", async () => {
    const { baseDir, srcDir } = freshDirs("i1");
    writePlugin(srcDir, GOOD_MANIFEST, { "agents/helper.md": "---\nname: helper\ndescription: d\n---\nbody\n" });
    let sawConfirm: string | null = null;
    const out = await installPlugin(srcDir, {
      baseDir,
      opts: { onConfirm: async (m) => { sawConfirm = m.name; return true; } },
    });
    expect(out.ok).toBe(true);
    expect(sawConfirm).toBe("Demo Plugin");
    const dest = path.join(baseDir, "plugins", "demo-plugin");
    expect(out.dir).toBe(dest);
    expect(existsSync(path.join(dest, "plugin.json"))).toBe(true);
    expect(existsSync(path.join(dest, "agents", "helper.md"))).toBe(true);
    const doc = loadPluginsDoc(baseDir);
    expect(doc.plugins).toHaveLength(1);
    expect(doc.plugins[0]).toMatchObject({ name: "Demo Plugin", version: "0.3.1", source: srcDir });
    expect(doc.plugins[0]!.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(readFileSync(pluginsRecordFile(baseDir), "utf8")).schemaVersion).toBe(1);
  });
  it("拒绝确认=零落地：目标目录不存在、留痕无记录（S-5 fail-closed）", async () => {
    const { baseDir, srcDir } = freshDirs("i2");
    writePlugin(srcDir, GOOD_MANIFEST);
    const out = await installPlugin(srcDir, { baseDir, opts: { onConfirm: async () => false } });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("declined");
    expect(existsSync(path.join(baseDir, "plugins", "demo-plugin"))).toBe(false);
    expect(loadPluginsDoc(baseDir).plugins).toEqual([]);
    expect(existsSync(pluginsRecordFile(baseDir))).toBe(false);
  });
  it("无确认钩子（onConfirm 缺席）仍安装=门在调用方；确认先于任何写盘（拒绝无半程状态）——由上一用例联合成立", async () => {
    const { baseDir, srcDir } = freshDirs("i3");
    writePlugin(srcDir, GOOD_MANIFEST);
    const out = await installPlugin(srcDir, { baseDir });
    expect(out.ok).toBe(true);
  });
  it("同名二次安装=exists 拒绝（大小写/空格归一）+坏目标=no-manifest", async () => {
    const { baseDir, srcDir } = freshDirs("i4");
    writePlugin(srcDir, GOOD_MANIFEST);
    expect((await installPlugin(srcDir, { baseDir })).ok).toBe(true);
    const dup = await installPlugin(srcDir, { baseDir });
    expect(dup.error).toBe("exists");
    const badDir = path.join(root, "i4-empty");
    mkdirSync(badDir, { recursive: true });
    expect((await installPlugin(badDir, { baseDir })).error).toBe("no-manifest");
  });
});

describe("DoD② git URL 源+marketplace 登记（runGit 桩，零真实网络）", () => {
  it("git URL 插件仓库：clone 后落装；env 过基线剥离（STANDARD_CODE_*/GIT_CONFIG_*/*_KEY 不入子进程）", async () => {
    const { baseDir, srcDir } = freshDirs("g1");
    writePlugin(srcDir, { ...GOOD_MANIFEST, name: "GitPlugin" });
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const out = await installPlugin("https://example.invalid/git-plugin.git", {
      baseDir,
      opts: {
        env: { PATH: process.env.PATH ?? "", STANDARD_CODE_MODEL: "secret-model", GIT_CONFIG_GLOBAL: "/tmp/gc", MY_KEY: "k", HOME: process.env.HOME ?? "" },
        runGit: (args, env) => {
          calls.push({ args, env });
          const dest = args[args.length - 1]!;
          mkdirSync(dest, { recursive: true });
          writeFileSync(path.join(dest, "plugin.json"), JSON.stringify({ ...GOOD_MANIFEST, name: "GitPlugin" }), "utf8");
          return { status: 0 };
        },
      },
    });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["clone", "--depth", "1"]);
    expect(calls[0]!.env.STANDARD_CODE_MODEL).toBeUndefined();
    expect(calls[0]!.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(calls[0]!.env.MY_KEY).toBeUndefined();
    expect(loadPluginsDoc(baseDir).plugins[0]).toMatchObject({ name: "GitPlugin", source: "https://example.invalid/git-plugin.git" });
  });
  it("clone 失败=clone-failed 零落地；marketplace 仓库（根 marketplace.json 无 plugin.json）=登记条目数（DoD② 自定义市场添加）", async () => {
    const { baseDir } = freshDirs("g2");
    const fail = await installPlugin("https://example.invalid/nope.git", { baseDir, opts: { runGit: () => ({ status: 128, stderr: "fatal: repository not found" }) } });
    expect(fail.error).toBe("clone-failed");
    expect(existsSync(pluginsRecordFile(baseDir))).toBe(false);
    const mktDir = path.join(root, "g2-mkt");
    writePlugin(mktDir, GOOD_MANIFEST); // 占位目录（其 plugin.json 不读——marketplace 路先判根文件集）
    rmSync(path.join(mktDir, "plugin.json"));
    writeFileSync(path.join(mktDir, "marketplace.json"), JSON.stringify({ schemaVersion: 1, name: "Mine", plugins: [{ name: "a", source: "x" }, { name: "b", source: "y" }] }), "utf8");
    const ok = await installPlugin(mktDir, { baseDir });
    expect(ok.ok).toBe(true);
    expect(ok.marketplace).toMatchObject({ name: "Mine", entries: 2 });
    expect(loadPluginsDoc(baseDir).marketplaces).toEqual([{ name: "Mine", source: mktDir }]);
  });
  it("条目名安装：marketplace 索引 source 为本地目录→直装（自定义市场消费闭环）；未知名=marketplace-entry-not-found", async () => {
    const { baseDir, srcDir } = freshDirs("g3");
    writePlugin(srcDir, { ...GOOD_MANIFEST, name: "FromMkt" });
    const mktDir = path.join(root, "g3-mkt");
    mkdirSync(mktDir, { recursive: true });
    writeFileSync(path.join(mktDir, "marketplace.json"), JSON.stringify({ name: "local-mkt", plugins: [{ name: "from-mkt", source: srcDir }] }), "utf8");
    const add = await installPlugin(mktDir, { baseDir });
    expect(add.ok).toBe(true);
    const inst = await installPlugin("from-mkt", { baseDir });
    expect(inst.ok).toBe(true);
    expect(inst.manifest!.name).toBe("FromMkt");
    const miss = await installPlugin("no-such", { baseDir });
    expect(miss.error).toBe("marketplace-entry-not-found");
    // 缺省官方市场位（settings.plugins.defaultMarketplace 占位键消费形制）
    const miss2 = await installPlugin("no-such", { baseDir, defaultMarketplace: mktDir });
    expect(miss2.error).toBe("marketplace-entry-not-found");
    const hit = await installPlugin("from-mkt", { baseDir: path.join(root, "g3-base2"), defaultMarketplace: mktDir });
    expect(hit.ok).toBe(true); // 未登记自定义市场也能经缺省市场位命中
  });
});

describe("DoD⑤ remove=目录级清理+留痕删", () => {
  it("安装后 remove：记录消失+安装目录删除；未知名 removed=false", async () => {
    const { baseDir, srcDir } = freshDirs("r1");
    writePlugin(srcDir, GOOD_MANIFEST);
    const out = await installPlugin(srcDir, { baseDir });
    const dir = out.dir!;
    expect(removePlugin("demo plugin", baseDir).removed).toBe(true); // 大小写不敏感
    expect(loadPluginsDoc(baseDir).plugins).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(removePlugin("ghost", baseDir).removed).toBe(false);
  });
});

describe("DoD④ 聚合件（buildPluginDocs/loadInstalledPlugins 消费形制）", () => {
  it("hooks 逐事件跨插件拼接（name 序确定性）；MCP 同名=层内抑制不改名+告警；缺目录=坏件告警继续", async () => {
    const { baseDir } = freshDirs("a1");
    const srcA = path.join(root, "a1-a");
    const srcB = path.join(root, "a1-b");
    writePlugin(srcA, { schemaVersion: 1, name: "Alpha", version: "1.0.0", hooks: { PreToolUse: [{ hooks: [{ command: "a.sh" }] }] }, mcpServers: { shared: { command: "a" }, onlyA: { command: "x" } } });
    writePlugin(srcB, { schemaVersion: 1, name: "Beta", version: "1.0.0", hooks: { PreToolUse: [{ hooks: [{ command: "b.sh" }] }], Stop: [{ hooks: [{ command: "s.sh" }] }] }, mcpServers: { shared: { command: "b" } } });
    await installPlugin(srcA, { baseDir });
    await installPlugin(srcB, { baseDir });
    const views = loadInstalledPlugins(baseDir);
    expect(views.map((v) => v.record.name)).toEqual(["Alpha", "Beta"]); // name localeCompare 序
    const docs = buildPluginDocs(views);
    const groups = (docs.hooksDoc!.hooks as Record<string, unknown[]>).PreToolUse!;
    expect(groups).toHaveLength(2); // 拼接非覆盖
    expect(((groups[0] as { hooks: { command: string }[] }).hooks[0]!.command)).toBe("a.sh"); // Alpha 在前
    expect(Object.keys(docs.hooksDoc!.hooks as Record<string, unknown>).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(Object.keys(docs.mcpDoc!.mcpServers as Record<string, unknown>).sort()).toEqual(["onlyA", "shared"]);
    expect((docs.mcpDoc!.mcpServers as Record<string, { command: string }>).shared.command).toBe("a"); // 层内先到先得
    expect(docs.warnings.join("\n")).toMatch(/suppressed, not renamed/);
    // 坏件面：留痕指向不存在目录 → manifest null+告警，其余件正常
    const doc = loadPluginsDoc(baseDir);
    doc.plugins.push({ name: "Ghost", version: "0", source: "s", installedAt: "", dir: path.join(root, "nope-missing") });
    const ghostFile = pluginsRecordFile(baseDir);
    writeFileSync(ghostFile, JSON.stringify({ schemaVersion: 1, plugins: doc.plugins, marketplaces: [] }) + "\n", "utf8");
    const views2 = loadInstalledPlugins(baseDir);
    expect(views2.find((v) => v.record.name === "Ghost")!.manifest).toBeNull();
    expect(views2.find((v) => v.record.name === "Alpha")!.manifest).not.toBeNull();
    expect(views2.flatMap((v) => v.warnings).join("\n")).toMatch(/install dir missing/);
  });
  it("空装配=双 null（无声明零注入）", () => {
    const docs = buildPluginDocs([]);
    expect(docs.hooksDoc).toBeNull();
    expect(docs.mcpDoc).toBeNull();
  });
});

describe("DoD③ 确认清单计数（componentCounts：N commands/N agents/N skills/hooks/MCP 逐名）", () => {
  it("目录扫描：agents=.md 递归数；skills=含 SKILL.md 子目录名；hooks=事件名；MCP=server 名", () => {
    const { srcDir } = freshDirs("c1");
    writePlugin(srcDir, {
      schemaVersion: 1, name: "Cnt", version: "1.0.0",
      commands: ["one", "two", "three"],
      hooks: { PreToolUse: [], Notification: [] },
      mcpServers: { zeta: {}, alpha: {} },
    }, { "agents/a1.md": "x", "agents/nested/a2.md": "y", "agents/readme.txt": "not-md", "skills/s1/SKILL.md": "z", "skills/s2/other.md": "no-skill-md", "skills/no-skill/readme.md": "dir exists without SKILL.md" });
    const r = readPluginManifest(srcDir);
    const c = componentCounts(r.manifest!);
    expect(c.commands).toEqual(["one", "two", "three"]);
    expect(c.agents).toBe(2);
    expect(c.skills).toEqual(["s1"]);
    expect(c.hookEvents).toEqual(["Notification", "PreToolUse"]);
    expect(c.mcpServers).toEqual(["alpha", "zeta"]);
  });
  it("sanitizePluginName：fs 安全子集+小写", () => {
    expect(sanitizePluginName("Demo Plugin")).toBe("demo-plugin");
    expect(sanitizePluginName("  中文名  ")).toBe("plugin");
    expect(sanitizePluginName("a/b\\c")).toBe("a-b-c");
  });
});
