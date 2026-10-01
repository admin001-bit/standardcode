// 批 9 静态守卫（全仓审查 2026-10-01）：S8-9 install.sh rc 选择、S8-10 rpm spec/构建脚本——
// shell/spec 无本机可跑链（rpmbuild 缺席），以源文本钉缺陷面回归；checksum S8-8 行为面在
// wp07-release-cli.test.ts 真跑，rust 侧 S8-4 在 crates/sandbox serve tests 真跑。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname ?? ".", "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("S8-9 install.sh rc 选择（bash 主用不再被 .zshrc 存在性推翻）", () => {
  const src = read("packaging/linux/install.sh");
  it("保留运行中 shell 判定（ZSH_VERSION 条件）", () => {
    expect(src).toContain('[ -n "${ZSH_VERSION:-}" ] && RC="$HOME/.zshrc"');
  });
  it("缺陷行零命中：`[ -f ~/.zshrc ] && RC=` 无条件覆盖（原第三行）", () => {
    expect(src).not.toMatch(/\[ -f "\$HOME\/\.zshrc" \] && RC=/);
  });
  it("channels ndjson rcFile 记录消费同一 RC_USED（选择失真连带面仍单源）", () => {
    expect(src).toContain('RC_USED="\\"$RC\\""');
  });
});

describe("S8-10 rpm 版本宏消费与构建校验", () => {
  const spec = read("packaging/linux/standardcode.spec");
  const build = read("packaging/linux/build-rpm.sh");
  it("spec Version 消费宏（原字面量 0.1.x 无条件重设，--define version 被覆盖）", () => {
    expect(spec).toMatch(/^Version:\s*%\{version\}$/m);
    expect(spec).not.toMatch(/^Version:\s+0\.\d+\.\d+$/m); // 字面量版本零残留
  });
  it("build-rpm 恒传 --define version 且带产出文件名版本硬断言（原只打印不校验）", () => {
    expect(build).toContain('--define "version $VERSION"');
    expect(build).toContain('fail "rpm 版本矛盾'); // S8-10 断言在位（大小写形）
  });
});
