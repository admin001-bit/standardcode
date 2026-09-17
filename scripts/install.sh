#!/usr/bin/env bash
# standardcode installer — macOS / Linux（Windows 用 scripts/install.ps1）。
# ADR-0044 决策 6（[自定]；附录 E 行 630 机制主干）：npm 通道、零提权（无 sudo；npm 全局目录=用户可写语义）。
# 流程：环境前置核查（node>=18+npm）→ npm i -g @standardcode/cli@latest → standardcode --version 自证
#       → PATH 缺失时确认后写入并留痕 ~/.standardcode/install-manifest.json（ENG-040 行 431：PATH 写入需 "yes"）。
# 用法：bash scripts/install.sh [@version]（缺省 @latest）
set -euo pipefail

PKG="@standardcode/cli"
VERSION_ARG="${1:-@latest}"
NODE_MIN_MAJOR=18
HOME_DIR="${HOME:?}"
DATA_DIR="$HOME_DIR/.standardcode"
MANIFEST="$DATA_DIR/install-manifest.json"

log() { echo "[install] $*"; }
fail() { echo "[install] FAILED: $*" >&2; echo "[install] action: 修复上述前置后重试，或手动执行 npm i -g $PKG@latest" >&2; exit 1; }

# ① 环境前置
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] || fail "node >= $NODE_MIN_MAJOR required (found $(node -v))"
command -v npm >/dev/null 2>&1 || fail "npm not found on PATH"

# ② 安装（npm 全局；零提权）
log "installing $PKG$VERSION_ARG (npm global, no privilege escalation)…"
npm i -g "$PKG$VERSION_ARG" || fail "npm install failed"

# ③ 自证
command -v standardcode >/dev/null 2>&1 || fail "standardcode not on PATH after install（npm 全局 bin 目录可能不在 PATH，见下方 PATH 步）"
INSTALLED="$(standardcode --version)"
log "installed: $INSTALLED"

# ④ PATH（缺失时确认后写入+留痕；ENG-040：写 PATH 需 "yes"）
NPM_BIN="$(npm prefix -g)/bin"
case ":$PATH:" in
  *":$NPM_BIN:"*) log "PATH already contains $NPM_BIN (skip)" ;;
  *)
    printf "[install] PATH 中不含 npm 全局 bin（%s）。写入 shell 配置文件? 需要 'yes'：" "$NPM_BIN"
    read -r ANSWER
    if [ "$ANSWER" = "yes" ]; then
      RC="$HOME_DIR/.bashrc"
      [ -n "${ZSH_VERSION:-}" ] && RC="$HOME_DIR/.zshrc"
      [ -f "$HOME_DIR/.zshrc" ] && RC="$HOME_DIR/.zshrc"
      printf '\nexport PATH="%s:$PATH"\n' "$NPM_BIN" >> "$RC"
      mkdir -p "$DATA_DIR"
      if [ -f "$MANIFEST" ]; then
        node -e '
          const fs = require("fs");
          const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          m.pathEntries = m.pathEntries || [];
          m.pathEntries.push({ value: process.argv[2], scope: "posix-rcfile", file: process.argv[3] });
          fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
        ' "$MANIFEST" "$NPM_BIN" "$RC"
      else
        printf '{"pathEntries":[{"value":"%s","scope":"posix-rcfile","file":"%s"}]}\n' "$NPM_BIN" "$RC" > "$MANIFEST"
      fi
      log "PATH entry written to $RC (recorded in $MANIFEST)"
      log "run: source $RC  （或重开终端）"
    else
      log "PATH 未写入（按确认语义跳过）；手动执行: export PATH=\"$NPM_BIN:\$PATH\""
    fi
    ;;
esac

# ⑤ checksum 提示（SEC-040：完整性通道；发布产物 SHA256SUMS.txt 随 tarball）
log "done — 完整性校验: node scripts/checksum.mjs verify apps/cli/dist（发布产物随附 SHA256SUMS.txt）"
