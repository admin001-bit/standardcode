// WP-03（M4）：S-3 批准状态机+docs 级门控纯函数（卡 DoD①②④；[CC] XPt `_440.js:153552-153560`/ZPt :153561-153568/
// nxt 未批准不进合并 :154575-154589/Z1e 回落 :154480-154492 形状对位）。
import { describe, expect, it } from "vitest";
import { gateMcpServerDocs, loadMcpServerConfigs, resolveServerApproval } from "../src/index.ts";

describe("批准状态机（DoD②：reject 名单 > enableAllProjectMcpServers > 工作区信任已确认 → approved）", () => {
  const base = { origin: "projectShared" as const, trusted: false };

  it("无记录无信任无 enableAll = pending（S-3 安装即确认：默认不生效）", () => {
    expect(resolveServerApproval(base)).toBe("pending");
  });

  it("reject 名单恒赢：decision=rejected 压过 enableAll 与信任（:153553 形状）", () => {
    expect(resolveServerApproval({ ...base, record: { decision: "rejected" }, enableAllProjectMcpServers: true, trusted: true })).toBe("rejected");
  });

  it("用户停用恒赢：disabled=true 压过一切（[自定] 正交键位，fail-closed 方向）", () => {
    expect(resolveServerApproval({ ...base, record: { disabled: true, decision: "approved" }, enableAllProjectMcpServers: true, trusted: true })).toBe("disabled");
  });

  it("逐 server 批准信任无关：untrusted + decision=approved = approved（[CC] DQn :153540-153551 分支先于信任）", () => {
    expect(resolveServerApproval({ ...base, record: { decision: "approved" } })).toBe("approved");
  });

  it("enableAllProjectMcpServers=true 批准（信任无关，:153556-153557 || 形状）", () => {
    expect(resolveServerApproval({ ...base, enableAllProjectMcpServers: true })).toBe("approved");
    expect(resolveServerApproval({ origin: "user", record: undefined, trusted: false, enableAllProjectMcpServers: true })).toBe("approved");
  });

  it("工作区信任已确认 → projectShared server approved（ZPt :153561-153568 形状）", () => {
    expect(resolveServerApproval({ ...base, trusted: true })).toBe("approved");
  });

  it("非 projectShared 来源无 S-3 门（Z1e :154488 local 直胜形状；user/projectLocal/flag/managed）", () => {
    for (const origin of ["user", "projectLocal", "flag", "managed"] as const) {
      expect(resolveServerApproval({ origin, trusted: false })).toBe("approved");
    }
  });
});

describe("docs 级门控（DoD①：项目级 server 默认 pending 不进合并结果）", () => {
  it("projectShared pending/rejected/disabled 条目剔除；低来源同名定义自然回落（Z1e 形状）", () => {
    const docs = {
      user: { mcpServers: { gh: { type: "stdio", command: "user-gh" } } },
      projectShared: { mcpServers: { gh: { type: "stdio", command: "proj-gh" }, lin: { type: "http", url: "https://lin.dev" }, off: { type: "stdio", command: "off" } } },
    };
    const gate = gateMcpServerDocs({
      docs,
      trusted: false,
      records: { off: { decision: "rejected" } },
    });
    // gh: projectShared pending → 剔除 → user 定义回落（不消失）
    const loaded = loadMcpServerConfigs(gate.docs, {});
    expect(loaded.servers.map((s) => `${s.name}@${s.origin}`)).toEqual(["gh@user"]);
    // lin 独立 pending → 整体不进
    expect(gate.docs.projectShared?.mcpServers).toEqual({});
    expect(gate.dropped.map((d) => `${d.name}:${d.state}`).sort()).toEqual(["gh:pending", "lin:pending", "off:rejected"]);
    expect(gate.states.find((s) => s.name === "gh" && s.origin === "projectShared")?.state).toBe("pending");
  });

  it("trusted + reject 名单 → 仍剔除（reject 恒赢，DoD② 链序第一）", () => {
    const gate = gateMcpServerDocs({
      docs: { projectShared: { mcpServers: { x: { type: "stdio", command: "c" } } } },
      trusted: true,
      records: { x: { decision: "rejected" } },
    });
    expect(gate.dropped).toEqual([{ name: "x", origin: "projectShared", state: "rejected" }]);
    expect(loadMcpServerConfigs(gate.docs, {}).servers).toHaveLength(0);
  });

  it("rejected/disabled 名单对任意来源生效（[自定]；user 层被 disable 后不进合并）", () => {
    const gate = gateMcpServerDocs({
      docs: { user: { mcpServers: { a: { type: "stdio", command: "a" }, b: { type: "stdio", command: "b" } } } },
      trusted: true,
      records: { b: { disabled: true } },
    });
    expect(gate.dropped).toEqual([{ name: "b", origin: "user", state: "disabled" }]);
    expect(loadMcpServerConfigs(gate.docs, {}).servers.map((s) => s.name)).toEqual(["a"]);
  });

  it("坏条目（非对象）原样保留给 loader 报告警；mcpServers 缺席/非对象层不动", () => {
    const docs = {
      user: { mcpServers: { bad: "not-an-object" } },
      flag: { mcpServers: "garbage" },
    };
    const gate = gateMcpServerDocs({ docs, trusted: false, records: {} });
    expect(gate.states).toEqual([]);
    expect(gate.dropped).toEqual([]);
    expect(gate.docs.user?.mcpServers).toEqual({ bad: "not-an-object" });
    expect(gate.docs.flag?.mcpServers).toBe("garbage");
    const loaded = loadMcpServerConfigs(gate.docs, {});
    expect(loaded.servers).toHaveLength(0);
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it("DoD④：同名多来源（projectShared pending 不遮 user）+ projectShared approved 胜出+抑制告警不改名", () => {
    const raw = {
      user: { mcpServers: { dup: { type: "stdio", command: "u" } } },
      projectShared: { mcpServers: { dup: { type: "stdio", command: "p" } } },
    };
    // 形状一：pending 项目定义不遮蔽 user 定义（回落不消失）
    const g1 = gateMcpServerDocs({ docs: raw, trusted: false, records: {} });
    expect(loadMcpServerConfigs(g1.docs, {}).servers).toEqual([{ name: "dup", origin: "user", config: { type: "stdio", command: "u" } }]);
    // 形状二：projectShared approved → 高来源胜+同名抑制告警（tQo/x0l 形状：不改名；异配置重定义文案）
    const g2 = gateMcpServerDocs({ docs: raw, trusted: true, records: {} });
    const r2 = loadMcpServerConfigs(g2.docs, {});
    expect(r2.servers).toEqual([{ name: "dup", origin: "projectShared", config: { type: "stdio", command: "p" } }]);
    expect(r2.warnings.some((w) => w.server === "dup" && w.reason.includes("redefined by higher source"))).toBe(true);
    expect(r2.warnings.some((w) => w.reason.includes("not renamed"))).toBe(true);
  });
});
