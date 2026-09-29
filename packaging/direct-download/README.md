# 直接下载通道（Windows/macOS/Linux，M7 WP-10）

> 依据：附录 E 行 630「Windows winget/**直接下载**（PATH 需确认；签名 Q-7）」；骨架口径 ADR-0044 决策 1。
> **不外发**：把产物上传到 GitHub Releases（`gh release create/upload`）或任何托管 = 外发动作，逐项用户明示。

## 交付物

| 文件 | 作用 |
|---|---|
| `verify.sh` | POSIX 校验器：下载产物 + `SHA256SUMS.txt` → sha256 核验 → 运行提示 |
| `verify.ps1` | Windows 校验器（`Get-FileHash -Algorithm SHA256`），ASCII-only（PS5.1 无 BOM 解析） |
| `README.md` | 本文件：资产清单、校验值、验证记录 |

## 资产清单与校验值

发布资产基址：`https://github.com/admin001-bit/standardcode/releases/download/v0.1.3/`
（`SHA256SUMS.txt` 随资产同发，**值取自 WP-09 产物** `apps/cli/dist/bin/SHA256SUMS.txt`；DoD③ 逐字符相等）

| 资产 | 平台 | SHA-256 |
|---|---|---|
| `standardcode-windows-x64.exe` | Windows x64 | `4be5a45a1d60517f403a9257b140db25c27cc4ae35d4e80ac916e4afa5864c33` |
| `standardcode-linux-x64` | Linux x64 | `253ff722ac7ad47932217b41521146f2c9adb627f3ad9193850afb6e143fffc0` |
| `standardcode-darwin-arm64` | macOS arm64 | `8b2a368fdc0e5ac0e9ea1f4f8f56c576222b78ad100757423bf3905fca2fcd30` |

**未签名**（Q-7 维持，ADR-0044 决策 2）：SHA-256 为唯一完整性通道；macOS/Windows 首次运行可能有系统安全提示，属预期。

## 用法

```bash
# POSIX
bash verify.sh                     # 自动按 uname 选资产
bash verify.sh --artifact standardcode-darwin-arm64 --dest /tmp/sc
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File verify.ps1
powershell -ExecutionPolicy Bypass -File verify.ps1 -Artifact standardcode-windows-x64.exe -Dest C:\tmp\sc
```

## 本机验证记录（Windows 侧实跑）

见 `M7-1-results.md §WP-10`：`SHA256SUMS.txt` 逐条核验 + `standardcode-windows-x64.exe --version`（原始输出尾部在结果页）。
Linux 侧由 WSL2 实跑（`packaging/linux/install.sh` 走同源 sha256 校验路）。
