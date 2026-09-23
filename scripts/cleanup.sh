#!/usr/bin/env bash
# standardcode 手动清理脚本 — macOS / Linux（Windows 用 scripts/cleanup.ps1）。
# ADR-0044 决策 5/6：不经 CLI 的等价卸载通道（自动化矩阵与 CLI 不可用时）——逐步打印、逐步断言。
# 步骤：①npm rm -g @standardcode-oss/cli（残留断言）②PATH 留痕还原（install-manifest.json）③--purge-home 删 ~/.standardcode（残留断言）。
# 用法：bash scripts/cleanup.sh [--purge-home]（不带旗标=仅程序体+PATH；矩阵自动化可直接带旗标=非交互）
set -euo pipefail

PKG="@standardcode-oss/cli"
HOME_DIR="${HOME:?}"
DATA_DIR="$HOME_DIR/.standardcode"
MANIFEST="$DATA_DIR/install-manifest.json"
PURGE_HOME=0
[ "${1:-}" = "--purge-home" ] && PURGE_HOME=1

log() { echo "[cleanup] $*"; }
fail() { echo "[cleanup] FAILED: $*"; exit 1; }

# ① 程序体
if command -v npm >/dev/null 2>&1; then
  log "removing global package ($PKG)…"
  npm rm -g "$PKG" || fail "npm rm -g failed — 关闭正在运行的 standardcode 实例后重试"
else
  log "npm not found — skip package removal"
fi
if command -v standardcode >/dev/null 2>&1; then
  fail "standardcode still on PATH after removal — npm 全局 bin 目录残留 shim，手动删除"
fi
log "residue check: package gone ✓"

# ② PATH 留痕还原（POSIX rc 文件行删除）
if [ -f "$MANIFEST" ]; then
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const e of m.pathEntries || []) {
      if (e.scope !== "posix-rcfile" || !e.file || !fs.existsSync(e.file)) { console.log("[cleanup] PATH entry not present (skip): " + e.value); continue; }
      const lines = fs.readFileSync(e.file, "utf8").split("\n");
      const kept = lines.filter((l) => !l.includes(e.value));
      if (kept.length === lines.length) { console.log("[cleanup] PATH entry not present (skip): " + e.value); continue; }
      fs.writeFileSync(e.file, kept.join("\n"));
      console.log("[cleanup] PATH entry removed: " + e.value);
    }
  ' "$MANIFEST"
else
  log "no install manifest (skip PATH restore)"
fi

# ③ --purge-home（用户数据）
if [ "$PURGE_HOME" = "1" ]; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    [ -d "$DATA_DIR" ] && fail "$DATA_DIR still present after rm"
    log "purged $DATA_DIR ✓"
  else
    log "$DATA_DIR absent (skip purge)"
  fi
else
  log "user data dir kept: $DATA_DIR（如需删除重跑加 --purge-home）"
fi

log "done"
