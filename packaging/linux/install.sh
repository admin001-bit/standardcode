#!/usr/bin/env bash
# standardcode 直接二进制安装器 —— Linux（x64）。
# M7 WP-10（附录 E 行 630「Linux 安装脚本/deb|rpm」；通道阶梯 Windows winget/直接下载 → macOS Homebrew → Linux 脚本/deb|rpm）。
# 与既有 npm 通道（scripts/install.sh）**并行且互不影响**：本脚本走"下载单文件二进制"路，不调用 npm、不改 npm 通道脚本语义。
#
# 形制承袭（与 scripts/install.sh 同形，ENG-040 行 431 / §8.4 行 387）：
#   ①平台/前置核查（含架构白名单）②下载产物 + **sha256 校验（fail-closed）**③`--version` 自证
#   ④PATH 缺失时**确认语义**写入（需显式 "yes"）+ 留痕 ~/.standardcode/install-manifest.json
# 零提权：不 sudo、不写系统目录；缺省前缀 = 用户可写 $HOME/.local（附录 E"postinstall 不做提权"同源延伸到脚本面）。
#
# 用法：
#   bash packaging/linux/install.sh [--prefix DIR] [--version X.Y.Z] [--base-url URL]
# 环境覆盖：
#   STANDARDCODE_PREFIX / STANDARDCODE_VERSION / STANDARDCODE_DOWNLOAD_BASE
# 离线/本地验证：--base-url 可指向本地目录或 file:// URL（测试用，见 packaging/linux/README.md）。
set -euo pipefail

CHANNEL="direct-download"
NAME="standardcode"
DEFAULT_VERSION="0.1.1"
DEFAULT_BASE="https://github.com/admin001-bit/standardcode/releases/download"
# WP-09 产物 sha256（apps/cli/dist/bin/SHA256SUMS.txt 中 standardcode-linux-x64 现值；DoD③ 逐字符相等）。
SHA256_LINUX_X64="8587ee035fea3d62a985b3ad96f83ca75213ae50bce1b82914819d5f96693f6d"
ARTIFACT="standardcode-linux-x64"

PREFIX="${STANDARDCODE_PREFIX:-$HOME/.local}"
VERSION="${STANDARDCODE_VERSION:-$DEFAULT_VERSION}"
BASE="${STANDARDCODE_DOWNLOAD_BASE:-$DEFAULT_BASE}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix 需要目录}"; shift 2 ;;
    --version) VERSION="${2:?--version 需要 x.y.z}"; shift 2 ;;
    --base-url) BASE="${2:?--base-url 需要 URL/目录}"; shift 2 ;;
    -h|--help) echo "usage: install.sh [--prefix DIR] [--version X.Y.Z] [--base-url URL]"; exit 0 ;;
    *) echo "[install] 未知参数: $1" >&2; exit 1 ;;
  esac
done
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) echo "[install] FAILED: --version 需为 x.y.z 形（得 '$VERSION'）" >&2; exit 1 ;;
esac

DATA_DIR="$HOME/.standardcode"
MANIFEST="$DATA_DIR/install-manifest.json"
CHANNELS="$DATA_DIR/channels.ndjson"
BIN_DIR="$PREFIX/bin"
BIN_PATH="$BIN_DIR/$NAME"

log() { echo "[install] $*"; }
fail() { echo "[install] FAILED: $*" >&2; echo "[install] action: 修复上述前置后重试（channel=$CHANNEL）" >&2; exit 1; }

# ① 平台/架构核查（只发 linux-x64 产物；其余 fail-closed，不静默取错产物）
[ "$(uname -s)" = "Linux" ] || fail "本脚本仅支持 Linux（uname -s=$(uname -s)）"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) : ;;
  *) fail "无 $ARCH 产物（WP-09 TARGETS 仅 linux-x64；ADR-0047 决策 2）" ;;
esac
command -v mkdir >/dev/null 2>&1 || fail "mkdir 缺位"

URL="$BASE/v$VERSION/$ARTIFACT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DEST="$TMP/$ARTIFACT"

# ② 下载（支持 http(s) 与本地目录/file:// —— 后者供离线本地验证）
log "downloading $URL"
case "$BASE" in
  file://*|/*)
    SRC="${BASE#file://}/v$VERSION/$ARTIFACT"
    [ -f "$SRC" ] || fail "本地源缺位: $SRC"
    cp "$SRC" "$DEST"
    ;;
  *)
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$URL" -o "$DEST" || fail "下载失败（curl）: $URL"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$DEST" "$URL" || fail "下载失败（wget）: $URL"
    else
      fail "curl/wget 均缺位，无法下载"
    fi
    ;;
esac

# ③ sha256 校验（fail-closed：不一致即中止，不安装）
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$DEST" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$DEST" | awk '{print $1}')"
else
  fail "sha256sum/shasum 均缺位，无法校验完整性"
fi
[ "$ACTUAL" = "$SHA256_LINUX_X64" ] || fail "sha256 不符（expected $SHA256_LINUX_X64, got $ACTUAL）——产物可能损坏或被篡改"
log "sha256 OK  $ACTUAL"

# ④ 安装（用户前缀，零提权）
mkdir -p "$BIN_DIR"
install -m 0755 "$DEST" "$BIN_PATH" 2>/dev/null || { cp "$DEST" "$BIN_PATH" && chmod 0755 "$BIN_PATH"; }
log "installed: $BIN_PATH"

# ⑤ 自证
INSTALLED="$("$BIN_PATH" --version)" || fail "安装后 --version 未正常输出"
log "installed version: $INSTALLED"

# ⑥ PATH（缺失时确认后写入+留痕；ENG-040：写 PATH 需 "yes"）——与 scripts/install.sh 同语义
RC_USED="null"   # 未写 rc 时为 JSON null（供 ⑦ 记录）
case ":$PATH:" in
  *":$BIN_DIR:"*) log "PATH already contains $BIN_DIR (skip)" ;;
  *)
    printf "[install] PATH 中不含 %s。写入 shell 配置文件? 需要 'yes'：" "$BIN_DIR"
    ANSWER=""; read -r ANSWER || true
    if [ "$ANSWER" = "yes" ]; then
      RC="$HOME/.bashrc"
      [ -n "${ZSH_VERSION:-}" ] && RC="$HOME/.zshrc"
      [ -f "$HOME/.zshrc" ] && RC="$HOME/.zshrc"
      printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"
      RC_USED="\"$RC\""
      log "PATH entry written to $RC"
      log "run: source $RC  （或重开终端）"
    else
      log "PATH 未写入（按确认语义跳过）；手动执行: export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

# ⑦ 通道留痕：channels.ndjson（**行式 JSON，纯 shell 可读**——卸载方 uninstall.sh 无需 node）。
#    与 M5 的 install-manifest.json 分离：后者是 npm 通道的 PATH 项契约，本通道不覆写其形状。
rc_file_json="$RC_USED"
if [ "$rc_file_json" != "null" ]; then rc_file_json="\"$(printf '%s' "$RC_USED" | tr -d '"')\""; fi
REC="$(printf '{"channel":"%s","version":"%s","prefix":"%s","binPath":"%s","rcFile":%s,"installedAt":"%s"}' \
  "$CHANNEL" "$VERSION" "$PREFIX" "$BIN_PATH" "$rc_file_json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
mkdir -p "$DATA_DIR"
if [ -f "$CHANNELS" ]; then grep -vF "\"binPath\":\"$BIN_PATH\"" "$CHANNELS" > "$CHANNELS.tmp" || true; mv "$CHANNELS.tmp" "$CHANNELS"; fi
printf '%s\n' "$REC" >> "$CHANNELS"
log "channel record appended: $CHANNELS"

# ⑧ install-manifest.json 桥（best-effort：node 在位时同步 M5 契约条目，使 M5 `standardcode uninstall` 亦能还原本通道 PATH 项）
if [ "$RC_USED" != "null" ]; then
  if command -v node >/dev/null 2>&1; then
    RCV="$(printf '%s' "$RC_USED" | tr -d '"')"
    if [ -f "$MANIFEST" ]; then
      node -e '
        const fs=require("fs");
        const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        m.pathEntries=m.pathEntries||[];
        if(!m.pathEntries.some(e=>e&&e.value===process.argv[2]&&e.scope==="posix-rcfile"&&e.file===process.argv[3]))
          m.pathEntries.push({value:process.argv[2],scope:"posix-rcfile",file:process.argv[3]});
        fs.writeFileSync(process.argv[1],JSON.stringify(m,null,2)+"\n");
      ' "$MANIFEST" "$BIN_DIR" "$RCV" || true
    else
      printf '{"pathEntries":[{"value":"%s","scope":"posix-rcfile","file":"%s"}]}\n' "$BIN_DIR" "$RCV" > "$MANIFEST"
    fi
    log "M5 install-manifest.json 桥已同步（node 在位）"
  else
    log "node 缺位：install-manifest.json 桥跳过（PATH 项已记入 $CHANNELS，卸载由 uninstall.sh 覆盖）"
  fi
fi

log "done — 卸载: bash packaging/linux/uninstall.sh --prefix $PREFIX"
