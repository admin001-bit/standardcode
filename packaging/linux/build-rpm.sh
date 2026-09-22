#!/usr/bin/env bash
# standardcode .rpm 构建器（rpmbuild 驱动）。M7 WP-10（附录 E 行 630）。
# 零提权构建（--define "_topdir $WORK" 全部落在临时目录；不写 ~/rpmbuild、不需 root）。
#
# rpmbuild 缺位时的处理：本脚本 fail 并以**明确指引**报出（不静默）——
#   常规环境：sudo apt-get install rpm / sudo dnf install rpm-build
#   无 sudo 的用户态取用（本卡 WSL 验证用）：见 packaging/linux/README.md「rpm 工具链用户态取用」。
#
# 用法：bash packaging/linux/build-rpm.sh [--binary FILE] [--version X.Y.Z] [--out-dir DIR]
set -euo pipefail

NAME="standardcode"
DEFAULT_VERSION="0.1.0"
SHA256_LINUX_X64="4fbbded38a6a3408fea1b785430dd6d89e2c2c0113eeac216a55d5aae0619a7b"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BINARY="$ROOT/apps/cli/dist/bin/standardcode-linux-x64"
VERSION="$DEFAULT_VERSION"
OUT_DIR="$ROOT/apps/cli/dist/packages"
RPMBUILD="${RPMBUILD:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BINARY="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    -h|--help) echo "usage: build-rpm.sh [--binary FILE] [--version X.Y.Z] [--out-dir DIR]"; exit 0 ;;
    *) echo "[build-rpm] 未知参数: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[build-rpm] $*"; }
fail() { echo "[build-rpm] FAILED: $*" >&2; exit 1; }

if [ -z "$RPMBUILD" ]; then RPMBUILD="$(command -v rpmbuild || true)"; fi
if [ -z "$RPMBUILD" ]; then
  fail "rpmbuild 缺位——安装: sudo apt-get install rpm（Debian/Ubuntu）或 sudo dnf install rpm-build（Fedora）；
        无 sudo 用户态取用见 packaging/linux/README.md。本通道在缺位环境=未本地验证面（BLK-12）。"
fi
[ -x "$RPMBUILD" ] || fail "rpmbuild 不可执行: $RPMBUILD"
[ -f "$BINARY" ] || fail "产物缺位: $BINARY（先跑 node scripts/build-binaries.mjs --targets linux-x64）"
for t in tar gzip; do command -v "$t" >/dev/null 2>&1 || fail "缺工具: $t"; done

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$BINARY" | awk '{print $1}')"
  [ "$ACTUAL" = "$SHA256_LINUX_X64" ] || fail "输入产物 sha256 不符（expected $SHA256_LINUX_X64, got $ACTUAL）"
  log "输入产物 sha256 OK  $ACTUAL"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp "$BINARY" "$WORK/SOURCES/standardcode-linux-x64"
cp "$ROOT/packaging/linux/standardcode.spec" "$WORK/SPECS/standardcode.spec"
cat > "$WORK/SOURCES/standardcode.README.md" <<EOF
# standardcode $VERSION (rpm)

Single-file binary (Bun compile; ADR-0047). Installed to /usr/bin/$NAME.
Integrity: upstream SHA256SUMS.txt (checksum channel; ADR-0044 决策 4). Not signed (Q-7).
EOF

log "rpmbuild: $RPMBUILD ($("$RPMBUILD" --version 2>/dev/null || echo '?'))"
"$RPMBUILD" -bb --nodeps \
  --define "_topdir $WORK" \
  --define "version $VERSION" \
  --define "release 1" \
  "$WORK/SPECS/standardcode.spec" || fail "rpmbuild 失败"

PRODUCED="$(find "$WORK/RPMS" -name '*.rpm' -type f | head -1)"
[ -n "$PRODUCED" ] || fail "rpmbuild 未产出 rpm"

mkdir -p "$OUT_DIR"
RPM="$OUT_DIR/$(basename "$PRODUCED")"
cp "$PRODUCED" "$RPM"

if command -v rpm >/dev/null 2>&1; then
  rpm -qp --queryformat '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' "$RPM" 2>/dev/null || true
  rpm -qpl "$RPM" 2>/dev/null || true
  # 载荷硬断言（fail-closed）：包内 /usr/bin/standardcode 的摘要必须 == 输入产物 sha256。
  # 判别力来源：默认 brp-strip 会 strip Bun 单文件载荷致摘要改变（.work/wp10-rpm-verify.log 实测）。
  STORED="$(rpm -qp --qf '[%{FILENAMES} %{FILEDIGESTS}\n]' "$RPM" 2>/dev/null | awk '$1=="/usr/bin/standardcode"{print $2}')"
  if [ -z "$STORED" ]; then
    log "WARN: rpm 未返回 FILEDIGESTS（跳过载荷断言；建议人工复核）"
  elif [ "$STORED" != "$SHA256_LINUX_X64" ]; then
    fail "载荷摘要不符：包内 bin=$STORED 期望=$SHA256_LINUX_X64（E 例：brp-strip 破坏了单文件载荷）"
  else
    log "载荷摘要断言 OK  包内 /usr/bin/standardcode == 输入产物 sha256"
  fi
fi

log "built: $RPM"
if command -v sha256sum >/dev/null 2>&1; then log "rpm sha256: $(sha256sum "$RPM" | awk '{print $1}')"; fi
