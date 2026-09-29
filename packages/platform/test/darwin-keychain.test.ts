// macOS 实机面（2026-09-30 轮次11）：keychain 适配器真 `security` 往返。
// 既有 keychain.test.ts 全为注入 mock（SyncExec 造假），真 security 命令面
// （packages/platform/src/keychain.ts:67-74 darwin 分支）从未实跑——残留面「macOS 实机」
// 的 keychain 子面。仅 darwin 执行（CI macos gate 真跑），其它平台 skip。
// 形制：写入 → getSecret 读回 → 缺失 account 回 null → 删除 → 复读 null。
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createKeychainAdapter, KEYCHAIN_SERVICE_NAME, keychainAccountFor } from "../src/keychain.ts";

const ACCOUNT = keychainAccountFor("darwin-real-roundtrip");
const MISSING = keychainAccountFor("darwin-real-absent");
const VALUE = "sk-darwin-real-roundtrip-fixture";

const sec = (...args: string[]) => spawnSync("security", args, { encoding: "utf8", timeout: 3000 });

afterAll(() => {
  sec("delete-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-a", ACCOUNT);
});

describe.runIf(process.platform === "darwin")("darwin 真机：keychain security 往返", () => {
  it("add → getSecret 读回原值；缺失 account 回 null（fail-open 契约）", () => {
    const add = sec("add-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-a", ACCOUNT, "-w", VALUE, "-U");
    expect(add.status, `add-generic-password 失败 status=${add.status} stderr=${String(add.stderr)}`).toBe(0);
    const adapter = createKeychainAdapter();
    expect(adapter.name).toBe("security");
    expect(adapter.getSecret(ACCOUNT)).toBe(VALUE);
    expect(adapter.getSecret(MISSING)).toBeNull();
  }, 10_000);

  it("删除后同 account 复读回 null（键面真删；命中不入负缓存故不污染）", () => {
    const del = sec("delete-generic-password", "-s", KEYCHAIN_SERVICE_NAME, "-a", ACCOUNT);
    expect(del.status, `delete-generic-password 失败 status=${del.status}`).toBe(0);
    expect(createKeychainAdapter().getSecret(ACCOUNT)).toBeNull();
  }, 10_000);
});
