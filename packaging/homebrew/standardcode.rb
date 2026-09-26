# WP-10（M7）Homebrew formula（macOS）。
# 依据：附录 E 行 630「macOS Homebrew（公证随 Q-7）」；骨架口径 ADR-0044 决策 1。
# 首版不签名/不公证（Q-7 维持）——formula 说明面如实声明，见 packaging/homebrew/README.md。
# 外发口径：自建 tap（admin001-bit/homebrew-tap）= 外发动作，逐项用户明示；homebrew-core/官方 cask 不可行（core=source-only 政策＋知名度阈值；2026-09-27 调研见 .work/homebrew-path-report.md）。
#
# [自定] 决策：
#   - url/sha256 指向 WP-09 的 darwin-arm64 单文件产物（无 x64 产物 → depends_on arch: :arm64）。
#   - sha256 = apps/cli/dist/bin/SHA256SUMS.txt 中 standardcode-darwin-arm64 现值（DoD③ 逐字符相等）。
#   - install 走 bin.install 改名（产物文件名 -> `standardcode`），零外部依赖、零生命周期脚本。
class Standardcode < Formula
  desc "Open-source CLI coding agent (generic multi-protocol providers)"
  homepage "https://github.com/admin001-bit/standardcode"
  url "https://github.com/admin001-bit/standardcode/releases/download/v0.1.1/standardcode-darwin-arm64"
  sha256 "f41f865f225c745f1e7bf8a23d045e184b42157f214548512ae032f58780af83"
  license "Apache-2.0"

  # WP-09 仅产 darwin-arm64（TARGETS；ADR-0047 决策 2）：x64 模板未产 → arch 硬约束。
  # 2026-09-27（brew audit 合规）：不写显式 version（由 URL tag 段 `v0.1.1` 推导，audit 判冗余）；depends_on 序 arch 在前。
  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "standardcode-darwin-arm64" => "standardcode"
  end

  test do
    assert_match "standardcode #{version}", shell_output("#{bin}/standardcode --version").strip
  end
end
