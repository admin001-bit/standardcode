// WP-11：/config 写 local 层的专用函数（与 WP-07 persistAlwaysAllow 同形制；坏 JSON 不覆盖）。
// settings.local.json 是唯一可写层（ADR-0030/ADR-0037 语义：项目 local=用户显式操作面）。
// S6-5（全仓审查 2026-10-01）：读-改-写加同步跨进程锁（O_EXCL + pid/ts + 30s 陈旧抢占，ADR-0031
// 同族 sync 形）＋ temp+rename 原子替换——原 writeFileSync 直写：双实例并发丢更新；写中断留截断
// JSON 后所有写入永久 `refusing to overwrite`（/config、/theme、总是允许全废）。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { settingsSourcePaths } from "@standardcode/platform";

const LOCK_STALE_MS = 30_000;
let tmpSeq = 0;

/** 同步跨进程锁（ADR-0031 形 sync 化）：O_EXCL 抢占、30s 陈旧可抢、100×20ms≈2s 自旋上限。
 *  返回释放函数；拿不到（超时）返回 null——调用方 fail-closed 拒写（可用性优先于静默丢更新）。 */
function acquireLockSync(target: string): (() => void) | null {
  const lockPath = `${target}.lock`;
  const payload = `pid=${process.pid}\nts=${Date.now()}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已被陈旧抢占等：幂等 */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null; // 非锁冲突（如目录缺）→ 不锁，走原子写
      try {
        const raw = readFileSync(lockPath, "utf8");
        const m = /ts=(\d+)/.exec(raw);
        if (m && Date.now() - Number(m[1]) > LOCK_STALE_MS) {
          unlinkSync(lockPath); // 陈旧（进程死于写中等）抢占
          continue;
        }
      } catch {
        continue; // 锁文件瞬时消失 → 下一轮
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // 同步退避 20ms
      } catch {
        return null;
      }
    }
  }
  return null; // 自旋上限：调用方 fail-closed
}

/** 写 local 层单键（点路径；value=JSON 值）。返回落盘路径。 */
export function setLocalSetting(projectRoot: string, key: string, value: unknown, file?: string): string {
  const target = file ?? settingsSourcePaths(projectRoot).projectLocal;
  mkdirSync(path.dirname(target), { recursive: true }); // 锁文件随目录——先于 acquire（首次写目录不存在会 ENOENT→误 busy）
  const release = acquireLockSync(target);
  if (release === null) {
    throw new Error(`settings busy: another writer holds ${target}.lock (lock timeout ~2s) — refusing to overwrite`);
  }
  try {
    let doc: Record<string, unknown> = { schemaVersion: 1 };
    if (existsSync(target)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(target, "utf8"));
      } catch {
        throw new Error(`settings.local.json invalid JSON; refusing to overwrite (fix the file first): ${target}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`settings.local.json is not a JSON object; refusing to overwrite: ${target}`);
      }
      doc = parsed as Record<string, unknown>;
    }
    // 点路径写入（叶子赋值；中间层为对象）。
    // S6-2（全仓审查 2026-10-01）原型污染拒写：`cur["__proto__"]` 读到 Object.prototype（非 null/对象）
    // 不重置 → cur 下钻到原型对象后赋值即进程级污染；`constructor`/`prototype` 链同通。任一段命中即抛
    //（/config 用户可控键是唯一非固定键来源——固定键 ui.theme 等不会含这些段，零误伤）。
    const segs = key.split(".");
    if (segs.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
      throw new Error(`unsafe settings key (prototype-chain segment): ${key}`);
    }
    let cur = doc;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      if (cur[seg] === null || typeof cur[seg] !== "object" || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]!] = value;
    doc.schemaVersion = 1;
    mkdirSync(path.dirname(target), { recursive: true });
    // S6-5 原子写：同目录 temp + rename——写中断/进程死不再留截断 JSON（原直写使后续全部 refusing）
    const tmp = `${target}.${process.pid}-${tmpSeq++}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 半成品清理 best-effort */
      }
      throw err;
    }
    return target;
  } finally {
    release();
  }
}
