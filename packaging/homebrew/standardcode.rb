# WP-10（M7）Homebrew formula（macOS）。
# 依据：附录 E 行 630「macOS Homebrew（公证随 Q-7）」；骨架口径 ADR-0044 决策 1。
# 首版不签名/不公证（Q-7 维持）——formula 说明面如实声明，见 packaging/homebrew/README.md。
# 不外发：homebrew-core / 自建 tap 的对外发布 = 外发动作，逐项用户明示。
#
# [自定] 决策：
#   - url/sha256 指向 WP-09 的 darwin-arm64 单文件产物（无 x64 产物 → depends_on arch: :arm64）。
#   - sha256 = apps/cli/dist/bin/SHA256SUMS.txt 中 standardcode-darwin-arm64 现值（DoD③ 逐字符相等）。
#   - install 走 bin.install 改名（产物文件名 -> `standardcode`），零外部依赖、零生命周期脚本。
class Standardcode < Formula
  desc "Open-source CLI coding agent (generic multi-protocol providers)"
  homepage "https://github.com/admin001-bit/standardcode"
  url "https://github.com/admin001-bit/standardcode/releases/download/v0.1.0/standardcode-darwin-arm64"
  sha256 "4b3b83ccd0541bab7100ad7cf2503663d9206cd64c474f70592e97167d43905e"
  version "0.1.0"
  license "Apache-2.0"

  # WP-09 仅产 darwin-arm64（TARGETS；ADR-0047 决策 2）：x64 模板未产 → arch 硬约束。
  depends_on :macos
  depends_on arch: :arm64

  def install
    bin.install "standardcode-darwin-arm64" => "standardcode"
  end

  test do
    assert_match "standardcode #{version}", shell_output("#{bin}/standardcode --version").strip
  end
end
