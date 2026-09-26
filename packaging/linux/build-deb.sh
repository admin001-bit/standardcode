#!/usr/bin/env bash
# standardcode .deb 构建器 —— **纯 shell（ar + tar），零外部打包依赖**（不引 fpm/debhelper）。
# M7 WP-10（附录 E 行 630「Linux 安装脚本/deb|rpm」）。
# 依据卡内指引：优先 ar＋tar 手工装包（WSL 实测 ar/xz/tar 在位=路由确定，见 .work/wp10-wsl-probe.sh）。
# 零提权构建（tar --owner=0 --group=0 --numeric-owner 免 root/fakeroot）；产物校验用 dpkg-deb（若有）。
#
# 用法：bash packaging/linux/build-deb.sh [--binary FILE] [--version X.Y.Z] [--out-dir DIR] [--arch amd64]
set -euo pipefail

NAME="standardcode"
CHANNEL="deb"
DEFAULT_VERSION="0.1.1"
SHA256_LINUX_X64="8587ee035fea3d62a985b3ad96f83ca75213ae50bce1b82914819d5f96693f6d"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BINARY="$ROOT/apps/cli/dist/bin/standardcode-linux-x64"
VERSION="$DEFAULT_VERSION"
ARCH="amd64"
OUT_DIR="$ROOT/apps/cli/dist/packages"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BINARY="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --arch) ARCH="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    -h|--help) echo "usage: build-deb.sh [--binary FILE] [--version X.Y.Z] [--arch amd64] [--out-dir DIR]"; exit 0 ;;
    *) echo "[build-deb] 未知参数: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[build-deb] $*"; }
fail() { echo "[build-deb] FAILED: $*" >&2; exit 1; }

for t in ar tar gzip md5sum; do command -v "$t" >/dev/null 2>&1 || fail "缺工具: $t（ar/tar 为核心打包依赖）"; done
[ -f "$BINARY" ] || fail "产物缺位: $BINARY（先跑 node scripts/build-binaries.mjs --targets linux-x64）"

# 完整性前置：输入产物 sha256 必须与 SHA256SUMS.txt 现值一致（fail-closed）
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$BINARY" | awk '{print $1}')"
  [ "$ACTUAL" = "$SHA256_LINUX_X64" ] || fail "输入产物 sha256 不符（expected $SHA256_LINUX_X64, got $ACTUAL）"
  log "输入产物 sha256 OK  $ACTUAL"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/root"
mkdir -p "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/doc/$NAME"

cp "$BINARY" "$STAGE/usr/bin/$NAME"
chmod 0755 "$STAGE/usr/bin/$NAME"

cat > "$STAGE/usr/share/doc/$NAME/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: StandardCode
Source: https://github.com/admin001-bit/standardcode

Files: *
Copyright: StandardCode OSS contributors
License: Apache-2.0
 Licensed under the Apache License, Version 2.0 (the "License"); you may not use
 this file except in compliance with the License. A copy of the License ships with
 the upstream source at the repository root (LICENSE).
EOF

cat > "$STAGE/usr/share/doc/$NAME/README.md" <<EOF
# standardcode $VERSION (deb, $ARCH)

Single-file binary (Bun compile; ADR-0047). Installed to \`/usr/bin/$NAME\`.
Integrity: upstream \`SHA256SUMS.txt\` (checksum channel; ADR-0044 决策 4). Not signed (Q-7).
EOF

SIZE_KB="$(du -sk "$STAGE/usr" | awk '{print $1}')"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $NAME
Version: $VERSION
Architecture: $ARCH
Maintainer: StandardCode OSS <maintainers@standardcode.invalid>
Installed-Size: $SIZE_KB
Section: utils
Priority: optional
Homepage: https://github.com/admin001-bit/standardcode
Description: Open-source CLI coding agent (generic multi-protocol providers)
 StandardCode is a terminal coding agent with a generic multi-protocol provider
 layer, sandboxed tool execution and a slash-command driven surface.
 Distributed as a single-file binary (Bun compile; ADR-0047); no installer
 lifecycle scripts and no privilege escalation on install.
EOF

# md5sums（dpkg 元数据；路径不含前导斜杠）
( cd "$STAGE" && find . -type f ! -path './DEBIAN/*' -printf '%P\n' | sort | while IFS= read -r f; do
    printf '%s  %s\n' "$(md5sum "$f" | awk '{print $1}')" "$f"
  done ) > "$STAGE/DEBIAN/md5sums"

# 组装三成员（顺序固定：debian-binary / control.tar.gz / data.tar.gz）
# 注意：control.tar.gz 内容为 DEBIAN/ **目录内**文件（成员 ./control、./md5sums），非 DEBIAN/ 目录本身——
# 否则 dpkg-deb 报 "no 'control' file in control archive"（本卡实测过的坑）。
cd "$WORK"
printf '2.0\n' > debian-binary
tar --owner=0 --group=0 --numeric-owner -C "$STAGE/DEBIAN" -czf "$WORK/control.tar.gz" .
tar --owner=0 --group=0 --numeric-owner -C "$STAGE" -czf "$WORK/data.tar.gz" ./usr

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/${NAME}_${VERSION}_${ARCH}.deb"
rm -f "$DEB"
ar rc "$DEB" debian-binary control.tar.gz data.tar.gz
[ -f "$DEB" ] || fail "ar 未产出 $DEB"

if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb -I "$DEB" >/dev/null || fail "dpkg-deb -I 元数据读取失败"
  dpkg-deb -c "$DEB" >/dev/null || fail "dpkg-deb -c 内容列表读取失败"
  log "dpkg-deb 元数据/内容校验 OK"
  # 载荷硬断言（fail-closed）：解包后 usr/bin/standardcode 的 sha256 必须 == 输入产物 sha256
  EX="$(mktemp -d)"; dpkg-deb -x "$DEB" "$EX" || { rm -rf "$EX"; fail "dpkg-deb -x 解包失败"; }
  if command -v sha256sum >/dev/null 2>&1; then
    PACKED="$(sha256sum "$EX/usr/bin/standardcode" | awk '{print $1}')"
    rm -rf "$EX"
    [ "$PACKED" = "$SHA256_LINUX_X64" ] || fail "载荷摘要不符：包内 bin=$PACKED 期望=$SHA256_LINUX_X64"
    log "载荷摘要断言 OK  包内 /usr/bin/standardcode == 输入产物 sha256"
  else
    rm -rf "$EX"
  fi
fi

log "built: $DEB"
if command -v sha256sum >/dev/null 2>&1; then log "deb sha256: $(sha256sum "$DEB" | awk '{print $1}')"; fi
