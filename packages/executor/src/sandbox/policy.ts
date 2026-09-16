// 沙箱策略 wire 生产者（Rust SandboxPolicy serde 形的 TS 镜像——字段名/枚举值逐一对位：
// struct 字段不重命名（snake_case 原样）+ enum kebab-case（policy.rs #[serde(rename_all)]）。
// 三档名与 v2.8 §5.3(3) 行 256 Codex 同名；元数据默认名单=EXE-011 行 427 原文，与 Rust
// MetadataProtection::default 同形——双端 golden 内联同串，漂移即测抓（[自定] 形制登记）。

export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

export const SANDBOX_TIERS: readonly SandboxTier[] = ["read-only", "workspace-write", "danger-full-access"];

export type NetPolicy = "denied" | "allowed";
export type FsKind = "restricted" | "unrestricted";
export type Access = "read-only" | "deny-write" | "deny-read";

export interface WireRootPath {
  path: string;
  /** 宿主执行边界注入（compile.rs PathShape）：M5 首版宿主只申报 real；顶层别名/深链
   * 甄别=沙箱层校验（DeepSymlink 直接拒），[自定] 登记。 */
  shape: "real" | "top-level-alias" | "deep-symlink";
}

export interface WireMetadataProtection {
  protected_names: string[];
  read_only_subpaths: string[];
}

export interface WireFileSystemPolicy {
  kind: FsKind;
  writable_roots: WireRootPath[];
  carveouts: [string, Access][];
  metadata: WireMetadataProtection;
}

export interface WireSandboxPolicy {
  fs: WireFileSystemPolicy;
  net: NetPolicy;
}

/** EXE-011 行 427 默认元数据保护名单（与 Rust MetadataProtection::default() 同形）。 */
export const DEFAULT_METADATA_PROTECTION: WireMetadataProtection = {
  protected_names: [".git", ".standardcode"],
  read_only_subpaths: [".git/hooks"],
};

/** 三档 wire 策略（v2.8 §5.3(3)：workspace-write=开启默认档；danger-full-access 显式确认后，
 * 确认义务在装配层 DoD③）。workspace-write 根=会话工作区。 */
export function policyFor(tier: SandboxTier, workspaceRoot: string): WireSandboxPolicy {
  switch (tier) {
    case "read-only":
      return {
        fs: { kind: "restricted", writable_roots: [], carveouts: [], metadata: DEFAULT_METADATA_PROTECTION },
        net: "denied",
      };
    case "workspace-write":
      return {
        fs: {
          kind: "restricted",
          writable_roots: [{ path: workspaceRoot, shape: "real" }],
          carveouts: [],
          metadata: DEFAULT_METADATA_PROTECTION,
        },
        net: "denied",
      };
    case "danger-full-access":
      return {
        fs: { kind: "unrestricted", writable_roots: [], carveouts: [], metadata: DEFAULT_METADATA_PROTECTION },
        net: "allowed",
      };
  }
}
