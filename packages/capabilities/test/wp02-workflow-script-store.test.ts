// WP-02（M6）workflow 脚本持久化单测（交付物第四件）：文件名/runId 净化（防目录穿越）、运行目录组合、
// 落盘后可读回并再次求值（L170994 同构：调用方回填 scriptPath 供迭代重调）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistWorkflowScript,
  runWorkflowScript,
  sanitizeWorkflowRunId,
  sanitizeWorkflowScriptName,
  workflowRunDir,
  workflowScriptPath,
  type WorkflowHooks,
} from "../src/index.ts";

const created: string[] = [];

async function tmpRunsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stdc-wf-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function hooks(): WorkflowHooks {
  return {
    agent: async (prompt) => `agent:${prompt}`,
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items) => [...items],
  };
}

describe("文件名/runId 净化（防目录穿越）", () => {
  it("合法名原样保留", () => {
    expect(sanitizeWorkflowScriptName("release-audit.v2")).toBe("release-audit.v2");
    expect(sanitizeWorkflowRunId("run-2026-09-18T10")).toBe("run-2026-09-18T10");
  });

  it("穿越片段被折叠为单层名（`../` 与绝对路径均不可逃逸）", () => {
    expect(sanitizeWorkflowScriptName("../../evil")).toBe("evil");
    expect(sanitizeWorkflowScriptName("..\\..\\evil")).toBe("evil");
    expect(sanitizeWorkflowScriptName("/etc/passwd")).toBe("etc-passwd");
    expect(sanitizeWorkflowRunId("..")).toBe("run");
    expect(sanitizeWorkflowRunId("../../")).toBe("run");
  });

  it("空名回落缺省；超长截断", () => {
    expect(sanitizeWorkflowScriptName("")).toBe("workflow");
    expect(sanitizeWorkflowScriptName("...")).toBe("workflow");
    expect(sanitizeWorkflowScriptName("a".repeat(200))).toHaveLength(64);
  });

  it("非 ASCII 折叠为 `-`（Windows 文件名安全）", () => {
    expect(sanitizeWorkflowScriptName("调研编排")).toBe("workflow");
    expect(sanitizeWorkflowScriptName("audit-调研")).toBe("audit");
  });
});

describe("路径组合", () => {
  it("脚本路径 = <runsDir>/<runId>/<name>.js", () => {
    const runsDir = path.join(path.sep, "runs");
    expect(workflowScriptPath(runsDir, "r1", "audit")).toBe(path.join(runsDir, "r1", "audit.js"));
    expect(workflowRunDir(runsDir, "r1")).toBe(path.join(runsDir, "r1"));
  });

  it("恶意 name/runId 一律不越出 runsDir", () => {
    const runsDir = path.join(path.sep, "runs");
    for (const [runId, name] of [
      ["../../..", "../../../etc/passwd"],
      ["..", ".."],
      ["", ""],
    ]) {
      const target = path.resolve(workflowScriptPath(runsDir, runId, name));
      expect(target.startsWith(path.resolve(runsDir) + path.sep)).toBe(true);
    }
  });
});

describe("落盘与回读（L170994 同构）", () => {
  it("persistWorkflowScript 建目录、写原文、返回路径", async () => {
    const runsDir = await tmpRunsDir();
    const source = `export const meta = { name: "audit", description: "审计" };\nreturn 1;`;
    const target = await persistWorkflowScript(runsDir, "run-1", "audit", source);
    expect(target).toBe(path.join(runsDir, "run-1", "audit.js"));
    await expect(readFile(target, "utf8")).resolves.toBe(source);
  });

  it("落盘脚本可原样读回再求值（迭代重调不丢语义）", async () => {
    const runsDir = await tmpRunsDir();
    const source = `export const meta = { name: "audit", description: "审计" };\nconst who = await agent("ping");\nreturn who + ":" + meta.name;`;
    const target = await persistWorkflowScript(runsDir, "run-2", "audit", source);
    const reread = await readFile(target, "utf8");
    await expect(runWorkflowScript({ script: reread, hooks: hooks(), filename: target })).resolves.toBe("agent:ping:audit");
  });
});
