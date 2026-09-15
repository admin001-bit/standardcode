//! 策略层（三层分离第一层，参考报告 §1.1）：**现行双轴（文件系统 × 网络）** 规范模型 + 三档便捷入口
//! （v2.8 §5.3(3) 行 256：档位名 Codex 同名 `read-only` / `workspace-write`（开启默认档）/ `danger-full-access`
//! （显式确认后））+ **legacy 单轴兼容入口**。
//!
//! 设计口径（[自定]，登记供 V 判）：
//! - `Restricted` 档默认**全盘可读**：Codex legacy `has_full_disk_read_access()≡true` 同向（参考报告 §1.2
//!   问题 5——读不作粗粒度维度，读限制只走细粒度 `DenyRead` 打洞）。
//! - 元数据隐式保护名单 `.git`/`.standardcode` 与只读 carveout `.git/hooks` 来自 v2.8 EXE-011 行 427
//!   原文（".git/hooks、.standardcode 等元数据路径默认禁写"）；形制对位 Codex `WritableRoot` 三类约束
//!   （参考报告 §1.2 行 1066-1076 段）。
//! - `tighten` = deny 恒赢的交集合并（接缝③"仲裁层×沙箱层"约束载体）：并集开禁不可能，只允许更严。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::CompileError;

/// 网络轴（fail-closed：默认 `Denied`；`danger-full-access` 与显式 `allow_network` 才开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetPolicy {
    #[default]
    Denied,
    Allowed,
}

/// 文件系统粗档：`Restricted` 逐根列举可写；`Unrestricted` 全盘可写。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FsKind {
    Restricted,
    Unrestricted,
}

/// 细粒度读写 carveout（绝对路径）。`DenyRead` 在 Windows legacy 后端不可表达（编译期拒绝，
/// §5.3(3) 教训清单"Windows deny-read 需 elevated"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    ReadOnly,
    DenyWrite,
    DenyRead,
}

/// 根路径符号链接形态。纯函数层不触盘——shape 由宿主（WP-03）在执行边界注入（[自定] 载体，
/// 同向 Codex"native path 转换推迟到执行边界"，参考报告 §1.3 行 109-112）。
/// 语义对位 Codex `normalize_writable_root_for_sandbox`（参考报告 §1.4 符号链接处理）：
/// 顶层系统别名（如 `/tmp → /private/tmp`）可解析；深层组件链接一律拒绝（沙箱内进程可改动其指向）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathShape {
    Real,
    TopLevelAlias,
    DeepSymlink,
}

/// 参与策略的根：绝对规范化路径 + 链接形态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootPath {
    pub path: PathBuf,
    pub shape: PathShape,
}

impl RootPath {
    pub fn real(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            shape: PathShape::Real,
        }
    }
}

/// 元数据隐式保护（相对每个可写根；deny 恒赢——落名单下的可写根被编译层直接拒绝）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataProtection {
    /// 根下禁创建/禁替换的相对名（EXE-011 行 427 默认名单）
    pub protected_names: Vec<String>,
    /// 根下只读 carveout 相对路径（默认 `.git/hooks`）
    pub read_only_subpaths: Vec<String>,
}

impl Default for MetadataProtection {
    fn default() -> Self {
        Self {
            protected_names: vec![".git".to_string(), ".standardcode".to_string()],
            read_only_subpaths: vec![".git/hooks".to_string()],
        }
    }
}

/// 文件系统轴。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSystemPolicy {
    pub kind: FsKind,
    /// 仅 `Restricted` 有意义；编译时按路径排序确定化。
    pub writable_roots: Vec<RootPath>,
    /// 细粒度全局 carveout（绝对路径）。
    pub carveouts: Vec<(PathBuf, Access)>,
    pub metadata: MetadataProtection,
}

impl Default for FileSystemPolicy {
    fn default() -> Self {
        Self {
            kind: FsKind::Restricted,
            writable_roots: Vec::new(),
            carveouts: Vec::new(),
            metadata: MetadataProtection::default(),
        }
    }
}

/// 现行规范：双轴策略（v2.8 §5.3(3)"Codex 双轴策略模型（文件系统 × 网络）"）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SandboxPolicy {
    pub fs: FileSystemPolicy,
    pub net: NetPolicy,
}

/// legacy 单轴兼容入口（v2.8 §5.3(3)"legacy 单轴兼容入口"）。[自定] 档位取 spec 点名三档
/// （Codex legacy 第四变体 `ExternalSandbox` = WP-02/03 外置包装形态，不在兼容入口）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxPolicy {
    /// `read-only` 档：全盘可读、无处可写、无网络。
    pub fn read_only() -> Self {
        Self::default()
    }

    /// `workspace-write` 档（沙箱开启时默认档，EXE-011 行 427）：根内可写、其余只读、无网络。
    pub fn workspace_write(roots: Vec<RootPath>) -> Self {
        Self {
            fs: FileSystemPolicy {
                writable_roots: roots,
                ..Default::default()
            },
            net: NetPolicy::Denied,
        }
    }

    /// `danger-full-access` 档（显式确认后方可用，行 256；确认义务在宿主层）：全盘可写 + 网络开。
    pub fn danger_full_access() -> Self {
        Self {
            fs: FileSystemPolicy {
                kind: FsKind::Unrestricted,
                ..Default::default()
            },
            net: NetPolicy::Allowed,
        }
    }

    /// 网络轴显式放开（workspace-write + 联网工具场景）。
    pub fn allow_network(mut self) -> Self {
        self.net = NetPolicy::Allowed;
        self
    }

    /// legacy 单轴 → 双轴规范入口。
    pub fn from_legacy(mode: LegacyMode, cwd: RootPath) -> Self {
        match mode {
            LegacyMode::ReadOnly => Self::read_only(),
            LegacyMode::WorkspaceWrite => Self::workspace_write(vec![cwd]),
            LegacyMode::DangerFullAccess => Self::danger_full_access(),
        }
    }

    /// **deny 恒赢**交集合并（形状对位 Codex `intersect_permission_profiles`：网络须双方都允许；
    /// 约束性 deny 条目保留压过 grant——`retain_constraining_deny_entries`，参考报告 §1.2）。
    /// 语义：结果永不宽于任一输入；`Unrestricted ∩ Restricted = Restricted`；可写根取"根中根"且
    /// 不落任一侧 DenyWrite 之下（被压即丢根，不报错——deny 赢）；carveout 并集且同路径取严。
    pub fn tighten(&self, other: &SandboxPolicy) -> Result<SandboxPolicy, CompileError> {
        let kind = if self.fs.kind == FsKind::Unrestricted && other.fs.kind == FsKind::Unrestricted
        {
            FsKind::Unrestricted
        } else {
            FsKind::Restricted
        };
        let mut roots: Vec<RootPath> = Vec::new();
        if kind == FsKind::Restricted {
            for a in &self.fs.writable_roots {
                for b in &other.fs.writable_roots {
                    let inner = if a.path.starts_with(&b.path) {
                        a
                    } else if b.path.starts_with(&a.path) {
                        b
                    } else {
                        continue;
                    };
                    if root_denied(inner, &self.fs) || root_denied(inner, &other.fs) {
                        continue;
                    }
                    roots.push(inner.clone());
                }
            }
        }
        roots.sort_by(|x, y| x.path.cmp(&y.path));
        roots.dedup_by(|x, y| x.path == y.path);
        let net = if self.net == NetPolicy::Allowed && other.net == NetPolicy::Allowed {
            NetPolicy::Allowed
        } else {
            NetPolicy::Denied
        };
        Ok(SandboxPolicy {
            fs: FileSystemPolicy {
                kind,
                writable_roots: roots,
                carveouts: merge_carveouts(&self.fs.carveouts, &other.fs.carveouts),
                metadata: MetadataProtection {
                    protected_names: merge_names(
                        &self.fs.metadata.protected_names,
                        &other.fs.metadata.protected_names,
                    ),
                    read_only_subpaths: merge_names(
                        &self.fs.metadata.read_only_subpaths,
                        &other.fs.metadata.read_only_subpaths,
                    ),
                },
            },
            net,
        })
    }
}

fn root_denied(root: &RootPath, fs: &FileSystemPolicy) -> bool {
    fs.carveouts
        .iter()
        .any(|(p, a)| *a == Access::DenyWrite && root.path.starts_with(p))
}

/// 同路径合并取严：DenyWrite/DenyRead 压过 ReadOnly（deny 恒赢）；双 deny 并存。
fn merge_carveouts(a: &[(PathBuf, Access)], b: &[(PathBuf, Access)]) -> Vec<(PathBuf, Access)> {
    let mut m: BTreeMap<PathBuf, (bool, bool, bool)> = BTreeMap::new();
    for (p, acc) in a.iter().chain(b.iter()) {
        let e = m.entry(p.clone()).or_insert((false, false, false));
        match acc {
            Access::ReadOnly => e.0 = true,
            Access::DenyWrite => e.1 = true,
            Access::DenyRead => e.2 = true,
        }
    }
    let mut out = Vec::new();
    for (p, (ro, dw, dr)) in m {
        if dw {
            out.push((p.clone(), Access::DenyWrite));
        }
        if dr {
            out.push((p.clone(), Access::DenyRead));
        }
        if !dw && !dr && ro {
            out.push((p, Access::ReadOnly));
        }
    }
    out
}

fn merge_names(a: &[String], b: &[String]) -> Vec<String> {
    let mut all: Vec<String> = a.iter().chain(b.iter()).cloned().collect();
    all.sort();
    all.dedup();
    all
}

/// 执行层子进程句柄（真实载体 = WP-02；本层仅需类型存在以固定 trait 签名）。
#[derive(Debug)]
pub struct SandboxedChild {
    pub pid: u32,
}

/// v2.8 §5.3(3) 行 258-264 A 稿恢复接口（三方法签名逐一对位；错误类型本卡以
/// `CompileError` 占位，WP-02 扩运行时执行错误——[自定] 登记）。
pub trait SandboxBackend {
    fn spawn(
        &self,
        req: &crate::exec::ExecRequest,
        policy: &SandboxPolicy,
    ) -> Result<SandboxedChild, CompileError>;
    fn apply_policy(&self, policy: &SandboxPolicy) -> Result<(), CompileError>;
    fn teardown(&self, child: SandboxedChild) -> Result<(), CompileError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(p: &str) -> RootPath {
        RootPath::real(PathBuf::from(p))
    }

    fn policy_with(p: &str) -> SandboxPolicy {
        SandboxPolicy::workspace_write(vec![root(p)])
    }

    #[test]
    fn three_tiers_shapes() {
        let ro = SandboxPolicy::read_only();
        assert_eq!(ro.fs.kind, FsKind::Restricted);
        assert!(ro.fs.writable_roots.is_empty());
        assert_eq!(ro.net, NetPolicy::Denied);

        let ww = policy_with("/w");
        assert_eq!(ww.fs.writable_roots.len(), 1);
        assert_eq!(ww.net, NetPolicy::Denied);
        // 默认元数据保护名单在位（EXE-011 行 427）
        assert!(ww.fs.metadata.protected_names.contains(&".git".to_string()));
        assert!(ww
            .fs
            .metadata
            .protected_names
            .contains(&".standardcode".to_string()));
        assert!(ww
            .fs
            .metadata
            .read_only_subpaths
            .contains(&".git/hooks".to_string()));

        let dfa = SandboxPolicy::danger_full_access();
        assert_eq!(dfa.fs.kind, FsKind::Unrestricted);
        assert_eq!(dfa.net, NetPolicy::Allowed);
    }

    #[test]
    fn legacy_entry_maps_to_three_tiers() {
        assert_eq!(
            SandboxPolicy::from_legacy(LegacyMode::ReadOnly, root("/w")),
            SandboxPolicy::read_only()
        );
        assert_eq!(
            SandboxPolicy::from_legacy(LegacyMode::WorkspaceWrite, root("/w")),
            policy_with("/w")
        );
        assert_eq!(
            SandboxPolicy::from_legacy(LegacyMode::DangerFullAccess, root("/w")),
            SandboxPolicy::danger_full_access()
        );
    }

    #[test]
    fn tighten_network_requires_both_allow() {
        let a = policy_with("/w").allow_network();
        let b = policy_with("/w");
        assert_eq!(a.tighten(&b).unwrap().net, NetPolicy::Denied);
        assert_eq!(
            a.clone().tighten(&a.clone()).unwrap().net,
            NetPolicy::Allowed
        );
    }

    #[test]
    fn tighten_keeps_inner_root() {
        let outer = policy_with("/w");
        let inner = policy_with("/w/sub");
        let t = outer.tighten(&inner).unwrap();
        assert_eq!(t.fs.writable_roots, vec![root("/w/sub")]);
    }

    #[test]
    fn tighten_deny_wins_drops_root() {
        // deny 恒赢：另一侧对 /w/sub 下 DenyWrite → 该根被压掉，不报错不放宽
        let a = policy_with("/w/sub");
        let mut b = policy_with("/w");
        b.fs.carveouts = vec![(PathBuf::from("/w/sub"), Access::DenyWrite)];
        let t = a.tighten(&b).unwrap();
        assert!(t.fs.writable_roots.is_empty());
        assert_eq!(
            t.fs.carveouts,
            vec![(PathBuf::from("/w/sub"), Access::DenyWrite)]
        );
    }

    #[test]
    fn tighten_carveout_merge_strictest_wins() {
        let mut a = policy_with("/w");
        a.fs.carveouts = vec![(PathBuf::from("/w/x"), Access::ReadOnly)];
        let mut b = policy_with("/w");
        b.fs.carveouts = vec![(PathBuf::from("/w/x"), Access::DenyWrite)];
        let t = a.tighten(&b).unwrap();
        assert_eq!(
            t.fs.carveouts,
            vec![(PathBuf::from("/w/x"), Access::DenyWrite)]
        );
    }

    #[test]
    fn tighten_disjoint_roots_become_empty() {
        let t = policy_with("/a").tighten(&policy_with("/b")).unwrap();
        assert!(t.fs.writable_roots.is_empty());
        // 结果仍不宽于任一输入：无根 = read-only 形态（tighten 只收紧语义自洽）
    }
}
