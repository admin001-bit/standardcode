// WP-05（M5）：SEC-030 keychain 读面适配器测试（判据自足：链首语义+fail-open 契约）。
import { describe, expect, it } from "vitest";
import { createKeychainAdapter, keychainAccountFor, KEYCHAIN_SERVICE_NAME, type SyncExec } from "../src/keychain.ts";

function ok(stdout: string): SyncExec {
  return () => ({ status: 0, stdout, spawnError: false });
}
function fail(status: number | null, spawnError = false): SyncExec {
  return () => ({ status, stdout: "", spawnError });
}

describe("SEC-030 keychain 适配器（WP-05 清偿）", () => {
  it("darwin security：命中返回去空白值；account/service 参数形制正确", () => {
    let seen: { file: string; args: string[] } | null = null;
    const adapter = createKeychainAdapter("darwin", (file, args) => {
      seen = { file, args };
      return { status: 0, stdout: "  sk-live-abc  \n", spawnError: false };
    });
    expect(adapter.getSecret("api-key:anthropic")).toBe("sk-live-abc");
    expect(seen!.file).toBe("security");
    expect(seen!.args).toContain("-s");
    expect(seen!.args).toContain(KEYCHAIN_SERVICE_NAME);
    expect(seen!.args).toContain("api-key:anthropic");
  });

  it("linux secret-tool：非零退出/空输出/ENOENT（spawnError）/超时（status null）一律 null=fail-open", () => {
    expect(createKeychainAdapter("linux", fail(1)).getSecret("api-key:openai")).toBeNull();
    expect(createKeychainAdapter("linux", ok("")).getSecret("api-key:openai")).toBeNull();
    expect(createKeychainAdapter("linux", fail(null, true)).getSecret("api-key:openai")).toBeNull();
    expect(createKeychainAdapter("linux", ok("   \n")).getSecret("api-key:openai")).toBeNull();
  });

  it("win32/其他：unavailable 恒 null 且零 spawn（缺省 runner 不触盘）", () => {
    const adapter = createKeychainAdapter("win32"); // 缺省 runner=真实 spawnSync；unavailable 路径必须零调用
    expect(adapter.name).toBe("unavailable");
    expect(adapter.getSecret("api-key:anthropic")).toBeNull();
  });

  it("负缓存：同 account 首查缺失后不再重试（适配器实例级，防重复 spawn 开销）", () => {
    let calls = 0;
    const adapter = createKeychainAdapter("linux", () => {
      calls++;
      return { status: 1, stdout: "", spawnError: false };
    });
    expect(adapter.getSecret("api-key:anthropic")).toBeNull();
    expect(adapter.getSecret("api-key:anthropic")).toBeNull();
    expect(calls).toBe(1);
    expect(adapter.getSecret("api-key:openai")).toBeNull(); // 不同 account 独立
    expect(calls).toBe(2);
  });

  it("keychainAccountFor：provider → api-key:<provider> 命名约定", () => {
    expect(keychainAccountFor("anthropic")).toBe("api-key:anthropic");
  });
});
