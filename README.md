# StandardCode

StandardCode 是一款模型无关、上下文精简、功能透明、生产级的开源 CLI 编程代理工具。

## 安装

### npm（全平台首选）

```bash
npm install -g @standardcode-oss/cli
standardcode --version
```

镜像/证书异常时可显式指向官方源：`npm install -g @standardcode-oss/cli --registry=https://registry.npmjs.org`。

### 独立二进制（免 Node 运行时）

从 [GitHub Releases](https://github.com/admin001-bit/standardcode/releases) 下载对应平台单文件与 `SHA256SUMS.txt`，**先校验再入 PATH**：

```bash
# Linux / macOS
shasum -a 256 -c SHA256SUMS.txt          # 期望三行全 OK
chmod +x standardcode-linux-x64          # macOS 用 standardcode-darwin-arm64
mv standardcode-linux-x64 "$HOME/.local/bin/standardcode"

# Windows（PowerShell）
Get-FileHash .\standardcode-windows-x64.exe -Algorithm SHA256   # 与 SHA256SUMS.txt 逐条比对
```

### Linux 安装脚本

```bash
curl -fsSLO https://raw.githubusercontent.com/admin001-bit/standardcode/main/scripts/install.sh
bash install.sh          # 装到用户目录（零提权）；PATH 写入需显式 "yes"；完整性由 npm registry 承担
```

## 完整性校验（首版不签名）

首版发行**不做代码签名/公证**：Windows SmartScreen 与 macOS Gatekeeper 可能提示"来源未知"，属预期行为。完整性以 **SHA-256** 为通道——所有发行资产随附 `SHA256SUMS.txt`，安装前请按上节校验；npm 通道的完整性由 registry 承担。

## 版本策略

- GA 前版本号为 0.x。
- 对外版本以 npm registry 为单一事实源、按发布递增，**不绑定里程碑编号**（首发 `0.1.0` 于 M5 期发布；M7 收官后的首个 GitHub Release 沿用 `0.1.0`，避免 npm 与 Releases 双源版本分裂）。

## 实验特性（experimental）

Teams / workflow 是**独立实验子项目**（ORC-050）：**发布默认关闭**——未开启时相关斜杠命令不注册、工具面零新增、无任何遥测事件。开启路径（生效序：env 逃逸舱 > settings）：环境变量 `STANDARD_CODE_EXPERIMENTAL=1`，或 settings `experimental.enabled: true`；可用 `experimental.flags` 白名单收窄（已知名 `workflow` / `teams` / `fork`）。实验特性 API/行为可在不发 major 的情况下变更，勿用于生产关键路径。
