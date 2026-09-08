// WP-07（M2）规则清洗三件+addAllow 测试（dig-02 §2.1/§2.2 锚点；判据自足：板 WP-07 DoD④+边界）。
import { describe, expect, it } from "vitest";
import { createPermissionBroker, parseRuleset } from "../src/permission-broker/index.ts";
import { NETWORK_COMMANDS, isRootedSpecifier, matchesSegmentShape, sanitizeAllowSpecifier, unwrapCommandHead } from "../src/permission-broker/sanitize.ts";

describe("DoD④ 规则清洗三件（allow 侧）", () => {
  it("① rooted/home 锚定拒绝：盘符/绝对路径/家目录/上跳段", () => {
    expect(isRootedSpecifier("C:\\Users\\x")).toBe(true);
    expect(isRootedSpecifier("/etc/passwd")).toBe(true);
    expect(isRootedSpecifier("~/.ssh/id_rsa")).toBe(true);
    expect(isRootedSpecifier("~other/x")).toBe(true);
    expect(isRootedSpecifier("src/../secrets")).toBe(true);
    expect(isRootedSpecifier("src/**")).toBe(false); // 项目相对路径合法
    expect(isRootedSpecifier("./scripts/build.sh")).toBe(false);
    // parseRuleset 抛错面
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Edit(C:\\Windows\\x)"] }, "allow")).toThrow(/rooted/);
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Read(~/.ssh/**)"] }, "allow")).toThrow(/rooted/);
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Write(/etc/hosts)"] }, "allow")).toThrow(/rooted/);
  });

  it("② 网络命令白名单（65 项实测）：pi 首词 allow 的参数段过 mi；非 mi 形状拒绝", () => {
    expect(NETWORK_COMMANDS.size).toBe(65); // 完整枚举纪律：实测 chunk-4svxqcrq 美化版 :675-748
    expect(sanitizeAllowSpecifier("Bash", "curl *").ok).toBe(true); // [CC] Bash(curl *) 先例形态
    expect(sanitizeAllowSpecifier("Bash", "ssh -p 2222 host").ok).toBe(true); // flag+参数段过 mi
    expect(sanitizeAllowSpecifier("Bash", "sudo curl *").ok).toBe(true); // 包装器穿透找网络命令
    expect(sanitizeAllowSpecifier("Bash", "curl http://x;y").ok).toBe(false); // 非法形状（; 不在 mi）
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Bash(curl http://x;y)"] }, "allow")).toThrow(/segment shape/);
    // 非 pi 首词不受网络白名单约束（由裸通配/其余清洗管）
    expect(sanitizeAllowSpecifier("Bash", "git status --short").ok).toBe(true);
  });

  it("③ 段式形状校验（mi）：路径类 specifier 逐段过 mi；非法字符拒绝", () => {
    expect(matchesSegmentShape("src/**")).toBe(true);
    expect(matchesSegmentShape("src/*.test.ts")).toBe(true);
    expect(matchesSegmentShape('src/"x"')).toBe(false);
    expect(() => parseRuleset({ deny: [], ask: [], allow: ['Edit(src/"x")'] }, "allow")).toThrow(/segment shape/);
    expect(() => parseRuleset({ deny: [], ask: [], allow: ["Edit(src/**)"] }, "allow")).not.toThrow();
    // deny/ask 侧不受 allow 清洗约束（[CC] 通配/形状限制均为 allow 侧收紧）
    expect(() => parseRuleset({ deny: ["Edit(C:\\Windows\\x)"], ask: [], allow: [] }, "deny")).not.toThrow();
  });

  it("unwrapCommandHead：包装器前缀穿透（gn 集合 30 项）", () => {
    expect(unwrapCommandHead(["sudo", "env", "curl"])).toBe("curl");
    expect(unwrapCommandHead(["curl"])).toBe("curl");
    expect(unwrapCommandHead([])).toBeNull();
  });
});

describe("WP-07 addAllow（总是允许运行时追加）", () => {
  it("追加规则即时生效；违规规则抛错拒绝", () => {
    const broker = createPermissionBroker({ mode: "default" });
    expect(broker.evaluate("Bash", { command: "git push origin main" }).decision).toBe("ask"); // default 模式
    broker.addAllow("Bash(git push *)");
    expect(broker.evaluate("Bash", { command: "git push origin main" }).decision).toBe("allow");
    expect(() => broker.addAllow("Bash(*)")).toThrow(/wildcard not supported/);
    expect(() => broker.addAllow("Edit(C:\\x)")).toThrow(/rooted/);
    // deny 恒赢：addAllow 不能解锁 deny 规则（B-13）
    const b2 = createPermissionBroker({ rules: { deny: ["Bash(rm -rf *)"] } });
    b2.addAllow("Bash(rm -rf *)");
    expect(b2.evaluate("Bash", { command: "rm -rf /tmp/x" }).decision).toBe("deny");
  });
});
