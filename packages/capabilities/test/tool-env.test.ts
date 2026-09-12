// WP-08（M3）SEC-080 capabilities 装配面：tool-factory env 构造（会话级清洗快照）+ debug 通道。
// 判据自足（板 WP-08 DoD）：②API key 不进子进程 env（工具轮真子进程回读）；边界"快照 debug 通道"（显式 > 隐式）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStandardTools } from "../src/tool-factory.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stdcode-wp08-cap-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withEnv(name: string, value: string, fn: () => Promise<void> | void): Promise<void> | void {
  const saved = process.env[name];
  process.env[name] = value;
  const run = async () => {
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };
  return run();
}

describe("createStandardTools env 构造（SEC-080 DoD② 工具面）", () => {
  it("Bash 工具真子进程回读：创建时已注入的 API key 探针不出现在子进程 env", async () => {
    await withEnv("ANTHROPIC_API_KEY", "sk-ant-cap-probe", async () => {
      await withEnv("STANDARD_CODE_WP08_CAP_PROBE", "cap", async () => {
        const tools = createStandardTools({ cwd: dir });
        const bash = tools.find((t) => t.name === "Bash");
        expect(bash).toBeDefined();
        const ctx = { signal: new AbortController().signal, registerProcess: () => {} };
        const out = await bash!.execute({ command: `node -e "console.log(JSON.stringify(process.env))"` }, ctx);
        const child = JSON.parse(out.trim()) as Record<string, string>;
        expect(child.ANTHROPIC_API_KEY).toBeUndefined();
        expect(child.STANDARD_CODE_WP08_CAP_PROBE).toBeUndefined();
        expect(child.PATH ?? child.Path).toBeTruthy();
      });
    });
  }, 30_000);
});

describe("tool-env 快照 debug 通道（卡边界『快照 debug 通道』；显式 > 隐式）", () => {
  it("显式 debugToolEnv=true → 注入流写 [tool-env] 行含剔除归因；缺省静默", async () => {
    await withEnv("STANDARD_CODE_WP08_CAP_PROBE", "cap", () => {
      const lines: string[] = [];
      createStandardTools({ cwd: dir, debugToolEnv: true, debugStream: { write: (s) => lines.push(s) } });
      const joined = lines.join("");
      expect(joined).toContain("[tool-env]");
      expect(joined).toContain("STANDARD_CODE_WP08_CAP_PROBE");
      expect(joined).toContain("standardcode-channel");
      const silent: string[] = [];
      createStandardTools({ cwd: dir, debugToolEnv: false, debugStream: { write: (s) => silent.push(s) } });
      expect(silent).toEqual([]);
    });
  });

  it("隐式 STANDARD_CODE_DEBUG=1 开快照；显式 false 压过隐式真值（DP-4 优先序）", async () => {
    await withEnv("STANDARD_CODE_DEBUG", "1", () => {
      const lines: string[] = [];
      createStandardTools({ cwd: dir, debugStream: { write: (s) => lines.push(s) } });
      expect(lines.join("")).toContain("[tool-env]");
      const overridden: string[] = [];
      createStandardTools({ cwd: dir, debugToolEnv: false, debugStream: { write: (s) => overridden.push(s) } });
      expect(overridden).toEqual([]);
    });
  });
});
