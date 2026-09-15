//! 编译层（三层分离第二层，参考报告 §1.1/§1.3）：**纯函数** 命令+策略→argv
//! （v2.8 §5.3(3) 行 266"策略编译层纯函数（命令+策略→argv）可单测"——范本 Codex
//! `seatbelt_tests.rs` 的快照形制）。真生效（挂载/令牌/profile 装载）= WP-02；本层只产生形状。
//!
//! 确定性：根与 carveout 按路径排序、SBPL 参数按节顺序编号、路径显示经 [`path_text`] 归一
//! （输入分隔符混用在给定 platform 下产生唯一输出）——同一输入两次编译逐字节一致，可入快照。
//!
//! fail-closed：任何校验失败返回 Err（绝不回退未沙箱 argv，error.rs 模块注）。
//! danger-full-access 档 = 直通伪装形（SandboxType::None；"显式确认"义务在宿主层 WP-03，编译器不判定确认来源——[自定]）。

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::CompileError;
use crate::exec::{ExecRequest, PolicyFacts};
use crate::policy::{Access, FsKind, NetPolicy, PathShape, RootPath, SandboxPolicy};

/// 落盘/跨进程策略 JSON 的 schema 版本（ENG-080 行 504：所有落盘契约带 schemaVersion）。
pub const POLICY_SCHEMA_VERSION: u32 = 1;

/// 目标平台（编译入口显式传入——三平台快照在同一 host 上可全部执行、跨主机确定；生产取 [`Platform::host`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOS,
    Linux,
}

impl Platform {
    pub fn host() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOS
        } else {
            Platform::Linux
        }
    }
}

/// 编译选定的后端类型（语义对位 Codex `get_platform_sandbox`，参考报告 §1.3；
/// `None` = 双轴全开放直通形）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxType {
    None,
    LinuxBubblewrap,
    MacosSeatbelt,
    WindowsRestrictedToken,
}

/// 编译产物（快照测逐字段断言）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledCommand {
    pub sandbox: SandboxType,
    /// 最终 argv（含沙箱包装前缀；尾部 = program+args 原序透传）。
    pub argv: Vec<String>,
    /// 仅 macOS：完整 SBPL profile 文本。路径**不内联**入 profile，只经 -D 参数传值
    /// （SBPL 语法注入防护，参考报告 §1.4 参数化机制）。
    pub profile_text: Option<String>,
    /// 仅 macOS：-D 参数 (名, 值)，与 profile 内 `(param "名")` 引用同序。
    pub params: Vec<(String, String)>,
    /// 仅 Windows：canonical 策略 JSON（helper exe 运行时解释——"沙箱伪装成普通命令"形，
    /// 参考报告 §1.3 Windows 特殊路径）。
    pub policy_json: Option<String>,
}

/// 策略+命令 → 沙箱化 argv（纯函数主入口）。
pub fn compile(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
    platform: Platform,
) -> Result<CompiledCommand, CompileError> {
    validate_request(req)?;

    // 1. 确定化 + 输入校验
    let mut roots: Vec<&RootPath> = policy.fs.writable_roots.iter().collect();
    roots.sort_by(|a, b| a.path.cmp(&b.path));
    for r in &roots {
        validate_path(&r.path)?;
        if r.shape == PathShape::DeepSymlink {
            return Err(CompileError::SymlinkRejected {
                path: r.path.clone(),
            });
        }
    }
    let mut carveouts = policy.fs.carveouts.clone();
    carveouts.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| acc_rank(a.1).cmp(&acc_rank(b.1)))
    });
    for (p, _) in &carveouts {
        validate_path(p)?;
    }

    let restricted = policy.fs.kind == FsKind::Restricted;
    let net_allow = policy.net == NetPolicy::Allowed;
    let passthrough = CompiledCommand {
        sandbox: SandboxType::None,
        argv: tail(req, platform),
        profile_text: None,
        params: Vec::new(),
        policy_json: None,
    };
    if !restricted && net_allow {
        return Ok(passthrough); // danger-full-access 双轴全开=直通形
    }

    // 2. Windows deny-read 能力闸（§5.3(3) 教训清单"deny-read 需 elevated"；legacy 后端 fail-closed）
    if platform == Platform::Windows && !facts.elevated {
        if let Some((p, _)) = carveouts.iter().find(|(_, a)| *a == Access::DenyRead) {
            return Err(CompileError::DenyReadRequiresElevation(p.clone()));
        }
    }

    // 3. 元数据隐式保护展开（相对名→各根绝对路径；deny 恒赢=落名单下的根直接拒绝）
    let mut meta_create_deny: BTreeSet<PathBuf> = BTreeSet::new();
    let mut meta_read_only: BTreeSet<PathBuf> = BTreeSet::new();
    for r in &roots {
        for name in &policy.fs.metadata.protected_names {
            meta_create_deny.insert(join_rel(&r.path, name)?);
        }
        for rel in &policy.fs.metadata.read_only_subpaths {
            meta_read_only.insert(join_rel(&r.path, rel)?);
        }
    }
    for r in &roots {
        // 根自身即受保护名（把 .git/.standardcode 整个设为可写根）→ 拒绝：deny 恒赢。
        // 展开名单只产 root/名，根末段命中不会被自身展开捕获，故单独查末段组件。
        if let Some(last) = r
            .path
            .components()
            .next_back()
            .and_then(|c| c.as_os_str().to_str())
        {
            if policy.fs.metadata.protected_names.iter().any(|n| n == last) {
                return Err(CompileError::RootUnderProtection {
                    root: r.path.clone(),
                    protected: r.path.clone(),
                });
            }
        }
        for d in &meta_create_deny {
            if r.path.starts_with(d) {
                return Err(CompileError::RootUnderProtection {
                    root: r.path.clone(),
                    protected: d.clone(),
                });
            }
        }
    }

    // 4. 归一中间产物（校验/排序后确定态），分发到平台形
    let plan = MaskPlan {
        restricted,
        net_allow,
        roots,
        carveouts,
        meta_read_only,
        meta_create_deny,
    };
    match platform {
        Platform::Linux => Ok(compile_linux(req, &plan, facts)),
        Platform::MacOS => Ok(compile_mac(req, &plan)),
        Platform::Windows => compile_windows(req, policy, &plan),
    }
}

/// 编译中间产物：已校验、已按路径确定化排序（结构体收拢=clippy too_many_arguments 之解，
/// 同时固定"平台函数只消费归一态"的边界）。
struct MaskPlan<'a> {
    restricted: bool,
    net_allow: bool,
    roots: Vec<&'a RootPath>,
    carveouts: Vec<(PathBuf, Access)>,
    meta_read_only: BTreeSet<PathBuf>,
    meta_create_deny: BTreeSet<PathBuf>,
}

// ---------- 校验 ----------

fn validate_request(req: &ExecRequest) -> Result<(), CompileError> {
    if req.program.as_os_str().is_empty() {
        return Err(CompileError::EmptyProgram);
    }
    let prog = req.program.as_os_str().to_string_lossy();
    if prog.contains('/') || prog.contains('\\') {
        validate_path(&req.program)?;
    }
    validate_path(&req.cwd)?;
    Ok(())
}

/// 绝对 + 规范化校验（不依赖 host 语义：`/…` 或 `X:\…`/`X:/…` 皆认，[自定] 跨 host 确定——
/// `Path::is_absolute` 随 target 变化，纯函数快照必须 host 无关）。
fn validate_path(p: &Path) -> Result<(), CompileError> {
    let s = p.as_os_str().to_string_lossy();
    let bytes = s.as_bytes();
    let unix_abs = s.starts_with('/');
    let win_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if !(unix_abs || win_abs) {
        return Err(CompileError::PathNotAbsolute(p.to_path_buf()));
    }
    for c in p.components() {
        if matches!(c, Component::CurDir | Component::ParentDir) {
            return Err(CompileError::PathNotNormalized(p.to_path_buf()));
        }
    }
    Ok(())
}

fn join_rel(root: &Path, rel: &str) -> Result<PathBuf, CompileError> {
    let mut p = root.to_path_buf();
    for part in rel.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(CompileError::PathNotNormalized(root.join(rel))),
            _ => p.push(part),
        }
    }
    Ok(p)
}

fn acc_rank(a: Access) -> u8 {
    match a {
        Access::ReadOnly => 0,
        Access::DenyWrite => 1,
        Access::DenyRead => 2,
    }
}

/// 路径显示归一（跨 host 确定性）：统一分隔符为给定 platform 形态并去重斜杠、去尾分隔符
/// （根 "/" 与 "X:\" 保留）。argv/payload 一律经此函数出字符串。
fn path_text(p: &Path, platform: Platform) -> String {
    let raw = p.as_os_str().to_string_lossy().replace('\\', "/");
    let mut unified = String::with_capacity(raw.len());
    let mut prev_sep = false;
    for c in raw.chars() {
        if c == '/' {
            if prev_sep {
                continue;
            }
            prev_sep = true;
        } else {
            prev_sep = false;
        }
        unified.push(c);
    }
    if unified.len() > 1 && unified.ends_with('/') {
        unified.pop();
    }
    match platform {
        Platform::Windows => unified.replace('/', "\\"),
        _ => unified,
    }
}

fn tail(req: &ExecRequest, platform: Platform) -> Vec<String> {
    let mut v = vec![path_text(&req.program, platform)];
    v.extend(req.args.iter().cloned());
    v
}

fn mask_kind(path: &Path, facts: &PolicyFacts) -> MaskKind {
    if facts.exists.contains(path) {
        MaskKind::ReadOnlyBind
    } else {
        MaskKind::Tmpfs
    }
}

enum MaskKind {
    ReadOnlyBind,
    Tmpfs,
}

fn push_bind(argv: &mut Vec<String>, flag: &str, path: &str) {
    argv.push(flag.to_string());
    argv.push(path.to_string());
    argv.push(path.to_string());
}

// ---------- Linux（bwrap；两阶段真装填=WP-02，本层产外层 argv 形） ----------

fn compile_linux(req: &ExecRequest, plan: &MaskPlan<'_>, facts: &PolicyFacts) -> CompiledCommand {
    let MaskPlan {
        restricted,
        net_allow,
        roots,
        carveouts,
        meta_read_only,
        meta_create_deny,
    } = plan;
    let restricted = *restricted;
    let net_allow = *net_allow;
    // 通用参数集对位参考报告 §1.5 bwrap 公共参数（显式 --unshare-user 等，不靠自动启用——
    // uid 0 下 bubblewrap 会跳过 auto-enable 是其原话背景）。挂载次序=§1.5 六步序的最小形（[自定] 次序钉入快照）。
    let mut argv: Vec<String> = vec!["bwrap".to_string()];
    for f in [
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
    ] {
        argv.push(f.to_string());
    }
    if !net_allow {
        argv.push("--unshare-net".to_string()); // 网络 fail-closed：默认断网，开放需显式
    }
    if restricted {
        push_bind(&mut argv, "--ro-bind", "/");
    } else {
        push_bind(&mut argv, "--bind", "/");
    }
    argv.push("--dev".to_string());
    argv.push("/dev".to_string());
    argv.push("--proc".to_string());
    argv.push("/proc".to_string());
    for r in roots {
        let p = path_text(&r.path, Platform::Linux);
        push_bind(&mut argv, "--bind", &p);
    }
    let mut mask = |path: &Path, force_tmpfs: bool| {
        let p = path_text(path, Platform::Linux);
        if force_tmpfs || matches!(mask_kind(path, facts), MaskKind::Tmpfs) {
            argv.push("--tmpfs".to_string());
            argv.push(p);
        } else {
            push_bind(&mut argv, "--ro-bind", &p);
        }
    };
    for (p, a) in carveouts {
        match a {
            Access::ReadOnly | Access::DenyWrite => mask(p, false),
            Access::DenyRead => mask(p, true),
        }
    }
    for p in meta_read_only {
        mask(p, false);
    }
    for p in meta_create_deny {
        mask(p, false);
    }
    argv.push("--cap-drop".to_string());
    argv.push("ALL".to_string()); // capabilities 清零（fail-hard 断言在 WP-02 内层，§5.3(3) 行 266）
    argv.push("--".to_string());
    argv.extend(tail(req, Platform::Linux));
    CompiledCommand {
        sandbox: SandboxType::LinuxBubblewrap,
        argv,
        profile_text: None,
        params: Vec::new(),
        policy_json: None,
    }
}

// ---------- macOS（sandbox-exec + 运行时生成 SBPL） ----------

/// SBPL 基础段（[自定] 最小集：process/信号/sysctl/mach/posix-shm 粗放行，文件与网络留在
/// deny default 之下由后续节精确放行——粗粒度 allow 的必要性由 WP-02 以真命令 +
/// `seatbelt_tests.rs` 范本形制（§5.3(3) 行 266）实测校准）。
fn mac_base() -> Vec<String> {
    vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow signal*)".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow mach*)".to_string(),
        "(allow ipc-posix-shm)".to_string(),
    ]
}

struct ParamBuilder {
    items: Vec<(String, String)>,
}

impl ParamBuilder {
    fn add(&mut self, key_prefix: &str, path: &Path) -> String {
        let n = self
            .items
            .iter()
            .filter(|(k, _)| k.starts_with(key_prefix))
            .count();
        let name = format!("{key_prefix}{n}");
        self.items
            .push((name.clone(), path_text(path, Platform::MacOS)));
        name
    }
}

fn compile_mac(req: &ExecRequest, plan: &MaskPlan<'_>) -> CompiledCommand {
    let MaskPlan {
        restricted,
        net_allow,
        roots,
        carveouts,
        meta_read_only,
        meta_create_deny,
    } = plan;
    let restricted = *restricted;
    let net_allow = *net_allow;
    let mut pb = ParamBuilder { items: Vec::new() };
    let mut lines = mac_base();
    // 读轴：默认全盘可读（policy.rs 模块注），DenyRead 打洞在 deny 节
    lines.push("(allow file-read*)".to_string());
    // 写轴：逐根 allow；根锚点名留给 unlink 保护节
    let mut root_params: Vec<String> = Vec::new();
    if restricted {
        for r in roots {
            let name = pb.add("WR", &r.path);
            root_params.push(name.clone());
            lines.push(format!("(allow file-write* (subpath (param \"{name}\")))"));
        }
    } else {
        lines.push("(allow file-write*)".to_string());
    }
    // 网络轴：fail-closed——不放行则不发 allow（deny default 兜住）；loopback 代理桥=WP-02
    if net_allow {
        lines.push("(allow network*)".to_string());
    }
    // ---- deny 节：SBPL 后规则覆盖前规则，故 deny 全部置后；根锚最后
    //（参考报告 §1.4(b)"Keep these denies last so no broader allowance can reopen"）----
    let ro_union: BTreeSet<PathBuf> = carveouts
        .iter()
        .filter(|(_, a)| *a == Access::ReadOnly)
        .map(|(p, _)| p.clone())
        .chain(meta_read_only.iter().cloned())
        .collect();
    for p in &ro_union {
        let name = pb.add("RO", p);
        lines.push(format!("(deny file-write* (subpath (param \"{name}\")))"));
    }
    for (p, _) in carveouts.iter().filter(|(_, a)| *a == Access::DenyWrite) {
        let name = pb.add("DW", p);
        lines.push(format!("(deny file-write* (subpath (param \"{name}\")))"));
    }
    for (p, _) in carveouts.iter().filter(|(_, a)| *a == Access::DenyRead) {
        let name = pb.add("DR", p);
        lines.push(format!("(deny file-read* (subpath (param \"{name}\")))"));
    }
    for p in meta_create_deny {
        let name = pb.add("PD", p);
        // 双保险：受保护名 create 与 unlink 皆禁（首次 mkdir 洞 + 替换洞，参考报告 §1.4(c)）
        lines.push(format!(
            "(deny file-write-create (literal (param \"{name}\")))"
        ));
        lines.push(format!(
            "(deny file-write-unlink (literal (param \"{name}\")))"
        ));
    }
    for name in &root_params {
        // 根锚点禁删：沙箱进程不得删掉下次策略计算的权威边界（参考报告 §1.4(a)）
        lines.push(format!(
            "(deny file-write-unlink (require-all (literal (param \"{name}\")) (vnode-type DIRECTORY)))"
        ));
    }
    let profile_text = lines.join("\n");
    let mut argv: Vec<String> = vec![
        // 只信 /usr/bin 下的 sandbox-exec：PATH 上注入同名恶意二进制被拒（参考报告 §1.4 行 56 注原文理由）
        "/usr/bin/sandbox-exec".to_string(),
        "-p".to_string(),
        profile_text.clone(),
    ];
    for (k, v) in &pb.items {
        argv.push(format!("-D{k}={v}"));
    }
    argv.push("--".to_string());
    argv.extend(tail(req, Platform::MacOS));
    CompiledCommand {
        sandbox: SandboxType::MacosSeatbelt,
        argv,
        profile_text: Some(profile_text),
        params: pb.items,
        policy_json: None,
    }
}

// ---------- Windows（helper 伪装形：argv 包装 + canonical 策略 payload） ----------

#[derive(Serialize)]
struct WireRoot {
    path: String,
    shape: PathShape,
}

#[derive(Serialize)]
struct ProtectedExpanded {
    create_deny: Vec<String>,
    read_only: Vec<String>,
}

#[derive(Serialize)]
struct WirePolicy {
    // ENG-080 行 504 落盘契约键名逐字 camel（O4 清偿：跨进程 payload 亦按落盘纪律）
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    kind: FsKind,
    net: NetPolicy,
    writable_roots: Vec<WireRoot>,
    carveouts: Vec<(String, Access)>,
    protected_expanded: ProtectedExpanded,
}

fn compile_windows(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    plan: &MaskPlan<'_>,
) -> Result<CompiledCommand, CompileError> {
    let MaskPlan {
        roots,
        carveouts,
        meta_read_only,
        meta_create_deny,
        ..
    } = plan;
    let wire = WirePolicy {
        schema_version: POLICY_SCHEMA_VERSION,
        kind: policy.fs.kind,
        net: policy.net,
        writable_roots: roots
            .iter()
            .map(|r| WireRoot {
                path: path_text(&r.path, Platform::Windows),
                shape: r.shape,
            })
            .collect(),
        carveouts: carveouts
            .iter()
            .map(|(p, a)| (path_text(p, Platform::Windows), *a))
            .collect(),
        protected_expanded: ProtectedExpanded {
            create_deny: meta_create_deny
                .iter()
                .map(|p| path_text(p, Platform::Windows))
                .collect(),
            read_only: meta_read_only
                .iter()
                .map(|p| path_text(p, Platform::Windows))
                .collect(),
        },
    };
    let policy_json =
        serde_json::to_string(&wire).map_err(|e| CompileError::Serialize(format!("{e}")))?;
    let mut argv: Vec<String> = vec![
        // 提权 helper 名（真名解析与令牌/ACL 施加=WP-02 执行面；形对位 Codex
        // transform_for_direct_spawn 的 helper 伪装序，参考报告 §1.3）
        "standardcode-sandbox-runner".to_string(),
        "--policy".to_string(),
        policy_json.clone(),
        "--".to_string(),
    ];
    argv.extend(tail(req, Platform::Windows));
    Ok(CompiledCommand {
        sandbox: SandboxType::WindowsRestrictedToken,
        argv,
        profile_text: None,
        params: Vec::new(),
        policy_json: Some(policy_json),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::FileSystemPolicy;
    use serde_json::json;
    use std::path::PathBuf;

    fn req() -> ExecRequest {
        ExecRequest {
            program: PathBuf::from("git"),
            args: vec!["push".to_string()],
            cwd: PathBuf::from("/w"),
        }
    }

    fn root(p: &str) -> RootPath {
        RootPath::real(PathBuf::from(p))
    }

    fn ww_facts() -> PolicyFacts {
        PolicyFacts::exists(["/w/.git", "/w/.git/hooks"])
    }

    #[test]
    fn linux_workspace_write_snapshot() {
        let out = compile(
            &req(),
            &SandboxPolicy::workspace_write(vec![root("/w")]),
            &ww_facts(),
            Platform::Linux,
        )
        .unwrap();
        assert_eq!(out.sandbox, SandboxType::LinuxBubblewrap);
        assert_eq!(
            out.argv,
            vec![
                "bwrap",
                "--die-with-parent",
                "--new-session",
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-net",
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--bind",
                "/w",
                "/w",
                // 元数据隐式保护（EXE-011 行 427）：hooks 只读、.git 已存在→只读绑定、
                // .standardcode 缺失→tmpfs 遮蔽（防首次创建洞，§1.4(c) 同向）
                "--ro-bind",
                "/w/.git/hooks",
                "/w/.git/hooks",
                "--ro-bind",
                "/w/.git",
                "/w/.git",
                "--tmpfs",
                "/w/.standardcode",
                "--cap-drop",
                "ALL",
                "--",
                "git",
                "push",
            ]
        );
        assert!(out.profile_text.is_none() && out.policy_json.is_none());
    }

    #[test]
    fn linux_read_only_has_no_writable_bind() {
        let out = compile(
            &req(),
            &SandboxPolicy::read_only(),
            &PolicyFacts::default(),
            Platform::Linux,
        )
        .unwrap();
        // 只读档：无 --bind 根、无元数据 mask（无根可展开）
        assert!(!out
            .argv
            .windows(2)
            .any(|w| w[0] == "--bind" && w[1] == "/w"));
        assert!(out.argv.contains(&"--unshare-net".to_string()));
        assert!(out
            .argv
            .ends_with(&["--".to_string(), "git".to_string(), "push".to_string()]));
    }

    #[test]
    fn linux_danger_full_access_passthrough() {
        let out = compile(
            &req(),
            &SandboxPolicy::danger_full_access(),
            &PolicyFacts::default(),
            Platform::Linux,
        )
        .unwrap();
        assert_eq!(out.sandbox, SandboxType::None);
        assert_eq!(out.argv, vec!["git", "push"]);
    }

    #[test]
    fn linux_unrestricted_fs_with_net_denied_still_wrapped() {
        let pol = SandboxPolicy {
            fs: FileSystemPolicy {
                kind: FsKind::Unrestricted,
                ..Default::default()
            },
            net: NetPolicy::Denied,
        };
        let out = compile(&req(), &pol, &PolicyFacts::default(), Platform::Linux).unwrap();
        assert_eq!(out.sandbox, SandboxType::LinuxBubblewrap);
        assert!(out.argv.contains(&"--unshare-net".to_string()));
        // 全盘可写形：根为 rw bind
        assert!(out.argv.windows(3).any(|w| w == ["--bind", "/", "/"]));
    }

    #[test]
    fn linux_net_allow_form_omits_unshare_net() {
        // R1 清偿（DoD①"网络 deny·allow"两形之 allow 形判别力）：V4 针（无条件注入）必红于此
        let pol = SandboxPolicy::workspace_write(vec![root("/w")]).allow_network();
        let out = compile(&req(), &pol, &ww_facts(), Platform::Linux).unwrap();
        assert_eq!(out.sandbox, SandboxType::LinuxBubblewrap);
        assert!(
            !out.argv.iter().any(|a| a == "--unshare-net"),
            "net allow 形不得注入 --unshare-net: {:?}",
            out.argv
        );
        // 其余挂载/隔离形不变（allow-network 不放松 fs 面）
        assert!(out.argv.contains(&"--unshare-user".to_string()));
        assert!(out.argv.windows(3).any(|w| w == ["--bind", "/w", "/w"]));
        assert!(out
            .argv
            .ends_with(&["--".to_string(), "git".to_string(), "push".to_string()]));
    }

    #[test]
    fn mac_net_allow_emits_network_rule_before_denies() {
        let pol = SandboxPolicy::workspace_write(vec![root("/w")]).allow_network();
        let out = compile(&req(), &pol, &PolicyFacts::default(), Platform::MacOS).unwrap();
        let text = out.profile_text.unwrap();
        let net = text
            .find("(allow network*)")
            .expect("allow 形必须发出 (allow network*)");
        assert!(net < text.find("(deny file-write*").unwrap());
    }

    #[test]
    fn mac_read_only_snapshot_no_write_allow() {
        // "三档×三平台"完整集之 mac read-only 半（V 随卡建议）
        let out = compile(
            &req(),
            &SandboxPolicy::read_only(),
            &PolicyFacts::default(),
            Platform::MacOS,
        )
        .unwrap();
        let text = out.profile_text.clone().unwrap();
        assert!(text.contains("(allow file-read*)"));
        assert!(!text.contains("(allow file-write*"));
        assert!(!text.contains("(allow network*"));
        assert!(!text.contains("file-write-unlink")); // 无根=无 PD/RO/锚节
        assert!(out.params.is_empty());
        assert_eq!(out.argv[0], "/usr/bin/sandbox-exec");
    }

    #[test]
    fn windows_read_only_wire_empty_roots() {
        // "三档×三平台"完整集之 windows read-only 半
        let out = compile(
            &req(),
            &SandboxPolicy::read_only(),
            &PolicyFacts::default(),
            Platform::Windows,
        )
        .unwrap();
        let wire: serde_json::Value = serde_json::from_str(&out.policy_json.unwrap()).unwrap();
        assert_eq!(wire["kind"], json!("restricted"));
        assert_eq!(wire["net"], json!("denied"));
        assert_eq!(wire["writable_roots"], json!([]));
        assert_eq!(wire["protected_expanded"]["create_deny"], json!([]));
    }

    #[test]
    fn windows_wire_net_allowed_serialization() {
        // DoD① "网络 deny·allow"两形之 windows 半（三平台两形全覆盖收口）
        let pol = SandboxPolicy::workspace_write(vec![root("C:/w")]).allow_network();
        let req = ExecRequest {
            program: PathBuf::from("git"),
            args: vec!["push".to_string()],
            cwd: PathBuf::from("C:/w"),
        };
        let out = compile(&req, &pol, &PolicyFacts::default(), Platform::Windows).unwrap();
        let wire: serde_json::Value = serde_json::from_str(&out.policy_json.unwrap()).unwrap();
        assert_eq!(wire["net"], json!("allowed"));
        assert_eq!(wire["schemaVersion"], json!(1));
    }

    #[test]
    fn linux_carveout_masks() {
        let mut pol = SandboxPolicy::workspace_write(vec![root("/w")]);
        pol.fs.carveouts = vec![
            (PathBuf::from("/w/secret"), Access::DenyRead),
            (PathBuf::from("/w/out"), Access::ReadOnly),
            (PathBuf::from("/w/build"), Access::DenyWrite),
        ];
        let facts = PolicyFacts::exists(["/w/out", "/w/build"]);
        let out = compile(&req(), &pol, &facts, Platform::Linux).unwrap();
        // DenyRead 恒 tmpfs 遮蔽；ReadOnly/DenyWrite 已存在→ro-bind
        assert!(out.argv.windows(2).any(|w| w == ["--tmpfs", "/w/secret"]));
        assert!(out
            .argv
            .windows(3)
            .any(|w| w == ["--ro-bind", "/w/out", "/w/out"]));
        assert!(out
            .argv
            .windows(3)
            .any(|w| w == ["--ro-bind", "/w/build", "/w/build"]));
    }

    #[test]
    fn mac_profile_and_params_snapshot() {
        let out = compile(
            &req(),
            &SandboxPolicy::workspace_write(vec![root("/w")]),
            &PolicyFacts::default(),
            Platform::MacOS,
        )
        .unwrap();
        assert_eq!(out.sandbox, SandboxType::MacosSeatbelt);
        assert_eq!(
            out.profile_text,
            Some(
                [
                    "(version 1)",
                    "(deny default)",
                    "(allow process*)",
                    "(allow signal*)",
                    "(allow sysctl-read)",
                    "(allow mach*)",
                    "(allow ipc-posix-shm)",
                    "(allow file-read*)",
                    "(allow file-write* (subpath (param \"WR0\")))",
                    "(deny file-write* (subpath (param \"RO0\")))",
                    "(deny file-write-create (literal (param \"PD0\")))",
                    "(deny file-write-unlink (literal (param \"PD0\")))",
                    "(deny file-write-create (literal (param \"PD1\")))",
                    "(deny file-write-unlink (literal (param \"PD1\")))",
                    "(deny file-write-unlink (require-all (literal (param \"WR0\")) (vnode-type DIRECTORY)))",
                ]
                .join("\n")
            )
        );
        assert_eq!(
            out.params,
            vec![
                ("WR0".to_string(), "/w".to_string()),
                ("RO0".to_string(), "/w/.git/hooks".to_string()),
                ("PD0".to_string(), "/w/.git".to_string()),
                ("PD1".to_string(), "/w/.standardcode".to_string()),
            ]
        );
        // 路径不进 profile 文本、只进 -D 参数（注入防护形）
        assert!(!out.profile_text.as_ref().unwrap().contains("/w"));
        assert_eq!(out.argv[0], "/usr/bin/sandbox-exec");
    }

    #[test]
    fn mac_deny_sections_after_allows() {
        // deny 节必须全部位于写 allow 节之后（SBPL 后规则覆盖；参考报告 §1.4(b)"denies last"）
        let mut pol = SandboxPolicy::workspace_write(vec![root("/w")]);
        pol.fs.carveouts = vec![(PathBuf::from("/w/x"), Access::DenyWrite)];
        let out = compile(&req(), &pol, &PolicyFacts::default(), Platform::MacOS).unwrap();
        let text = out.profile_text.unwrap();
        let write_allow = text.find("(allow file-write*").unwrap();
        assert!(text.find("(deny file-write*").unwrap() > write_allow);
        assert!(text.find("(deny file-read*").is_none());
    }

    #[test]
    fn windows_helper_shape_and_policy_json_canonical() {
        let req = ExecRequest {
            program: PathBuf::from("git"),
            args: vec!["push".to_string()],
            cwd: PathBuf::from("C:/w"),
        };
        let pol = SandboxPolicy::workspace_write(vec![root("C:/w")]);
        let out = compile(&req, &pol, &PolicyFacts::default(), Platform::Windows).unwrap();
        assert_eq!(out.sandbox, SandboxType::WindowsRestrictedToken);
        assert_eq!(out.argv[0], "standardcode-sandbox-runner");
        assert_eq!(out.argv[1], "--policy");
        assert_eq!(out.argv[3], "--");
        assert_eq!(out.argv[4], "git");
        let wire: serde_json::Value = serde_json::from_str(&out.policy_json.unwrap()).unwrap();
        assert_eq!(
            wire,
            json!({
                "schemaVersion": 1u64,
                "kind": "restricted",
                "net": "denied",
                "writable_roots": [{"path": "C:\\w", "shape": "real"}],
                "carveouts": [],
                "protected_expanded": {
                    "create_deny": ["C:\\w\\.git", "C:\\w\\.standardcode"],
                    "read_only": ["C:\\w\\.git\\hooks"]
                }
            })
        );
    }

    #[test]
    fn windows_deny_read_requires_elevation() {
        let mut pol = SandboxPolicy::workspace_write(vec![root("C:/w")]);
        pol.fs.carveouts = vec![(PathBuf::from("C:/w/secret"), Access::DenyRead)];
        let err = compile(&req(), &pol, &PolicyFacts::default(), Platform::Windows).unwrap_err();
        assert!(matches!(err, CompileError::DenyReadRequiresElevation(_)));
        let f = PolicyFacts {
            exists: Default::default(),
            elevated: true,
        };
        assert!(compile(&req(), &pol, &f, Platform::Windows).is_ok());
    }

    #[test]
    fn deny_always_wins_root_under_protection_rejected() {
        // 可写根落受保护元数据下 → 直接拒绝（deny 恒赢，不开洞）
        let pol = SandboxPolicy::workspace_write(vec![root("/w/.git")]);
        let err = compile(&req(), &pol, &PolicyFacts::default(), Platform::Linux).unwrap_err();
        assert!(matches!(err, CompileError::RootUnderProtection { .. }));
    }

    #[test]
    fn symlink_rejected_top_alias_allowed() {
        let deep = SandboxPolicy::workspace_write(vec![RootPath {
            path: PathBuf::from("/w/link"),
            shape: PathShape::DeepSymlink,
        }]);
        assert!(matches!(
            compile(&req(), &deep, &PolicyFacts::default(), Platform::Linux).unwrap_err(),
            CompileError::SymlinkRejected { .. }
        ));
        let alias = SandboxPolicy::workspace_write(vec![RootPath {
            path: PathBuf::from("/tmp/w"),
            shape: PathShape::TopLevelAlias,
        }]);
        assert!(compile(&req(), &alias, &PolicyFacts::default(), Platform::Linux).is_ok());
    }

    #[test]
    fn path_validation_fail_closed() {
        let rel = SandboxPolicy::workspace_write(vec![root("w/rel")]);
        assert!(compile(&req(), &rel, &PolicyFacts::default(), Platform::Linux).is_err());
        let up = SandboxPolicy::workspace_write(vec![root("/w/../x")]);
        assert!(matches!(
            compile(&req(), &up, &PolicyFacts::default(), Platform::Linux).unwrap_err(),
            CompileError::PathNotNormalized(_)
        ));
        let empty = ExecRequest {
            program: PathBuf::new(),
            args: vec![],
            cwd: PathBuf::from("/w"),
        };
        assert!(matches!(
            compile(
                &empty,
                &SandboxPolicy::read_only(),
                &PolicyFacts::default(),
                Platform::Linux
            )
            .unwrap_err(),
            CompileError::EmptyProgram
        ));
        let rel_prog = ExecRequest {
            program: PathBuf::from("bin/git"),
            args: vec![],
            cwd: PathBuf::from("/w"),
        };
        assert!(matches!(
            compile(
                &rel_prog,
                &SandboxPolicy::read_only(),
                &PolicyFacts::default(),
                Platform::Linux
            )
            .unwrap_err(),
            CompileError::PathNotAbsolute(_)
        ));
    }

    #[test]
    fn determinism_input_order_irrelevant() {
        let a = SandboxPolicy::workspace_write(vec![root("/a"), root("/w")]);
        let b = SandboxPolicy::workspace_write(vec![root("/w"), root("/a")]);
        let fa = PolicyFacts::default();
        let oa = compile(&req(), &a, &fa, Platform::Linux).unwrap();
        let ob = compile(&req(), &b, &fa, Platform::Linux).unwrap();
        assert_eq!(oa, ob);
        // 二次编译逐字节等
        assert_eq!(oa, compile(&req(), &a, &fa, Platform::Linux).unwrap());
    }

    #[test]
    fn path_text_normalizes_across_separators() {
        assert_eq!(path_text(Path::new("/w//x/"), Platform::Linux), "/w/x");
        assert_eq!(
            path_text(Path::new("C:\\w\\/x"), Platform::Windows),
            "C:\\w\\x"
        );
        assert_eq!(path_text(Path::new("/"), Platform::Linux), "/");
    }
}
