//! Linux 后端：bubblewrap（文件系统视图）+ seccomp（socket 面）两阶段执行。
//!
//! 两阶段理由（参考报告 §1.5，机制级）：seccomp 过滤器必须在 bwrap 建立文件系统视图**之后**
//! 安装，否则 bwrap 自身被过滤器挡住。阶段 1=外层拉起 bwrap，命令位放本二进制自调用；
//! 阶段 2=命名空间内 `--inner-seccomp`：capabilities 清零断言 **fail-hard**（§5.3(3) 行 266）
//! → prctl(NO_NEW_PRIVS) → seccomp 装载 → execvp 真命令。
//!
//! 已知边界（登记结果页）：`--cap-drop ALL` 由 bwrap 执行；阶段 2 的 capget 断言是其消费方
//! （fail-hard 自检=纵深防御，非唯一防线）。信号转发=首版同步 wait（工具执行子进程池语义在
//! WP-03 宿主层，本层 `--die-with-parent` 兜底父亡子亡）。

use std::path::Path;
use std::process::Stdio;

use crate::compile::{compile, Platform, SandboxType};
use crate::error::RunError;
use crate::exec::{ExecOutput, ExecRequest, PolicyFacts};
use crate::policy::{NetPolicy, SandboxPolicy};
use crate::run::plain_exec;
use crate::seccomp;

/// 阶段 1：bwrap argv 组装（compile 产物 `--` 之后插入内层自调用）+ 同步执行。
pub fn run(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
    self_exe: &Path,
) -> Result<(u32, ExecOutput), RunError> {
    // 策略闸下沉至平台入口（直调本函数亦剥键——防分发层旁路，DoD⑤ 双闸）
    let mut req = req.clone();
    crate::run::apply_proxy_policy(&mut req.env, policy);
    let compiled = compile(&req, policy, facts, Platform::Linux)?;
    if compiled.sandbox == SandboxType::None {
        return plain_exec(&req);
    }
    let net_allow = policy.net == NetPolicy::Allowed;
    let filter_b64 = seccomp::encode_program(&seccomp::build_program(net_allow));
    let sep = compiled
        .argv
        .iter()
        .rposition(|a| a == "--")
        .ok_or_else(|| RunError::Inner("compiled argv missing `--` separator".into()))?;
    let mut argv: Vec<String> = compiled.argv[..=sep].to_vec();
    argv.push(self_exe.to_string_lossy().into_owned());
    argv.push("--inner-seccomp".to_string());
    argv.push("--filter-b64".to_string());
    argv.push(filter_b64);
    argv.push("--".to_string());
    argv.extend_from_slice(&compiled.argv[sep + 1..]);

    let child = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(&req.cwd)
        .env_clear()
        .envs(&req.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            RunError::Spawn(format!(
                "bwrap 拉起失败（fail-closed，非绕过沙箱；bwrap 是否在位？）: {e}"
            ))
        })?;
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

/// 阶段 2（沙箱命名空间内）：capget 清零断言 fail-hard → seccomp 装载 → execvp。
/// 返回退出码（正常路径 exec 成功则不返回）。
pub fn inner_main(args: &[String]) -> i32 {
    let filter_b64 = match (
        args.first().map(String::as_str),
        args.get(1).map(String::as_str),
    ) {
        (Some("--filter-b64"), Some(b64)) => b64,
        _ => {
            eprintln!("inner: expected `--filter-b64 <b64> -- <program> [args...]`");
            return 2;
        }
    };
    let rest = match args.iter().position(|a| a == "--") {
        Some(i) if i + 1 < args.len() => args[i + 1..].to_vec(),
        _ => {
            eprintln!("inner: missing `-- <program>` tail");
            return 2;
        }
    };
    let prog = match seccomp::decode_program(filter_b64) {
        Some(p) => p,
        None => {
            eprintln!("inner: bad filter payload");
            return 2;
        }
    };
    // capabilities 清零断言（fail-hard：非零=直接终止，绝不带权限继续——§5.3(3) 行 266）
    if let Err(e) = assert_caps_zero() {
        eprintln!("inner: {e}");
        return 3;
    }
    if let Err(e) = seccomp::install(&prog) {
        eprintln!("inner: {e}");
        return 3;
    }
    // execvp（成功则不返回；失败才继续）
    let cprog = match std::ffi::CString::new(rest[0].clone()) {
        Ok(c) => c,
        Err(_) => return 2,
    };
    let mut cargs: Vec<std::ffi::CString> = Vec::new();
    for a in &rest {
        match std::ffi::CString::new(a.clone()) {
            Ok(c) => cargs.push(c),
            Err(_) => return 2,
        }
    }
    let mut argvp: Vec<*const std::ffi::c_char> = cargs
        .iter()
        .map(|c| c.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    // cargs 存活至 execvp（argvp 指向其堆缓冲）
    let rc = unsafe { libc::execvp(cprog.as_ptr(), argvp.as_mut_ptr()) };
    let _ = rc;
    eprintln!("inner: execvp failed: {}", std::io::Error::last_os_error());
    127
}

/// 测试探针：AF_INET socket 应被 seccomp 拒（EPERM），AF_UNIX 放行。
/// 退出码：0=AF_INET 被拒（沙箱生效），1=AF_INET 成功（未拦），2=AF_UNIX 也被误拦。
pub fn probe_socket() -> i32 {
    let inet = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    let inet_errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(-1);
    let unix = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    let unix_errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(-1);
    println!("probe: AF_INET fd={inet} errno={inet_errno} AF_UNIX fd={unix} errno={unix_errno}");
    if unix < 0 {
        return 2;
    }
    if inet < 0 {
        0
    } else {
        1
    }
}

/// capget 清零断言（内核 ABI 直调，struct 手拼免 libc 版本面差异）。
fn assert_caps_zero() -> Result<(), String> {
    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct CapData {
        effective: [u32; 2],
        permitted: [u32; 2],
        inheritable: [u32; 2],
    }
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    let mut hdr = CapHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = CapData::default();
    let rc = unsafe {
        libc::syscall(
            libc::SYS_capget,
            &mut hdr as *mut CapHeader,
            &mut data as *mut CapData,
        )
    };
    if rc != 0 {
        return Err(format!(
            "capget failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if data.effective != [0, 0] || data.permitted != [0, 0] {
        return Err(format!(
            "capabilities not zeroed inside sandbox (fail-hard): effective={:?} permitted={:?}",
            data.effective, data.permitted
        ));
    }
    Ok(())
}
