# 平台通道包（M7 WP-10）

> 四通道分发包/清单：**Windows winget + 直接下载 → macOS Homebrew → Linux 安装脚本/deb|rpm**。
> 规格依据：v2.8 附录 E 行 630；骨架口径 ADR-0044 决策 1（M5 登记占位）；本卡落地为可本地验证的清单/脚本。
> **不外发**：一切对外发布动作（winget-pkgs/homebrew-core PR、`gh release create/upload`、COPR/OBS/PPA、npm publish）
> = 外发动作，承 BLK-02=① 口径，**逐项用户明示授权后方可执行**——本目录只做包/清单/脚本与本地验证。

## 目录

| 通道 | 目录 | 交付物 | 本地验证 |
|---|---|---|---|
| Windows winget | `winget/` | 三 YAML 清单（version/locale/installer，`InstallerType: portable`） | **未本地验证**（本机 winget 缺位）→ BLK-12 |
| macOS Homebrew | `homebrew/` | `standardcode.rb`（formula） | **未本地验证**（无 macOS/brew/ruby）→ BLK-12 |
| Linux | `linux/` | `install.sh` / `uninstall.sh` / `build-deb.sh` / `build-rpm.sh` + `standardcode.spec` | **WSL2 实跑**（脚本全链 + deb 真装真卸 + rpm 真装真卸） |
| 直接下载 | `direct-download/` | `verify.sh` / `verify.ps1` + README（资产清单与校验值） | **Windows 本机实跑**（exe `--version` + checksum verify） |

## 与既有 npm 通道的关系

**零触碰**：`scripts/{install.sh,install.ps1,cleanup.sh,cleanup.ps1,pack-release.mjs}` 与 `apps/cli/package.json`
的发布面语义**未改动**（WP-10 DoD④；见 `M7-1-results.md §WP-10` 的 `git diff --name-status` 记录）。
本目录为**并行**的独立通道：`linux/install.sh` 走"下载单文件二进制"路，不调用 npm。
唯一共享点=**契约兼容**：本通道留痕 `~/.standardcode/channels.ndjson`（行式 JSON，纯 shell 可读，卸载器不需要 node）；
`install-manifest.json` 的 `pathEntries` 形状（`{value, scope:"posix-rcfile", file}`）**不在本通道覆写**，
仅在 node 在位时 best-effort 同步同款条目，使 M5 `standardcode uninstall` 的 PATH 还原面亦覆盖本通道写入项。

## 校验

```bash
node scripts/verify-channel-checksums.mjs
```

断言：四通道清单/脚本中引用的 sha256 与 WP-09 `apps/cli/dist/bin/SHA256SUMS.txt` **逐条相等**（DoD③），
且 `PackageVersion`/URL `vX.Y.Z`/formula `version`/`DEFAULT_VERSION` 与 `apps/cli/package.json` 同源。

## 未本地验证面（如实登记，见 BLK-12）

| 通道 | 未验证面 | 原因 | 可选验证环境 |
|---|---|---|---|
| winget | `winget install --manifest` → `--version` → `winget uninstall` 全链 | 本机 winget/App Installer 缺位 | 装有 App Installer 的 Windows 机 / CI windows runner |
| Homebrew | `ruby -c` 语法检查 + `brew install/uninstall` 全链 | 本机与 WSL 均无 ruby/brew；无 macOS | macOS 机 / CI macos runner |
| rpm | （已用用户态 rpmbuild + `unshare -r` 实跑；若判等价性不足则登记） | 系统级 `rpm`/`rpmbuild` 缺位、sudo 需密码 | 装有 rpm/rpm-build 的 Linux 机 / CI ubuntu runner |

签名/公证维持 **Q-7 首版不做**（ADR-0044 决策 2）；SHA-256 checksum 为唯一完整性通道。
