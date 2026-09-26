# Homebrew 通道（macOS，M7 WP-10）

> 依据：附录 E 行 630「macOS Homebrew（公证随 Q-7）」；骨架口径 ADR-0044 决策 1。
> **不外发**：向 `homebrew-core` 或任何公开 tap 提 PR = 外发动作，逐项用户明示授权后方可执行（BLK-02=① 口径）。

## 交付物

`standardcode.rb` — formula（`url`/`sha256` 指向 WP-09 `standardcode-darwin-arm64` 产物）。

## [自定] 决策

- **`depends_on :macos` + `depends_on arch: :arm64`**：WP-09 `TARGETS` 仅三目标、darwin 仅 arm64（ADR-0047 决策 2）→ 无 x64/Intel 产物，formula 显式约束而非静默取错产物。
- **`bin.install "<产物名>" => "standardcode"`**：Release 资产名带平台后缀，安装名统一为命令名 `standardcode`。
- **`version` 显式声明**：资产 URL 内无版本段（文件名不含版本）⇒ 不可从 URL 推导，须显式。
- **签名/公证**：首版不做（Q-7 维持，ADR-0044 决策 2）——`sha256` 为完整性通道；README 如实声明未签名，macOS Gatekeeper 首次运行需用户手动放行。
- **`test do` 断言**：`standardcode <version>`，与 WP-09 版本门口径同源。

## 本地验证面（如实登记）

本机与 WSL **均无 `ruby`**（`.work/wp10-wsl-probe.sh`：`ruby: MISSING`）⇒ `ruby -c standardcode.rb` **未执行**，`brew audit` / `brew install` 更无从跑起。
本卡对该通道只做到**静态自洽**：formula 文本与 `SHA256SUMS.txt` 逐字符相等（DoD③，由 `scripts/verify-channel-checksums.mjs` 断言）。
**未本地验证面 = formula 语法检查（ruby -c）、brew 安装/卸载全链**（登记 BLK-12；可选验证环境=macOS 机或 CI macos runner + Homebrew）。**2026-09-27 更新**：CI 载体已落地＝`.github/workflows/homebrew-verify.yml`（workflow_dispatch；macos-latest arm64），实跑结果见该 workflow 的运行记录。

验证命令（**2026-09-27 更新**：新版 Homebrew 拒绝 tap 外的本地 formula——`brew install ./standardcode.rb` 报 "Homebrew requires formulae to be in a tap"；原 `--build-from-source ./standardcode.rb` 写法失效。验证与真实用户路径统一走 tap 形态）：

```bash
brew tap-new --no-git admin001-bit/tap
cp standardcode.rb "$(brew --repository admin001-bit/tap)/Formula/standardcode.rb"
brew install admin001-bit/tap/standardcode
standardcode --version
brew uninstall standardcode
```
