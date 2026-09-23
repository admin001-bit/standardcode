# winget 通道（Windows，M7 WP-10）

> 通道阶梯依据：v2.8 附录 E 行 630「Windows winget/直接下载（PATH 需确认；签名 Q-7）」；骨架口径 ADR-0044 决策 1（M5 登记占位），本卡（WP-10）落地为**可本地验证的清单**。
> **不外发**：`winget-pkgs` 官方仓 PR = 外发动作，逐项用户明示授权后方可执行（BLK-02=① 口径）。

## 清单三件（`manifests/` 子目录）

| 文件 | ManifestType | 作用 |
|---|---|---|
| `manifests/StandardCode.StandardCode.yaml` | `version` | 版本坐标（identifier/version/locale） |
| `manifests/StandardCode.StandardCode.locale.en-US.yaml` | `defaultLocale` | 展示元数据（发布者/许可/描述） |
| `manifests/StandardCode.StandardCode.installer.yaml` | `installer` | 安装器（`portable`，指向 WP-09 exe） |

> 清单必须在**只含三 YAML 的子目录**内：`winget validate/install --manifest <dir>` 会把目录内每个文件都当
> manifest 解析（V-WP10 R4：同目录放 `README.md` 会报 YAML Scanner 错——已按此布局修复）。

## [自定] 决策

- **PackageIdentifier = `StandardCode.StandardCode`**：现行包名口径为 `@standardcode-oss/cli`（ADR-0044 决策 10 改判）→ 反向域形取品牌词根两段。**首版自用清单，未登记官方仓**（登记=外发）。
- **InstallerType = `portable`**：WP-09 产物为单文件 exe（Bun compile，ADR-0047），无安装器外壳 → portable 直挂，**顶层 `Commands: [standardcode]`** 暴露命令。**不使用 `PortableCommandAlias`**——该字段仅存在于 `NestedInstallerFiles`，顶层使用被 `winget validate` 判 `Unknown field`（V-WP10 R2 实测）。
- **每个 YAML 首行 schema 头以 `.schema.json` 结尾**（如 `…winget-manifest.installer.1.10.0.schema.json`）：缺 `.schema` 尾缀会被 validate 判 "schema header URL does not match the expected pattern"（V-WP10 复核实测；对照官方 winget-pkgs 清单实样）。
- **InstallerSha256 取 `SHA256SUMS.txt` 现值小写原文**：winget schema 的 sha256 模式为 `^[A-Fa-f0-9]{64}$`（大小写皆合法）；此处**刻意保持小写**以与 `apps/cli/dist/bin/SHA256SUMS.txt` **逐字符相等**（WP-10 DoD③ 对质口径，见 `scripts/verify-channel-checksums.mjs`）。
- **URL 形制**：`https://github.com/admin001-bit/standardcode/releases/download/v<ver>/<artifact>`（仓址取自 `scripts/pack-release.mjs` staged manifest 的 `repository.url`；Release 发布本身=外发动作，未执行）。

## 本地验证面（V-WP10 后实测口径）

本机 winget **在位**（`App Installer` 1.29.380.0 Status=Ok；`winget.exe --version`=v1.29.380；注意 `%LOCALAPPDATA%\Microsoft\WindowsApps` 不在 git-bash PATH，**需绝对路径调用**）。

- **`winget validate --manifest packaging\winget\manifests` ＝ 实测通过（0 告警，exit=0）**（2026-09-23）。
- **安装/卸载全链未本地验证**：实测 `winget install --manifest …` 报「此功能需要由管理员启用……`winget settings --enable LocalManifestFiles`」（需管理员启用该设置）＝BLK-12 剩余面。

本机已跑的自洽校验：

```bash
node scripts/verify-channel-checksums.mjs   # DoD③：清单 sha == SHA256SUMS.txt
```

管理员启用 LocalManifestFiles 后的完整验证命令（未执行）：

```powershell
winget settings --enable LocalManifestFiles
winget install --manifest packaging\winget\manifests --accept-package-agreements --accept-source-agreements
standardcode --version
winget uninstall StandardCode.StandardCode
```
