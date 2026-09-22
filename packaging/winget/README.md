# winget 通道（Windows，M7 WP-10）

> 通道阶梯依据：v2.8 附录 E 行 630「Windows winget/直接下载（PATH 需确认；签名 Q-7）」；骨架口径 ADR-0044 决策 1（M5 登记占位），本卡（WP-10）落地为**可本地验证的清单**。
> **不外发**：`winget-pkgs` 官方仓 PR = 外发动作，逐项用户明示授权后方可执行（BLK-02=① 口径）。

## 清单三件

| 文件 | ManifestType | 作用 |
|---|---|---|
| `StandardCode.StandardCode.yaml` | `version` | 版本坐标（identifier/version/locale） |
| `StandardCode.StandardCode.locale.en-US.yaml` | `defaultLocale` | 展示元数据（发布者/许可/描述） |
| `StandardCode.StandardCode.installer.yaml` | `installer` | 安装器（`portable`，指向 WP-09 exe） |

## [自定] 决策

- **PackageIdentifier = `StandardCode.StandardCode`**：现行包名口径为 `@standardcode-oss/cli`（ADR-0044 决策 10 改判）→ 反向域形取品牌词根两段。**首版自用清单，未登记官方仓**（登记=外发）。
- **InstallerType = `portable`**：WP-09 产物为单文件 exe（Bun compile，ADR-0047），无安装器外壳 → portable 直挂，`Commands: [standardcode]` + `PortableCommandAlias: standardcode`。
- **InstallerSha256 取 `SHA256SUMS.txt` 现值小写原文**：winget schema 的 sha256 模式为 `^[A-Fa-f0-9]{64}$`（大小写皆合法）；此处**刻意保持小写**以与 `apps/cli/dist/bin/SHA256SUMS.txt` **逐字符相等**（WP-10 DoD③ 对质口径，见 `scripts/verify-channel-checksums.mjs`）。
- **URL 形制**：`https://github.com/admin001-bit/standardcode/releases/download/v<ver>/<artifact>`（仓址取自 `scripts/pack-release.mjs` staged manifest 的 `repository.url`；Release 发布本身=外发动作，未执行）。

## 本地验证面（如实登记）

本机 winget **缺位**（`.work/wp10-tools.txt`：`winget: MISSING`、App Installer 未装）⇒ `winget install --manifest packaging/winget` 全链**未在本机实跑**。
本卡对该通道只做到**静态自洽**：三 YAML 可解析 + `InstallerSha256` 与 WP-09 产物逐字符相等（DoD③）。
**未本地验证面 = winget 安装/卸载全链**（登记 BLK-12；可选验证环境=装有 App Installer 的 Windows 机或 CI windows runner）。

本机可跑的自洽校验：

```bash
node scripts/verify-channel-checksums.mjs   # DoD③：清单 sha == SHA256SUMS.txt
```

授权环境下的完整验证命令（未执行）：

```powershell
winget install --manifest packaging\winget --accept-package-agreements --accept-source-agreements
standardcode --version
winget uninstall StandardCode.StandardCode
```
