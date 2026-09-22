#!/usr/bin/env bash
# standardcode 直接二进制卸载器 —— Linux（x64）。M7 WP-10。
# 与 install.sh 对称：移除 bin + 还原 PATH 项 + 清理通道留痕 + **残留断言**（fail-closed）。
# 零提权；**不依赖 node**（本通道安装器本身不要求 node，故卸载器亦须自足）：
#   ① bin 移除 ② PATH 行删除（候选 rc = channels.ndjson 记录的 rcFile ∪ ~/.bashrc ∪ ~/.zshrc）
#   ③ channels.ndjson 记录清理 ④ best-effort 清理 M5 install-manifest.json 同款条目（node 在位时）⑤ 残留断言
# 用法：bash packaging/linux/uninstall.sh [--prefix DIR]
set -uo pipefail

NAME="standardcode"
PREFIX="${STANDARDCODE_PREFIX:-$HOME/.local}"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix 需要目录}"; shift 2 ;;
    -h|--help) echo "usage: uninstall.sh [--prefix DIR]"; exit 0 ;;
    *) echo "[uninstall] 未知参数: $1" >&2; exit 1 ;;
  esac
done

DATA_DIR="$HOME/.standardcode"
MANIFEST="$DATA_DIR/install-manifest.json"
CHANNELS="$DATA_DIR/channels.ndjson"
BIN_DIR="$PREFIX/bin"
BIN_PATH="$BIN_DIR/$NAME"
PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""

log() { echo "[uninstall] $*"; }

# ① 程序体移除
if [ -e "$BIN_PATH" ]; then rm -f "$BIN_PATH"; log "removed $BIN_PATH"; else log "bin 不在位（$BIN_PATH）"; fi

# ② PATH 行删除：候选 rc 集（ndjson 记录 ∪ 常规两件）
CANDS="$HOME/.bashrc
$HOME/.zshrc"
if [ -f "$CHANNELS" ]; then
  while IFS= read -r line; do
    case "$line" in *"\"binPath\":\"$BIN_PATH\""*) ;; *) continue ;; esac
    f="$(printf '%s' "$line" | sed -n 's/.*"rcFile":"\([^"]*\)".*/\1/p')"
    [ -n "$f" ] && CANDS="$CANDS
$f"
  done < "$CHANNELS"
fi
printf '%s\n' "$CANDS" | awk 'NF && !seen[$0]++' | while IFS= read -r RC; do
  [ -f "$RC" ] || continue
  if grep -qF "$PATH_LINE" "$RC"; then
    TMP="$(mktemp)"; grep -vF "$PATH_LINE" "$RC" > "$TMP" || true; mv "$TMP" "$RC"
    log "PATH entry removed from $RC"
  fi
done

# ③ channels.ndjson 记录清理（该 binPath 的全部行）
if [ -f "$CHANNELS" ]; then
  grep -vF "\"binPath\":\"$BIN_PATH\"" "$CHANNELS" > "$CHANNELS.tmp" || true
  mv "$CHANNELS.tmp" "$CHANNELS"
  log "channels.ndjson 记录已清理（本 bin 条目）"
fi

# ④ best-effort：M5 install-manifest.json 同款条目清理（node 在位时）
if [ -f "$MANIFEST" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs=require("fs");
    const p=process.argv[1], t=process.argv[2];
    const m=JSON.parse(fs.readFileSync(p,"utf8"));
    m.pathEntries=(m.pathEntries||[]).filter(e=>!(e&&e.value===t&&e.scope==="posix-rcfile"));
    fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
  ' "$MANIFEST" "$BIN_DIR" || true
  log "install-manifest.json 条目已清理（node 在位）"
fi

# ⑤ 残留断言（fail-closed：任一残留即 exit 1）
RESIDUE=0
[ -e "$BIN_PATH" ] && { echo "[uninstall] RESIDUE: $BIN_PATH 仍存在" >&2; RESIDUE=1; }
for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$RC" ] || continue
  grep -qF "$PATH_LINE" "$RC" && { echo "[uninstall] RESIDUE: $RC 仍含 $BIN_DIR" >&2; RESIDUE=1; }
done
if [ -f "$CHANNELS" ]; then
  grep -qF "\"binPath\":\"$BIN_PATH\"" "$CHANNELS" && { echo "[uninstall] RESIDUE: channels.ndjson 仍含本 bin 条目" >&2; RESIDUE=1; }
fi
[ "$RESIDUE" = "1" ] && { echo "[uninstall] FAILED: 存在残留" >&2; exit 1; }
log "residue assert PASSED（bin 与 PATH 项、通道留痕均已清除）"
log "done"
