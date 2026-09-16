//! WP-02 Linux 真隔离集成测（bwrap+seccomp 两阶段）。CARGO_BIN_EXE_* 仅集成测面可用，
//! 故本模块住 tests/（macos/windows 真跑测各自 cfg 门于 lib 内——载体差异登记结果页）。
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::Stdio;

use standardcode_sandbox::compile::{compile, Platform};
use standardcode_sandbox::exec::{ExecRequest, PolicyFacts};
use standardcode_sandbox::linux;
use standardcode_sandbox::policy::{RootPath, SandboxPolicy};
use standardcode_sandbox::seccomp;

const SANDBOX_BIN: &str = env!("CARGO_BIN_EXE_standardcode-sandbox");

fn bwrap_available() -> bool {
    std::process::Command::new("bwrap")
        .args(["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct Tree {
    t: PathBuf,
}

impl Tree {
    fn new(tag: &str) -> Self {
        let t = std::env::temp_dir().join(format!("sc-sbx-lin-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join("ws/.git/hooks")).unwrap();
        std::fs::create_dir_all(t.join("ws/.standardcode")).unwrap();
        std::fs::write(t.join("ws/.standardcode/settings.json"), b"keep").unwrap();
        std::fs::write(t.join("outside.txt"), b"host").unwrap();
        Self { t }
    }
    fn ws(&self) -> PathBuf {
        self.t.join("ws")
    }
    fn facts(&self) -> PolicyFacts {
        PolicyFacts::exists([
            self.ws().join(".git"),
            self.ws().join(".git/hooks"),
            self.ws().join(".standardcode"),
        ])
    }
    fn pol(&self) -> SandboxPolicy {
        SandboxPolicy::workspace_write(vec![RootPath::real(self.ws())])
    }
    fn sh(&self, cmd: &str) -> standardcode_sandbox::exec::ExecOutput {
        let req = ExecRequest::new("/bin/sh", vec!["-c".into(), cmd.to_string()], self.ws());
        linux::run(&req, &self.pol(), &self.facts(), Path::new(SANDBOX_BIN)).expect("bwrap run")
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.t);
    }
}

#[test]
fn linux_real_isolation_suite() {
    if !bwrap_available() {
        eprintln!("SKIP: bwrap 非特权不可用（登记；WSL2 本地与 ubuntu CI 均实测在位）");
        return;
    }
    let tr = Tree::new("suite");
    // DoD① 工作区内写成功
    let o = tr.sh(&format!("touch {}/ok", tr.ws().display()));
    assert_eq!(o.exit_code, Some(0), "in-ws write: {}", o.stderr);
    assert!(tr.ws().join("ok").exists());
    // DoD① 工作区外写失败且错误可诊断（Read-only file system）
    let out_file = tr.t.join("outside2");
    let o = tr.sh(&format!("touch {} 2>&1", out_file.display()));
    assert_ne!(o.exit_code, Some(0), "outside write must fail");
    assert!(o.stdout.contains("Read-only file system"), "{}", o.stdout);
    assert!(!out_file.exists());
    // 读轴保留：工作区外文件可读（restricted 档全盘可读形）
    let o = tr.sh(&format!("cat {}/outside.txt", tr.t.display()));
    assert_eq!(o.exit_code, Some(0), "read outside: {}", o.stdout);
    assert_eq!(o.stdout.trim(), "host");
    // DoD④ 元数据禁写：.standardcode 已存在→ro-bind 真拒写（含 mkdir）
    let o = tr.sh(&format!(
        "touch {}/.standardcode/x 2>&1; mkdir {}/.standardcode/sub 2>&1",
        tr.ws().display(),
        tr.ws().display()
    ));
    assert!(
        o.stdout.contains("Read-only file system"),
        "protected: {}",
        o.stdout
    );
    assert!(!tr.ws().join(".standardcode/x").exists());
    assert_eq!(
        std::fs::read(tr.ws().join(".standardcode/settings.json")).unwrap(),
        b"keep"
    );
    // DoD② 两阶段内层在链上：探针程序经沙箱内层 exec（seccomp 装载后跑）
    //   AF_INET socket=EPERM（seccomp 拒），AF_UNIX 放行
    let probe = std::process::Command::new("bwrap")
        .args([
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--as-pid-1",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--cap-drop",
            "ALL",
            "--",
            SANDBOX_BIN,
            "--inner-seccomp",
            "--filter-b64",
            &seccomp::encode_program(&seccomp::build_program(false)),
            "--",
            SANDBOX_BIN,
            "--probe-socket",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&probe.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&probe.stderr).into_owned();
    assert_eq!(
        probe.status.code(),
        Some(0),
        "probe: AF_INET 应被 seccomp 拒(退0)+AF_UNIX 放行: out={stdout} err={stderr}"
    );
    assert!(stdout.contains("AF_INET fd=-1"), "{stdout}");
    // 两阶段经 run() 生产形（探针作为被沙箱命令，run() 自动装内层）
    let req = ExecRequest::new(SANDBOX_BIN, vec!["--probe-socket".into()], tr.ws());
    let o = linux::run(&req, &tr.pol(), &tr.facts(), Path::new(SANDBOX_BIN)).unwrap();
    assert_eq!(
        o.exit_code,
        Some(0),
        "seccomp via run(): {} {}",
        o.stdout,
        o.stderr
    );
    // DoD⑤ 代理 fail-closed：deny 策略剥全部代理族键（子进程 env 自证）
    let mut req = ExecRequest::new(
        "/bin/sh",
        vec![
            "-c".into(),
            "env | grep -ciE '^(HTTP|HTTPS|ALL|NO|FTP|SOCKS)_proxy=' || true".into(),
        ],
        tr.ws(),
    );
    req.env = [
        ("HTTP_PROXY".to_string(), "http://evil:1".to_string()),
        ("http_proxy".to_string(), "http://evil:1".to_string()),
        ("ALL_PROXY".to_string(), "socks5://evil".to_string()),
        ("all_proxy".to_string(), "socks5://evil".to_string()),
        ("KEEPME".to_string(), "1".to_string()),
    ]
    .into_iter()
    .collect();
    let o = linux::run(&req, &tr.pol(), &tr.facts(), Path::new(SANDBOX_BIN)).unwrap();
    assert_eq!(o.stdout.trim(), "0", "proxy keys must vanish: {}", o.stdout);
    // 对照：网络开=允许档代理键保留（剥键仅随 deny 策略，非无条件）
    let pol = tr.pol().allow_network();
    let o = linux::run(&req, &pol, &tr.facts(), Path::new(SANDBOX_BIN)).unwrap();
    assert_eq!(
        o.stdout.trim(),
        "4",
        "net-allow must keep proxy keys: {}",
        o.stdout
    );
}

#[test]
fn inner_bad_args_fail_closed() {
    // 内层面对坏 filter/缺参=非零退出且不 exec（不触真命令）
    assert_eq!(linux::inner_main(&[]), 2);
    assert_eq!(linux::inner_main(&["--filter-b64".to_string()]), 2);
    assert_eq!(
        linux::inner_main(&[
            "--filter-b64".to_string(),
            "!!!".to_string(),
            "--".to_string(),
            "/bin/true".to_string()
        ]),
        2
    );
}

#[test]
fn danger_passthrough_via_run() {
    if !bwrap_available() {
        return;
    }
    let tr = Tree::new("danger");
    let req = ExecRequest::new("/bin/true", vec![], tr.ws());
    let o = linux::run(
        &req,
        &SandboxPolicy::danger_full_access(),
        &PolicyFacts::default(),
        Path::new(SANDBOX_BIN),
    )
    .unwrap();
    assert_eq!(o.exit_code, Some(0));
}

#[test]
fn compile_shape_has_inner_splice_source() {
    // run() 组装不变式：最终 argv 在 `--` 后插内层自调用（对 compile 快照零改动的执行侧断言）
    let tr = Tree::new("splice");
    let compiled = compile(
        &ExecRequest::new("/bin/true", vec![], tr.ws()),
        &tr.pol(),
        &tr.facts(),
        Platform::Linux,
    )
    .unwrap();
    assert_eq!(compiled.argv.last().unwrap(), "/bin/true");
    // compile 层不含内层——内层由 run 注入（职责分层断言）
    assert!(!compiled.argv.iter().any(|a| a == "--inner-seccomp"));
}
