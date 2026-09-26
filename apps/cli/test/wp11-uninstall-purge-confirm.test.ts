// M8-WP-11 判据：①入口确认通道装配（D-V1：TTY 判定→confirm 装配；非 TTY 仍 fail-closed）
// ②D-1 错误路径（删除抛错 → `purge FAILED` 文案＋rc=1，不裸抛）③既有窄形（不抛但目录仍在）保持。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runUninstallCli, type UninstallIo } from "../src/uninstall.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "sc-wp11-"));
  const dataDir = path.join(root, ".standardcode");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "session.jsonl"), "{}\n", "utf8");
  return { root, dataDir, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const baseIo = (root: string, dataDir: string, out: string[]): UninstallIo => ({
  write: (l) => out.push(l),
  homeDir: root,
  dataDir,
  platform: process.platform,
  runner: async () => ({ status: 0 }),
  verifyGone: async () => ({ gone: true, detail: "stub: package gone" }),
  pathRestorer: async () => ({ removed: [], skipped: [], failed: [] }),
});

describe("M8-WP-11 DoD① 入口确认通道装配（D-V1）", () => {
  it("TTY（注入 isTTY=true）＋确认通过 → 确认被调用恰一次、purge 全链 rc=0、目录消失", async () => {
    const { root, dataDir, cleanup } = fixture();
    try {
      const out: string[] = [];
      let asked = 0;
      const rc = await runUninstallCli(["--purge"], {
        ...baseIo(root, dataDir, out),
        isTTY: true,
        confirm: async () => {
          asked++;
          return true;
        },
      });
      expect(asked).toBe(1);
      expect(rc).toBe(0);
      expect(existsSync(dataDir)).toBe(false);
      expect(out.join("\n")).toContain("[uninstall] purged");
      expect(out.join("\n")).toContain("[uninstall] done");
    } finally {
      cleanup();
    }
  });

  it("非 TTY（isTTY=false，不注入 confirm）→ 仍 fail-closed 拒绝（rc=1、目录保留）", async () => {
    const { root, dataDir, cleanup } = fixture();
    try {
      const out: string[] = [];
      const rc = await runUninstallCli(["--purge"], { ...baseIo(root, dataDir, out), isTTY: false });
      expect(rc).toBe(1);
      expect(existsSync(dataDir)).toBe(true);
      expect(out.join("\n")).toContain("--purge requires interactive confirmation (non-TTY = refused, fail-closed)");
    } finally {
      cleanup();
    }
  });

  it("用户拒答（确认返回 false）→ rc=1、purge 中止、目录保留", async () => {
    const { root, dataDir, cleanup } = fixture();
    try {
      const out: string[] = [];
      const rc = await runUninstallCli(["--purge"], { ...baseIo(root, dataDir, out), isTTY: true, confirm: async () => false });
      expect(rc).toBe(1);
      expect(existsSync(dataDir)).toBe(true);
      expect(out.join("\n")).toContain("[uninstall] purge aborted by user");
    } finally {
      cleanup();
    }
  });

  it("入口默认装配在岗（扫描型断言，判别力边界随结果页登记）：isTTY 且未注入 confirm 时装配默认通道", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/uninstall.ts", import.meta.url)), "utf8");
    expect(src).toContain("if (isTTY && io.confirm === undefined)");
    expect(src).toContain("node:readline");
  });
});

describe("M8-WP-11 DoD② D-1 错误路径（删除抛错 → FAILED 文案＋rc=1）", () => {
  it("removeDir 抛 EPERM → rc=1＋`purge FAILED` 文案（含原因）＋目录保留（不裸抛）", async () => {
    const { root, dataDir, cleanup } = fixture();
    try {
      const out: string[] = [];
      const rc = await runUninstallCli(["--purge"], {
        ...baseIo(root, dataDir, out),
        isTTY: true,
        confirm: async () => true,
        removeDir: () => {
          const err = new Error("EPERM: operation not permitted, rmdir") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
      });
      expect(rc).toBe(1);
      expect(existsSync(dataDir)).toBe(true);
      const text = out.join("\n");
      expect(text).toContain("[uninstall] purge FAILED");
      expect(text).toContain("EPERM");
      expect(text).toContain("scripts/cleanup.*");
    } finally {
      cleanup();
    }
  });

  it("既有窄形保持（removeDir 不抛但目录仍在）→ rc=1＋`still present` 文案", async () => {
    const { root, dataDir, cleanup } = fixture();
    try {
      const out: string[] = [];
      const rc = await runUninstallCli(["--purge"], { ...baseIo(root, dataDir, out), isTTY: true, confirm: async () => true, removeDir: () => {} });
      expect(rc).toBe(1);
      expect(out.join("\n")).toContain("still present");
    } finally {
      cleanup();
    }
  });
});
