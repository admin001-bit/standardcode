// L4 executor 单测：六原语行为 + fail-closed 角落。
import { mkdtemp, readFile, mkdir, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASH_TIMEOUT_MAX_MS,
  ExecError,
  execBash,
  execEdit,
  execGlob,
  execGrep,
  execRead,
  execWrite,
  type ExecEnv,
} from "../src/index.ts";

let dir: string;
const env = (): ExecEnv => ({ cwd: dir });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stdcode-exec-"));
  await writeFile(join(dir, "hello.txt"), "alpha\nbeta\ngamma\n", "utf8");
  await mkdir(join(dir, "src", "nested"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "const one = 1;\n", "utf8");
  await writeFile(join(dir, "src", "b.ts"), "const two = 2;\n", "utf8");
  await writeFile(join(dir, "src", "nested", "c.md"), "# doc\n", "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("execBash", () => {
  it("runs a command and returns stdout", async () => {
    const out = await execBash({ command: process.platform === "win32" ? "echo hi" : "echo hi" }, env());
    expect(out).toContain("hi");
  });

  it("non-zero exit → ExecError with exit code and stderr", async () => {
    await expect(execBash({ command: process.platform === "win32" ? "exit /b 3" : "exit 3" }, env())).rejects.toThrow(/exit code 3/);
  });

  it("timeout clamped and timeout kill → ExecError", async () => {
    await expect(
      execBash({ command: `node -e "setTimeout(function(){}, 10000)"`, timeout: 500 }, env()),
    ).rejects.toThrow(/timed out/);
    // 超上限夹到 600000
    const cmd = { command: "echo ok", timeout: BASH_TIMEOUT_MAX_MS + 5000 };
    await expect(execBash(cmd, env())).resolves.toContain("ok");
  }, 15000);
});

describe("execRead", () => {
  it("cat -n numbering with 6-width gutter and tab", async () => {
    const out = await execRead({ file_path: "hello.txt" }, env());
    expect(out).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  it("offset/limit window (with remaining hint)", async () => {
    const out = await execRead({ file_path: "hello.txt", offset: 2, limit: 1 }, env());
    expect(out).toContain("     2\tbeta");
    expect(out).toContain("... (+1 more lines)");
  });

  it("missing file → ExecError; directory → not a regular file", async () => {
    await expect(execRead({ file_path: "nope.txt" }, env())).rejects.toThrow(ExecError);
    await expect(execRead({ file_path: "src" }, env())).rejects.toThrow(/not a regular file/);
  });
});

describe("execWrite", () => {
  it("creates file and parent dirs; overwrites existing", async () => {
    const p = "out/deep/new.txt";
    await execWrite({ file_path: p, content: "v1" }, env());
    expect(await readFile(join(dir, "out/deep/new.txt"), "utf8")).toBe("v1");
    await execWrite({ file_path: p, content: "v2" }, env());
    expect(await readFile(join(dir, "out/deep/new.txt"), "utf8")).toBe("v2");
  });

  it("directory target → ExecError; non-string content → ExecError", async () => {
    await expect(execWrite({ file_path: "src", content: "x" }, env())).rejects.toThrow(/directory/);
    await expect(execWrite({ file_path: "x.txt", content: 42 as unknown as string }, env())).rejects.toThrow(/content/);
  });
});

describe("execEdit", () => {
  it("unique replace; replace_all replaces every occurrence", async () => {
    await execWrite({ file_path: "edit-me.txt", content: "a b a\n" }, env());
    await execEdit({ file_path: "edit-me.txt", old_string: "b", new_string: "B" }, env());
    expect(await readFile(join(dir, "edit-me.txt"), "utf8")).toBe("a B a\n");
    await execEdit({ file_path: "edit-me.txt", old_string: "a", new_string: "z", replace_all: true }, env());
    expect(await readFile(join(dir, "edit-me.txt"), "utf8")).toBe("z B z\n");
  });

  it("not-found / non-unique / identical → ExecError (fail-closed)", async () => {
    await expect(execEdit({ file_path: "hello.txt", old_string: "absent", new_string: "x" }, env())).rejects.toThrow(/not found/);
    await expect(execEdit({ file_path: "hello.txt", old_string: "a", new_string: "x" }, env())).rejects.toThrow(/not unique/);
    await expect(execEdit({ file_path: "hello.txt", old_string: "alpha", new_string: "alpha" }, env())).rejects.toThrow(/identical/);
  });
});

describe("execGlob", () => {
  it("star within segment; doublestar across dirs", async () => {
    // 专用子树避免其他用例产物干扰
    await mkdir(join(dir, "gsrc", "nested"), { recursive: true });
    await writeFile(join(dir, "gsrc", "x.ts"), "1\n", "utf8");
    await writeFile(join(dir, "gsrc", "nested", "y.ts"), "2\n", "utf8");
    const one = await execGlob({ pattern: "gsrc/*.ts" }, env());
    expect(one.split("\n")).toEqual(["gsrc/x.ts"]);
    const all = await execGlob({ pattern: "gsrc/**/*.ts" }, env());
    expect(all.split("\n").sort()).toEqual(["gsrc/nested/y.ts", "gsrc/x.ts"]);
  });

  it("sorted by mtime descending (newest first)", async () => {
    await execWrite({ file_path: "older.txt", content: "o" }, env());
    await execWrite({ file_path: "newer.txt", content: "n" }, env());
    const now = new Date();
    const oldDate = new Date(now.getTime() - 60_000);
    await utimes(join(dir, "older.txt"), oldDate, oldDate);
    const out = await execGlob({ pattern: "*.txt" }, env());
    expect(out.indexOf("newer.txt")).toBeLessThan(out.indexOf("older.txt"));
  });

  it("no match → literal no files found; skips node_modules/.git", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x", "utf8");
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "x", "utf8");
    expect(await execGlob({ pattern: "**/*.js" }, env())).toBe("no files found");
  });
});

describe("execGrep", () => {
  it("content mode: match lines with relative path:line: text", async () => {
    const out = await execGrep({ pattern: "const" }, env());
    expect(out).toContain("src/a.ts:");
    expect(out).toContain("const one = 1;");
  });

  it("files_with_matches and count modes", async () => {
    const files = await execGrep({ pattern: "const", output_mode: "files_with_matches" }, env());
    expect(files.split("\n").sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const count = await execGrep({ pattern: "const", output_mode: "count" }, env());
    expect(count).toContain("src/a.ts:");
  });

  it("include glob filter; case_insensitive", async () => {
    const onlyMd = await execGrep({ pattern: "doc", include: "*.md" }, env());
    expect(onlyMd).toContain("src/nested/c.md");
    expect(await execGrep({ pattern: "CONST", case_insensitive: true }, env())).toContain("const one");
  });

  it("no matches → no matches found (exit 1 is success)", async () => {
    expect(await execGrep({ pattern: "zzz_no_such_zzz" }, env())).toBe("no matches found");
  });

  it("bad regex → usage error without searching (fail-closed)", async () => {
    await expect(execGrep({ pattern: "([unclosed" }, env())).rejects.toThrow(/ripgrep rejected/);
  });

  it("missing rg binary → install guidance (ENOENT path)", async () => {
    // 用一个必然不存在的 rg 可执行文件触发 ENOENT → 指引文案
    process.env.STANDARD_CODE_RIPGREP_PATH = process.platform === "win32" ? "definitely-not-rg.exe" : "definitely-not-rg";
    try {
      await expect(execGrep({ pattern: "x" }, env())).rejects.toThrow(/ripgrep not found on PATH/);
    } finally {
      delete process.env.STANDARD_CODE_RIPGREP_PATH;
    }
  });
});

describe("execRead overlong lines", () => {
  it("long line truncated with marker", async () => {
    const long = "x".repeat(3000);
    await execWrite({ file_path: "long.txt", content: long + "\n" }, env());
    const out = await execRead({ file_path: "long.txt" }, env());
    expect(out).toContain("…[line truncated]");
    expect(out.length).toBeLessThan(2500);
  });
});

describe("execGlob written-file verify", () => {
  it("glob result file really exists", async () => {
    const out = await execGlob({ pattern: "src/*.ts" }, env());
    for (const line of out.split("\n")) {
      const info = await stat(join(dir, line));
      expect(info.isFile()).toBe(true);
    }
  });
});

describe("runProcess abort (WP-13 V 观察⑤：树杀原语测试缺口)", () => {
  it("abort → 子进程及时终止（Windows taskkill /T /F、POSIX 进程组 SIGKILL）", async () => {
    const { runProcess } = await import("../src/index.ts");
    const ctl = new AbortController();
    const long = process.platform === "win32" ? ["-e", "setTimeout(function(){},60000)"] : ["-e", "setTimeout(function(){},60000)"];
    const p = runProcess({ command: process.execPath, args: ["-e", long[1]!], signal: ctl.signal, timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 200)); // 子进程已起
    ctl.abort();
    const started = Date.now();
    const result = await p;
    expect(Date.now() - started).toBeLessThan(5000); // 60s 进程被打断
    expect(result.code === 0).toBe(false); // 非正常退出
  }, 15000);
});
