// F10（2026-09-29 真机实测）修复回归：pluginRoot 为**相对路径**时组件目录不得被误判"越界"。
// 真机实证：同一 plugin（含 skills/<名>/SKILL.md），`/plugin install plugins\b4plugin` → 0 skill(s) + 一条
// `skills "skills" escapes plugin root (ignored)` warn；绝对路径安装 → 1 skill(s)。
// 根因：path.resolve(root, rel) 产出绝对路径，而 root 仍是相对串 → 前缀比较恒假（本文件即锁该形）。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "../src/index.ts";

const M = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, name: "p", version: "0.0.1", ...extra });

describe("plugin 组件目录的 root 形（F10 修复）", () => {
  it("相对 pluginRoot + 显式 skills：保留且零越界告警", () => {
    const root = path.join("relative", "p");
    const r = parsePluginManifest(M({ skills: ["skills"] }), path.join(root, "plugin.json"), root);
    expect(r.warnings.join("\n")).not.toContain("escapes plugin root");
    expect(r.manifest?.components.skillsDirs).toEqual([path.resolve(root, "skills")]);
  });

  it("相对 pluginRoot + agents 同形（回归覆盖第二组件位）", () => {
    const root = path.join("relative", "p");
    const r = parsePluginManifest(M({ agents: ["agents", "sub/agents"] }), path.join(root, "plugin.json"), root);
    expect(r.warnings.join("\n")).not.toContain("escapes plugin root");
    expect(r.manifest?.components.agentsDirs.length).toBe(2);
  });

  it("绝对 pluginRoot：同形（对照，恒不回归）", () => {
    const root = path.resolve("relative", "p");
    const r = parsePluginManifest(M({ skills: ["skills"] }), path.join(root, "plugin.json"), root);
    expect(r.warnings.join("\n")).not.toContain("escapes plugin root");
    expect(r.manifest?.components.skillsDirs).toEqual([path.join(root, "skills")]);
  });

  it("真实越界（../outside）仍被拒——fail-closed 语义不回归", () => {
    const root = path.join("relative", "p");
    const r = parsePluginManifest(M({ skills: ["../outside"] }), path.join(root, "plugin.json"), root);
    expect(r.warnings.join("\n")).toContain("escapes plugin root");
    expect(r.manifest?.components.skillsDirs).toEqual([]);
  });
});
