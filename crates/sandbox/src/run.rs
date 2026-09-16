//! 执行层入口（WP-02）：策略+请求 → 平台真沙箱执行，返回 [`ExecOutput`]。
//! fail-closed：拉起失败/内层拒绝一律 Err 上抛，绝不回退未沙箱执行（B-12）。
//!
//! 代理 fail-closed 落点（§5.3(3) 教训清单行 266 第四条）：策略网络=deny 时，
//! 子进程 env 经 [`apply_proxy_policy`] 剥离代理族键（含大小写两形）——无 `--unshare-net`/
//! seccomp 之外的第二条外逃通道；Windows 首版（legacy 非 elevated 后端）无法用 WFP，
//! env 剥离+受限令牌即该面的全部可表达形（登记偏差）。托管代理桥（loopback only）=非目标，
//! 规格未给（§13 网络策略行无代理白名单机制）→ 不做。

use std::collections::BTreeMap;

use crate::compile::Platform;
use crate::error::RunError;
use crate::exec::{ExecOutput, ExecRequest, PolicyFacts};
use crate::policy::SandboxPolicy;

/// 代理族键（v2.8 §7.7 行 353 + 附录 C 行 622 全组 + SOCKS 含之；大小写两形）。
pub const PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "FTP_PROXY",
    "SOCKS_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "ftp_proxy",
    "socks_proxy",
];

/// 策略网络=deny 时剥离代理族键（就地）。allow 时原样（代理是否配置=用户面，MDL-020/021）。
pub fn apply_proxy_policy(env: &mut BTreeMap<String, String>, policy: &SandboxPolicy) {
    if policy.net == crate::policy::NetPolicy::Denied {
        for k in PROXY_ENV_KEYS {
            env.remove(*k);
        }
    }
}

/// danger-full-access 双轴全开=直通形（compile 返回 SandboxType::None）：不经任何沙箱
/// 原语直接执行——该形态的存在前提是宿主层已获显式确认（WP-03 DoD③），执行层不复核确认来源。
/// 返回 (pid, 产物)：pid 供 serve 层登记/teardown 清理面。
pub(crate) fn plain_exec(req: &ExecRequest) -> Result<(u32, ExecOutput), RunError> {
    let child = std::process::Command::new(&req.program)
        .args(&req.args)
        .current_dir(&req.cwd)
        .env_clear()
        .envs(&req.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| RunError::Spawn(format!("直通臂拉起失败: {e}")))?;
    let pid = child.id();
    let out = child.wait_with_output().map_err(RunError::Io)?;
    Ok((
        pid,
        ExecOutput {
            exit_code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
    ))
}

/// 真跑（Platform::host 分发）。`self_exe` 默认取 [`std::env::current_exe`]（Linux 两阶段
/// 内层目标；集成测经 [`run_with_self_exe`] 注入 cargo 提供的 bin 路径——[自定] 测试载体）。
/// 返回 (沙箱化直接子进程 pid, 产物)——pid=登记/清理面（serve teardown）。
pub fn run(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
) -> Result<(u32, ExecOutput), RunError> {
    let exe = std::env::current_exe().map_err(|e| RunError::Spawn(format!("current_exe: {e}")))?;
    run_with_self_exe(req, policy, facts, &exe)
}

pub fn run_with_self_exe(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
    self_exe: &std::path::Path,
) -> Result<(u32, ExecOutput), RunError> {
    let _ = &self_exe; // 仅 Linux 臂消费（其余平台编译期 cfg 掉）
    match Platform::host() {
        #[cfg(target_os = "linux")]
        Platform::Linux => crate::linux::run(req, policy, facts, self_exe),
        #[cfg(target_os = "macos")]
        Platform::MacOS => crate::macos::run(req, policy, facts),
        #[cfg(windows)]
        Platform::Windows => crate::windows::run(req, policy, facts),
        // 非本平台臂：编译期已 cfg 掉；三平台之外不支持（get_platform_sandbox=None 形，
        // 参考报告 §1.3——本 crate 仅三目标）。
        #[allow(unreachable_patterns)]
        _ => Err(RunError::Spawn(format!(
            "unsupported host platform for sandbox execution: {:?}",
            Platform::host()
        ))),
    }
}
