# Homebrew 通道（macOS，M7 WP-10）

> 依据：附录 E 行 630「macOS Homebrew（公证随 Q-7）」；骨架口径 ADR-0044 决策 1。
> **不外发**：向 `homebrew-core` 或任何公开 tap 提 PR = 外发动作，逐项用户明示授权后方可执行（BLK-02=① 口径）。

## 交付物

`standardcode.rb` — formula（`url`/`sha256` 指向 WP-09 `standardcode-darwin-arm64` 产物）。

## 公开通道（2026-09-27 上线）

- tap 仓＝<https://github.com/admin001-bit/homebrew-tap>（其 `Formula/standardcode.rb` 与本目录 formula 逐字节同步，已由回读核验）。
- 用户安装＝`brew install admin001-bit/tap/standardcode`（**完全限定名＝自动仅信任该 formula**）；按短名安装须先 `brew trust --formula admin001-bit/tap/standardcode`——Homebrew ≥6.0 非官方 tap 默认不受信任（官方 `docs/Tap-Trust.md`）。
- **发版同步义务**：每次 Release 更新后须同步 tap 仓 formula 的 `url`/`sha256`（本目录＝单源，tap 仓＝副本）。

## [自定] 决策

- **`depends_on :macos` + `depends_on arch: :arm64`**：WP-09 `TARGETS` 仅三目标、darwin 仅 arm64（ADR-0047 决策 2）→ 无 x64/Intel 产物，formula 显式约束而非静默取错产物。
- **`bin.install "<产物名>" => "standardcode"`**：Release 资产名带平台后缀，安装名统一为命令名 `standardcode`。
- **`version` 不显式声明**（2026-09-27 改，原判"须显式"经 `brew audit` 证伪）：文件名虽无版本，但 URL 的 tag 段（`.../download/v0.1.1/...`）可被 brew 推导——audit 实测判显式声明「redundant with version scanned from URL」⇒ 已删除显式 version；`scripts/verify-channel-checksums.mjs` 的版本抽取同步改为按 URL tag 段。
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
