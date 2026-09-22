# Linux 通道（安装脚本 + deb|rpm，M7 WP-10）

> 依据：附录 E 行 630「Linux 安装脚本/deb|rpm」；骨架口径 ADR-0044 决策 1。
> **不外发**：把 deb/rpm 推入任何公开仓（COPR/OBS/PPA）或 `gh release upload` = 外发动作，逐项用户明示。

## 交付物

| 文件 | 作用 |
|---|---|
| `install.sh` | 直接下载二进制安装器（用户前缀、零提权、sha256 fail-closed、PATH 确认语义） |
| `uninstall.sh` | 对称卸载器（bin + PATH 项还原 + 残留断言） |
| `build-deb.sh` | `.deb` 构建（**纯 shell：ar + tar**，零外部打包依赖） |
| `build-rpm.sh` + `standardcode.spec` | `.rpm` 构建（rpmbuild 驱动，零提权、`_topdir` 落临时目录） |

## [自定] 决策

- **零提权**：`install.sh` 装到 `$HOME/.local/bin`（可 `--prefix` 覆写），不 sudo、不写系统目录——承 ADR-0044 决策 6「零提权语义延伸到脚本面」。
- **sha256 钉值 fail-closed**：三件脚本内嵌 `SHA256_LINUX_X64`（= WP-09 `SHA256SUMS.txt` 现值，DoD③ 逐字符相等），下载后/打包前校验，不符即中止（不安装、不出包）。
- **PATH 确认语义与既有 npm 通道同形**（ENG-040 行 431 / §8.4 行 387）：缺 PATH 时**需显式 `yes`** 才写入 `~/.bashrc`/`~/.zshrc`，并留痕 `~/.standardcode/install-manifest.json`（**沿用 M5 的 `pathEntries` 契约形状**，使 M5 `standardcode uninstall` 的 PATH 还原面天然兼容）。
- **通道留痕分离**：本通道的安装清单落 `~/.standardcode/channels.ndjson`（**行式 JSON，纯 shell 可读**，故 `uninstall.sh` 不需要 node）；`install-manifest.json`（M5 PATH 项契约）**形状不动**，仅在 node 在位时 best-effort 同步同款条目（使 M5 `standardcode uninstall` 亦能还原本通道 PATH 项）。
- **deb 构建=纯 shell**：卡内指引优先 `ar＋tar`（WSL 实测 `ar/xz/tar` 在位，`.work/wp10-wsl-probe.sh`）→ 不引入 fpm/debhelper；`tar --owner=0 --group=0 --numeric-owner` 免 root/fakeroot；元数据/内容用 `dpkg-deb -I/-c` 复核。
- **rpm 构建=spec 落库 + rpmbuild 驱动**：spec 具名落地便于评审；`AutoReqProv: no`（免自动依赖生成器）；`debug_package %{nil}`。

## 本地验证（WSL2 Ubuntu 26.04 实跑）

```bash
# 直接下载通道全链（离线：--base-url 指向本地目录）
bash packaging/linux/install.sh --prefix "$TMP/prefix" --base-url file:///path/to/dist/bin
"$TMP/prefix/bin/standardcode" --version
bash packaging/linux/uninstall.sh --prefix "$TMP/prefix"

# deb 构建 + 真实包管理器安装/卸载（unshare -r 取 fake-root，--root 隔离）
bash packaging/linux/build-deb.sh --out-dir "$TMP/pkgs"
unshare -r dpkg --root="$TMP/root" --instdir="$TMP/root" --admindir="$TMP/root/var/lib/dpkg" -i "$TMP/pkgs/standardcode_0.1.0_amd64.deb"
```

实跑证据与原始输出见 `M7-1-results.md §WP-10` 与产品仓 `.work/wp10-*.log`。

## rpm 工具链用户态取用（无 sudo 环境，本卡 WSL 验证用）

```bash
# 纯用户态取 rpm/rpmbuild（不 sudo）：apt-get download + dpkg-deb -x 到本地前缀
PKGS=$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks \
       --no-replaces --no-enhances rpm | grep -E '^[a-zA-Z0-9]' | sed 's/.*: //' | sort -u)
mkdir -p ~/wp10-rpm-tools/{debs,root} && cd ~/wp10-rpm-tools/debs
apt-get download $PKGS && for d in *.deb; do dpkg-deb -x "$d" ~/wp10-rpm-tools/root; done
export RPM_CONFIGDIR="$HOME/wp10-rpm-tools/root/usr/lib/rpm"
export LD_LIBRARY_PATH="$HOME/wp10-rpm-tools/root/usr/lib/x86_64-linux-gnu:$HOME/wp10-rpm-tools/root/lib/x86_64-linux-gnu"
export RPMBUILD="$HOME/wp10-rpm-tools/root/usr/bin/rpmbuild"
bash packaging/linux/build-rpm.sh
```

## 未本地验证面（如实登记）

- **rpm 的"系统级安装/卸载"**：`rpm -i` 到隔离 root 需 rpm 工具链（见上）；本卡在 WSL 内以用户态取用 + `unshare -r` 实跑（详见结果页），**若判为等价性不足则登记为未本地验证面（BLK-12）**。
- **apt/dnf 真源安装**（`.deb` 经 apt、`.rpm` 经 dnf）：需发布到仓库（外发动作）⇒ 不在本卡。
