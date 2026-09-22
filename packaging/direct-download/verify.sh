#!/usr/bin/env bash
# standardcode 直接下载通道校验器（Linux/macOS）。M7 WP-10（附录 E 行 630「Windows winget/直接下载」）。
# 流程：下载产物 + SHA256SUMS.txt → sha256 逐条核验 → 提示运行。
# 用法：bash verify.sh [--base-url URL] [--artifact NAME] [--version X.Y.Z] [--dest DIR]
#   缺省 artifact 由 uname 推导：Linux→standardcode-linux-x64、Darwin→standardcode-darwin-arm64。
set -euo pipefail

DEFAULT_VERSION="0.1.0"
NAME="standardcode-darwin-arm64"
DEFAULT_BASE="https://github.com/admin001-bit/standardcode/releases/download"
VERSION="$DEFAULT_VERSION"
BASE="$DEFAULT_BASE"
DEST="."

case "$(uname -s)" in
  Linux) NAME="standardcode-linux-x64" ;;
  Darwin) NAME="standardcode-darwin-arm64" ;;
  *) echo "[verify] 未支持平台: $(uname -s)（Windows 用 verify.ps1）" >&2; exit 1 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE="${2:?}"; shift 2 ;;
    --artifact) NAME="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --dest) DEST="${2:?}"; shift 2 ;;
    -h|--help) echo "usage: verify.sh [--base-url URL] [--artifact NAME] [--version X.Y.Z] [--dest DIR]"; exit 0 ;;
    *) echo "[verify] 未知参数: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[verify] $*"; }
fail() { echo "[verify] FAILED: $*" >&2; exit 1; }

mkdir -p "$DEST"
BASE_DIR="$BASE/v$VERSION"

fetch() { # $1=url-or-localpath  $2=dest
  case "$BASE" in
    file://*|/*) cp "$1" "$2" ;;
    *)
      if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
      elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
      else fail "curl/wget 均缺位"; fi ;;
  esac
}

log "fetching SHA256SUMS.txt + $NAME (v$VERSION)"
fetch "$BASE_DIR/SHA256SUMS.txt" "$DEST/SHA256SUMS.txt"
fetch "$BASE_DIR/$NAME" "$DEST/$NAME"

command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail "无 sha256sum/shasum"
EXPECT="$(grep -E "[[:space:]]$NAME\$" "$DEST/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$EXPECT" ] || fail "SHA256SUMS.txt 中无 $NAME 条目"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$DEST/$NAME" | awk '{print $1}')"
else ACTUAL="$(shasum -a 256 "$DEST/$NAME" | awk '{print $1}')"; fi

if [ "$ACTUAL" = "$EXPECT" ]; then
  log "checksum OK  $ACTUAL"
  chmod +x "$DEST/$NAME"
  log "run: $DEST/$NAME --version"
else
  fail "checksum 不符（expected $EXPECT, got $ACTUAL）——请勿运行该产物"
fi
