// F19（2026-09-29 真机实测）修复回归：git clone 失败路径原早退——清理只挂在成功路 finally，
// 每次失败在临时根留下一个**空**中转目录（真机 `%TEMP%` 实测累积 199 个 `sc-plugin-*` 全空，
// 时间戳与各次失败运行一一对应）。修复=materializeMarketplace 失败时就地回收（两调用方零改动）。
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installPlugin, pluginsRecordFile } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "sc-f19-"));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* 可接受 */
  }
});

const failGit = () => ({ status: 128, stderr: "fatal: could not read from remote repository" });
const leftovers = (tmpRoot: string) => readdirSync(tmpRoot).filter((n) => n.startsWith("sc-plugin-"));
function fresh(name: string): { tmpRoot: string; baseDir: string } {
  const base = path.join(root, name);
  const tmpRoot = path.join(base, "tmp");
  const baseDir = path.join(base, "cfg");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(baseDir, { recursive: true });
  return { tmpRoot, baseDir };
}

describe("F19：clone 失败不留空中转目录", () => {
  it("git 源路：clone 失败=clone-failed 且 tmpRoot 零残留", async () => {
    const { tmpRoot, baseDir } = fresh("g1");
    const out = await installPlugin("https://example.invalid/nope.git", { baseDir, opts: { tmpRoot, runGit: failGit } });
    expect(out.error).toBe("clone-failed");
    expect(leftovers(tmpRoot)).toEqual([]); // 修复前 = ["sc-plugin-<ts>-<rand>"]（空目录）
  });

  it("市场名检索路（marketplace 源 clone 失败）：marketplace-entry-not-found 且零残留", async () => {
    const { tmpRoot, baseDir } = fresh("g2");
    writeFileSync(
      pluginsRecordFile(baseDir),
      JSON.stringify({ schemaVersion: 1, plugins: [], marketplaces: [{ name: "broken-mkt", source: "https://example.invalid/mkt.git" }] }),
      "utf8",
    );
    const out = await installPlugin("whatever", { baseDir, opts: { tmpRoot, runGit: failGit } });
    expect(out.error).toBe("marketplace-entry-not-found");
    expect(leftovers(tmpRoot)).toEqual([]); // 修复前同一泄漏（materializeMarketplace 失败即弃）
  });

  it("成功路不回归：clone 成功后中转目录同样不得残留（既有 finally 语义保持）", async () => {
    const { tmpRoot, baseDir } = fresh("g3");
    const out = await installPlugin("https://example.invalid/ok.git", {
      baseDir,
      opts: {
        tmpRoot,
        runGit: (args) => {
          const dest = args[args.length - 1]!;
          mkdirSync(dest, { recursive: true });
          writeFileSync(path.join(dest, "plugin.json"), JSON.stringify({ schemaVersion: 1, name: "OkPlug", version: "1.0.0", skills: ["skills"] }), "utf8");
          return { status: 0 };
        },
      },
    });
    expect(out.ok).toBe(true);
    expect(leftovers(tmpRoot)).toEqual([]);
  });
});
