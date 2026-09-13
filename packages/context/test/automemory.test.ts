// WP-06（M4）自动记忆轨单测：DoD①（文件契约/slug）②（索引 200 行/25000 字节硬截断）③（互链解析）④（纪律段结构）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  buildMemoryDisciplinePrompt,
  loadAutoMemory,
  memorySlug,
  parseMemoryEntry,
  readMemoryIndex,
  renderAutoMemoryContext,
  resolveMemoryLinks,
  scanMemoryLinks,
} from "../src/index.ts";

const dirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sc-automem-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("DoD① 记忆文件契约", () => {
  it("frontmatter 直键 name/description/type 四值+schemaVersion；非法 type 告警", () => {
    const p = parseMemoryEntry("---\nname: feedback-testing\ndescription: how we test\ntype: feedback\nschemaVersion: 1\n---\nbody text", "feedback-testing.md");
    expect(p.name).toBe("feedback-testing");
    expect(p.type).toBe("feedback");
    expect(p.schemaVersion).toBe(1);
    expect(p.body).toBe("body text");
    expect(p.warnings).toHaveLength(0);
    const bad = parseMemoryEntry("---\ntype: secret\n---\nb", "x.md");
    expect(bad.warnings.some((w) => w.includes("type 'secret' not in"))).toBe(true);
  });

  it("slug 规范（[CC] Lt 形状）：lowercase/非法字符→-；已合法形保留", () => {
    expect(memorySlug("Feedback Testing")).toBe("feedback-testing");
    expect(memorySlug("already_ok-1")).toBe("already_ok-1");
    expect(memorySlug("")).toBe("memory");
  });
});

describe("DoD② MEMORY.md 索引硬截断（ae=200/ot=25000 对位）", () => {
  it("常量逐字（_533.js:18）", () => {
    expect(MEMORY_INDEX_FILE).toBe("MEMORY.md");
    expect(MEMORY_INDEX_MAX_LINES).toBe(200);
    expect(MEMORY_INDEX_MAX_BYTES).toBe(25_000);
  });

  it("≤200 行/25000 字节=原样；超行数→截断+告警；超字节→字节截断+告警", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, MEMORY_INDEX_FILE), "- [a](a.md) hook\n- [b](b.md) hook\n", "utf8");
    const ok = readMemoryIndex(dir);
    expect(ok.truncated).toBe(false);
    expect(ok.lines).toBe(2);
    const big = fixture();
    writeFileSync(path.join(big, MEMORY_INDEX_FILE), Array.from({ length: 260 }, (_, i) => `- [t${i}](t${i}.md) hook`).join("\n"), "utf8");
    const over = readMemoryIndex(big);
    expect(over.truncated).toBe(true);
    expect(over.lines).toBe(MEMORY_INDEX_MAX_LINES);
    expect(over.warnings.some((w) => w.includes("200 lines"))).toBe(true);
    const fat = fixture();
    writeFileSync(path.join(fat, MEMORY_INDEX_FILE), "y".repeat(26_000), "utf8");
    const cjk = fixture();
    writeFileSync(path.join(cjk, MEMORY_INDEX_FILE), "记".repeat(9_000), "utf8"); // 9000 CJK=27000 UTF-8 字节（R3：码元截断会击穿）
    const overBytes = readMemoryIndex(fat);
    expect(overBytes.truncated).toBe(true);
    expect(overBytes.bytes).toBe(MEMORY_INDEX_MAX_BYTES);
    expect(overBytes.warnings.some((w) => w.includes("25,000 bytes") || w.includes("25000 bytes"))).toBe(true);
    const overCjk = readMemoryIndex(cjk);
    expect(overCjk.truncated).toBe(true);
    expect(overCjk.bytes).toBeLessThanOrEqual(MEMORY_INDEX_MAX_BYTES); // R3：字节维上限成立
  });

  it("文件缺席=空视图非错误", () => {
    const v = readMemoryIndex(fixture());
    expect(v.exists).toBe(false);
    expect(v.text).toBe("");
  });
});

describe("DoD③ [[name]] 互链", () => {
  it("扫描去重保序；目标存在=全文随注入、缺失=告警不炸", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "testing.md"), "---\nname: testing\ntype: project\nschemaVersion: 1\n---\nrun bun test", "utf8");
    expect(scanMemoryLinks("a [[testing]] b [[testing]] [[ghost]]")).toEqual(["testing", "ghost"]);
    const r = resolveMemoryLinks(dir, ["testing", "ghost"]);
    expect(r.resolved).toEqual([{ name: "testing", body: "run bun test" }]);
    expect(r.missing).toEqual(["ghost"]);
    expect(r.warnings.some((w) => w.includes("not written yet"))).toBe(true);
  });

  it("loadAutoMemory：索引+互链聚合；entryCount 计数排除索引自身", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, MEMORY_INDEX_FILE), "- [t](testing.md) hook, see [[testing]]\n", "utf8");
    writeFileSync(path.join(dir, "testing.md"), "---\nname: testing\ntype: project\nschemaVersion: 1\n---\nrun bun test", "utf8");
    const v = loadAutoMemory(dir);
    expect(v.entryCount).toBe(1);
    expect(v.resolved).toHaveLength(1);
    expect(v.missing).toHaveLength(0);
    const text = renderAutoMemoryContext(v)!;
    expect(text).toContain("## Project memory index (MEMORY.md)");
    expect(text).toContain("## Memory: testing");
    expect(text).toContain("run bun test");
  });

  it("空目录=render 返回 null（不注入）", () => {
    expect(renderAutoMemoryContext(loadAutoMemory(fixture()))).toBeNull();
  });
});

describe("DoD④ 维护纪律段（[自定] 措辞；结构借鉴 _533 形状）", () => {
  const d = buildMemoryDisciplinePrompt();
  it("两步法/frontmatter 形/索引行形状/四 type/互链/staleness/200 行截断提示全在", () => {
    expect(d).toContain("two steps");
    expect(d).toContain("schemaVersion: 1");
    expect(d).toContain("- [Title](slug.md)");
    expect(d).toContain("type: user | feedback | project | reference");
    expect(d).toContain("[[name]]");
    expect(d).toContain("200 lines / 25,000 bytes");
    expect(d).toContain("stale");
    expect(d).toContain("placeholder for something you plan to write later"); // R1 修复后措辞
    expect(d).toContain("**user**");
    expect(d).toContain("**feedback**");
    expect(d).toContain("**project**");
    expect(d).toContain("**reference**");
  });
  it("autoTrackEnabled=false → 空串（整轨关）", () => {
    expect(buildMemoryDisciplinePrompt({ autoTrackEnabled: false })).toBe("");
  });
});
