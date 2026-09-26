// M8-WP-12 判据（缺陷 D-1：`reg query` 输出按控制台代码页编码而按 utf8 解码 ⇒ 非 ASCII 段回写有损）：
// ①读命令形钉 UTF-8（`cmd /c chcp 65001` 包装；裸 reg 直读＝控制台代码页＝有损）②解析保真（非 ASCII 逐字符，含替换符段）
// ③fail-closed（不可读→failed 且零写调用）④写回载荷保真（非 ASCII 原样进 `/d`）⑤win32 只读实证：新读通道 ≡ `reg export` 独立通道。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildUserPathQuery, defaultPathRestorer, parseRegQueryPath, type SpawnLike } from "../src/uninstall.ts";

const HEAD = "\r\nHKEY_CURRENT_USER\\Environment\r\n";
/** WP-09 事故后本机现值形态：`ʶ`（U+02B6）＋U+FFFD×2——解析须逐字符原样（旧通道在此必被 mangled）。 */
const MANGLED = "D:\\OCR\u02B6\uFFFD\uFFFD";

describe("M8-WP-12 DoD① 读命令形（D-1 修复点：控制台代码页钉 UTF-8）", () => {
  it("查询命令＝cmd /c chcp 65001>nul & reg query（裸 reg 直读为控制台代码页＝有损）", () => {
    const q = buildUserPathQuery();
    expect(q.cmd).toBe("cmd");
    expect(q.args).toHaveLength(2);
    expect(q.args[0]).toBe("/c");
    expect(q.args[1]).toContain("chcp 65001");
    expect(q.args[1]).toContain("reg query HKCU\\Environment /v Path");
  });
});

describe("M8-WP-12 DoD① 解析保真（非 ASCII 逐字符；行终止符不进值）", () => {
  const value = `C:\\Tools;D:\\OCR识别;${MANGLED}`;
  it("REG_EXPAND_SZ 值含 GBK 段（识别）与替换符段：逐字符原样", () => {
    const out = `${HEAD}    Path    REG_EXPAND_SZ    ${value}\r\n\r\n`;
    expect(parseRegQueryPath(out)).toBe(value);
  });
  it("不可读输出→null（fail-closed 信号；REG_SZ 形亦不解析＝既有窄形，防回写改值类型语义）", () => {
    expect(parseRegQueryPath("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
    expect(parseRegQueryPath("")).toBeNull();
    expect(parseRegQueryPath(`${HEAD}    Path    REG_SZ    C:\\a\r\n`)).toBeNull();
  });
});

describe("M8-WP-12 DoD③/④ 还原器（注入桩）：fail-closed 零写／写回载荷逐字符", () => {
  const entry = { value: "C:\\Tools", scope: "win-user-registry" as const };

  it("不可读（无匹配）→ failed 记录、仅读调用（零写）", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawn: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "ERROR: 找不到指定的注册表项或值。", stderr: "" };
    };
    const r = await defaultPathRestorer([entry], { spawn });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toBe("HKCU Path not readable");
    expect(r.removed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("cmd"); // 读走 chcp 包装；无任何 reg add
  });

  it("移除一项：写回载荷非 ASCII 段逐字符原样（/d 参数断言）", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const full = `C:\\Tools;D:\\OCR识别;${MANGLED};C:\\keep`;
    const spawn: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "cmd") return { status: 0, stdout: `${HEAD}    Path    REG_EXPAND_SZ    ${full}\r\n\r\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await defaultPathRestorer([entry], { spawn });
    expect(r.removed).toEqual(["C:\\Tools"]);
    expect(r.failed).toEqual([]);
    expect(calls).toHaveLength(2);
    const w = calls[1]!;
    expect(w.cmd).toBe("reg");
    const i = w.args.indexOf("/d");
    expect(i).toBeGreaterThan(-1);
    expect(w.args[i + 1]).toBe(`D:\\OCR识别;${MANGLED};C:\\keep`);
  });
});

describe("M8-WP-12 DoD① win32 只读实证（零注册表写）", () => {
  const onWin = process.platform === "win32" ? it : it.skip;

  onWin("新读通道 ≡ reg export 独立通道（hex(2) 逐字符相等；旧通道在有非 ASCII 段时必红）", () => {
    const q = buildUserPathQuery();
    const r = spawnSync(q.cmd, q.args, { encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(0);
    const viaQuery = parseRegQueryPath(`${r.stdout ?? ""}`);
    expect(viaQuery).not.toBeNull();

    const dir = mkdtempSync(path.join(tmpdir(), "sc-wp12-"));
    try {
      const reg = path.join(dir, "env.reg");
      const e = spawnSync("reg", ["export", "HKCU\\Environment", reg, "/y"], { encoding: "utf8", windowsHide: true });
      expect(e.status).toBe(0);
      const viaExport = parseRegExportPath(readFileSync(reg));
      expect(viaExport).not.toBeNull();
      expect(viaQuery).toBe(viaExport);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/** `reg export` 文件解析 Path 值：UTF-16LE BOM；`hex(2):` 多行形（REG_EXPAND_SZ）与明文形（REG_SZ）。 */
function parseRegExportPath(buf: Buffer): string | null {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^"Path"\s*=/.test(l));
  if (i < 0) return null;
  const payload = lines[i]!.slice(lines[i]!.indexOf("=") + 1).trimStart();
  const hexHead = /^hex(?:\(\d+\))?:/.exec(payload);
  if (hexHead) {
    let data = "";
    let line = payload.slice(hexHead[0].length);
    let j = i;
    for (;;) {
      const cont = line.endsWith("\\");
      data += cont ? line.slice(0, -1) : line;
      if (!cont) break;
      j++;
      line = (lines[j] ?? "").trimStart();
    }
    const bytes = data
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .map((t) => parseInt(t, 16));
    return Buffer.from(bytes).toString("utf16le").replace(/\u0000+$/, "");
  }
  return payload.replace(/^"|"$/g, "").replace(/\\([\\"])/g, "$1");
}
