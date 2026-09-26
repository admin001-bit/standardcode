# WP-10（M7）RPM spec —— 单文件二进制打包（附录 E 行 630「Linux 安装脚本/deb|rpm」）。
# Source0 = 预构建产物（Bun compile，ADR-0047）；无 %prep/%build 步骤（不做编译）。
# AutoReqProv: no —— 免自动依赖生成器对单文件产物的扫描（首版不引构建期依赖）。
#
# **[必守] 下方全局设置禁用 brp 后处理链（brp-strip/brp-compress/…）。
#   实测（.work/wp10-rpm-verify.log）：默认链的 `brp-strip` 会 **strip 掉 Bun 单文件产物的内嵌载荷**——
#   产物大小 81860064→81857320、sha256 变、运行 `--version` 退回 bun 运行时版本 `1.4.2`（而非 `standardcode 0.1.0`）。
#   故 rpm 打包必须整体跳过 brp-strip；build-rpm.sh 另加打包后载荷摘要硬断言（FILEDIGESTS == 产物 sha256）。
#   V-WP10 复核后按窄口径收窄（2026-09-23）：`%global __brp_strip %{nil}` 只关 brp-strip、保留 brp-compress 等其余
#   后处理——已在本机重跑 build-rpm.sh，载荷摘要硬断言仍 PASS（若后续发行版宏布局变化导致失败，回退全局口径并登记）。
Name:           standardcode
Version:        0.1.1
Release:        1%{?dist}
Summary:        Open-source CLI coding agent (generic multi-protocol providers)

License:        Apache-2.0
URL:            https://github.com/admin001-bit/standardcode
BuildArch:      x86_64
AutoReqProv:    no
Source0:        standardcode-linux-x64
Source1:        standardcode.README.md
%global debug_package %{nil}
%global __brp_strip %{nil}

%description
StandardCode is a terminal coding agent with a generic multi-protocol provider
layer, sandboxed tool execution and a slash-command driven surface.
Distributed as a single-file binary (Bun compile; ADR-0047); no installer
lifecycle scripts and no privilege escalation on install.

%prep
# 无源码解包：Source0/Source1 即预构建产物与文档。

%build
# 无构建步骤：产物已由 `node scripts/build-binaries.mjs` 编译。

%install
install -D -m 0755 %{SOURCE0} %{buildroot}%{_bindir}/standardcode
install -D -m 0644 %{SOURCE1} %{buildroot}%{_datadir}/doc/standardcode/README.md

%files
%{_bindir}/standardcode
%dir %{_datadir}/doc/standardcode
%{_datadir}/doc/standardcode/README.md

%changelog
* Sun Sep 27 2026 StandardCode OSS <maintainers@standardcode.invalid> - 0.1.1-1
- Version bump to 0.1.1 (M8 fixes): rebuilt single-file binary; checksum channel, not signed (Q-7).
* Wed Sep 23 2026 StandardCode OSS <maintainers@standardcode.invalid> - 0.1.0-1
- Initial package (M7 WP-10): single-file binary, checksum channel, not signed (Q-7).
