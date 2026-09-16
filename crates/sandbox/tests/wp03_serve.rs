//! WP-03 serve 帧协议端到端集成测（真 `--serve` 子进程=宿主同形通道）。
//! 判据分层：握手/danger 直通 fsWrite/EOF 退出=三平台可跑；windows workspace-write
//! =privilege_missing 错误帧（fail-closed 正向断言承 BLK-04=① 实证——runner/本机皆无
//! CPAU 特权，此处"报错而非静默放行"就是要判的形状）；linux workspace-write 真隔离
//! （bwrap 在位才跑，同 wp02 集成 skip-guard 形制）。

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use standardcode_sandbox::ipc::{Frame, FrameCodec};
use standardcode_sandbox::policy::SandboxPolicy;

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: std::io::BufReader<ChildStdout>,
}

impl Server {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_standardcode-sandbox"))
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("sandbox bin --serve spawn");
        let stdin = child.stdin.take().unwrap();
        let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut this = Self {
            child,
            stdin,
            stdout,
        };
        this.send(&Frame::hello());
        let hello = this.recv();
        assert_eq!(hello["kind"], "hello", "握手回应必须先到");
        assert_eq!(hello["payload"]["protocol"], 5);
        this
    }

    fn send(&mut self, frame: &Frame) {
        self.stdin
            .write_all(&FrameCodec::encode(frame).unwrap())
            .and_then(|()| self.stdin.flush())
            .expect("write frame");
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).expect("read line");
        assert!(n > 0, "EOF before frame");
        serde_json::from_str(&line).unwrap()
    }

    /// 收满指定 reqId 的终帧（response/error），返回 {终帧, 事件帧表}。
    fn settle(&mut self, req_id: u64) -> (Value, Vec<Value>) {
        let mut events = Vec::new();
        loop {
            let f = self.recv();
            match f["kind"].as_str().unwrap() {
                "event" => {
                    assert_eq!(
                        f["payload"]["data"]["reqId"], req_id,
                        "event 必带 reqId 关联"
                    );
                    events.push(f);
                }
                "response" | "error" => {
                    assert_eq!(f["id"].as_u64(), Some(req_id));
                    return (f, events);
                }
                other => panic!("unexpected frame kind after request: {other}"),
            }
        }
    }

    fn shutdown(self) {
        let Server {
            mut child,
            mut stdin,
            stdout: _,
        } = self;
        drop(stdin.flush());
        drop(stdin); // stdin EOF=会话结束
        let status = child.wait().expect("wait server");
        assert!(status.success(), "EOF 正常退出码 0");
    }
}

fn danger_wire() -> Value {
    serde_json::to_value(SandboxPolicy::danger_full_access()).unwrap()
}

#[test]
fn serve_handshake_danger_fs_write_e2e_all_platforms() {
    // danger-full-access=直通臂：fsWrite 三平台皆可真跑（BLK-04=① windows 子进程全链
    // 受限的替代验证面——直通形不经 CPAU）。workspace-write 真隔离面按平台分支见下两测。
    let dir = std::env::temp_dir().join(format!("wp03-fsw-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join("deep/nested/out.txt");
    let mut srv = Server::spawn();
    let params = json!({
        "path": target.to_string_lossy(),
        "content": "wp03 内容通道 ✓\n第二行",
        "policy": danger_wire(),
    });
    srv.send(&Frame::request(11, "fsWrite", params));
    let (term, _events) = srv.settle(11);
    assert_eq!(term["kind"], "response", "danger fsWrite 应成帧：{term}");
    assert_eq!(term["payload"]["result"]["exitCode"], 0);
    assert_eq!(
        std::fs::read(&target).unwrap(),
        "wp03 内容通道 ✓\n第二行".as_bytes(),
        "沙箱写入原语落盘=内容保真（多行 utf8）"
    );
    srv.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn serve_unknown_method_and_bad_frame_do_not_kill_channel() {
    // 协议卫生面：unknown method=会话继续（后续请求仍可发）；server 对入站 event 帧拒绝。
    let mut srv = Server::spawn();
    srv.send(&Frame::request(21, "nope", json!({})));
    let (term, _) = srv.settle(21);
    assert_eq!(term["payload"]["code"], "unknown_method");
    srv.send(&Frame::event("hi", json!({})));
    let f = srv.recv();
    assert_eq!(
        f["payload"]["code"], "bad_envelope",
        "入站 event 帧必须被拒"
    );
    srv.send(&Frame::request(22, "fsWrite", json!({"nope": true})));
    let (term, _) = srv.settle(22);
    assert_eq!(term["payload"]["code"], "bad_params");
    srv.shutdown();
}

#[cfg(windows)]
#[test]
fn serve_workspace_write_run_fails_closed_privilege() {
    // 非提权环境（本机 Medium IL/GH runner 实证=BLK-04 语境）：run 必得 privilege_missing
    // 错误帧且**通道不终止**（fail-closed=报错非静默非放行）；提权实机若改判成功=回归清单注。
    let dir = std::env::temp_dir().join(format!("wp03-win-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let mut srv = Server::spawn();
    let exec = json!({
        "program": "cmd.exe",
        "args": ["/C", "echo hi"],
        "cwd": dir.join("ws").to_string_lossy(),
        "env": {},
    });
    let policy = serde_json::to_value(SandboxPolicy::workspace_write(vec![
        standardcode_sandbox::policy::RootPath::real(dir.join("ws")),
    ]))
    .unwrap();
    srv.send(&Frame::request(
        31,
        "run",
        json!({"exec": exec, "policy": policy}),
    ));
    let (term, _events) = srv.settle(31);
    assert_eq!(
        term["kind"], "error",
        "非提权 windows run 必须错误帧：{term}"
    );
    assert_eq!(term["payload"]["code"], "privilege_missing");
    // 通道不终止：再来一请求正常响应
    srv.send(&Frame::request(32, "nope", json!({})));
    let (t2, _) = srv.settle(32);
    assert_eq!(t2["payload"]["code"], "unknown_method");
    srv.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "linux")]
#[test]
fn serve_workspace_write_run_real_isolation() {
    // bwrap 在位才跑（skip-guard 承 wp02 形制，缺席=显式 panic 提示而非静默）。
    if std::process::Command::new("bwrap")
        .args([
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--",
            "/bin/true",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| !s.success())
        .unwrap_or(true)
    {
        panic!("bwrap 缺席/不工作——linux 泳道真隔离判据必须实跑（WSL/CI ubuntu）");
    }
    let dir = std::env::temp_dir().join(format!("wp03-lin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let outside = dir.join("outside.txt");
    let mut srv = Server::spawn();
    let policy = serde_json::to_value(SandboxPolicy::workspace_write(vec![
        standardcode_sandbox::policy::RootPath::real(dir.join("ws")),
    ]))
    .unwrap();
    // ① ws 内写成功
    let exec_ok = json!({
        "program": "/bin/sh",
        "args": ["-c", "echo hi > inside.txt"],
        "cwd": dir.join("ws").to_string_lossy(),
        "env": {"PATH": "/bin:/usr/bin"},
    });
    srv.send(&Frame::request(
        41,
        "run",
        json!({"exec": exec_ok, "policy": policy}),
    ));
    let (term, events) = srv.settle(41);
    assert_eq!(
        term["payload"]["result"]["exitCode"], 0,
        "ws 内写应成：{term}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("ws/inside.txt"))
            .unwrap()
            .trim(),
        "hi"
    );
    let _ = events;
    // ② 越界写失败（EROFS，错误可诊断=stderr 非空经 event 帧透传）
    let exec_bad = json!({
        "program": "/bin/sh",
        "args": ["-c", format!("touch {}", outside.to_string_lossy())],
        "cwd": dir.join("ws").to_string_lossy(),
        "env": {"PATH": "/bin:/usr/bin"},
    });
    srv.send(&Frame::request(
        42,
        "run",
        json!({"exec": exec_bad, "policy": policy}),
    ));
    let (term, events) = srv.settle(42);
    let code = term["payload"]["result"]["exitCode"].as_i64().unwrap();
    assert_ne!(code, 0, "越界写必须失败");
    let stderr_all: String = events
        .iter()
        .filter(|e| e["payload"]["data"]["stream"] == "stderr")
        .map(|e| {
            e["payload"]["data"]["data"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert!(
        stderr_all.to_lowercase().contains("read-only") || stderr_all.contains("EROFS"),
        "错误可诊断（EROFS/Read-only file system 字样经 event 帧到宿主）：{stderr_all:?}"
    );
    assert!(!outside.exists(), "宿主面零落盘");
    // ③ 元数据默认禁写：.git/hooks touch 失败（EXE-011 行 427 清单经 serve 通道同样兑现）
    std::fs::create_dir_all(dir.join("ws/.git/hooks")).unwrap();
    let exec_meta = json!({
        "program": "/bin/sh",
        "args": ["-c", "touch .git/hooks/probe"],
        "cwd": dir.join("ws").to_string_lossy(),
        "env": {"PATH": "/bin:/usr/bin"},
    });
    srv.send(&Frame::request(
        43,
        "run",
        json!({"exec": exec_meta, "policy": policy}),
    ));
    let (term, _) = srv.settle(43);
    assert_ne!(
        term["payload"]["result"]["exitCode"].as_i64().unwrap(),
        0,
        ".git/hooks 默认禁写在 serve 通道同样生效"
    );
    assert!(!dir.join("ws/.git/hooks/probe").exists());
    srv.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "linux")]
#[test]
fn serve_fs_write_under_workspace_write_enforced() {
    // fsWrite 经 workspace-write：root 内成功；root 外被 bwrap 拒（DoD②"文件写经沙箱"核心）。
    let dir = std::env::temp_dir().join(format!("wp03-lfw-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let policy = serde_json::to_value(SandboxPolicy::workspace_write(vec![
        standardcode_sandbox::policy::RootPath::real(dir.join("ws")),
    ]))
    .unwrap();
    let mut srv = Server::spawn();
    // ① root 内成功
    srv.send(&Frame::request(
        51,
        "fsWrite",
        json!({"path": dir.join("ws/a.txt").to_string_lossy(), "content": "in-root", "policy": policy}),
    ));
    let (term, _) = srv.settle(51);
    assert_eq!(
        term["payload"]["result"]["exitCode"], 0,
        "root 内写应成：{term}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("ws/a.txt")).unwrap(),
        "in-root"
    );
    // ② root 外失败（EROFS）
    let out = dir.join("out-of-root.txt");
    srv.send(&Frame::request(
        52,
        "fsWrite",
        json!({"path": out.to_string_lossy(), "content": "nope", "policy": policy}),
    ));
    let (term, _) = srv.settle(52);
    let code = term["payload"]["result"]["exitCode"].as_i64().unwrap_or(0);
    assert_ne!(code, 0, "root 外 fsWrite 必须失败");
    assert!(!out.exists(), "宿主面零落盘（越界内容未写入）");
    srv.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[test]
fn serve_workspace_write_run_real_isolation_mac() {
    // CI macos-latest 实跑面（sandbox-exec 恒在位，无 skip-guard）。
    let dir = std::env::temp_dir().join(format!("wp03-mac-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let mut srv = Server::spawn();
    let policy = serde_json::to_value(SandboxPolicy::workspace_write(vec![
        standardcode_sandbox::policy::RootPath::real(dir.join("ws")),
    ]))
    .unwrap();
    let exec = json!({
        "program": "/bin/sh",
        "args": ["-c", "echo hi > inside.txt && touch ../outside.txt"],
        "cwd": dir.join("ws").to_string_lossy(),
        "env": {"PATH": "/bin:/usr/bin"},
    });
    srv.send(&Frame::request(
        61,
        "run",
        json!({"exec": exec, "policy": policy}),
    ));
    let (term, _events) = srv.settle(61);
    assert_ne!(
        term["payload"]["result"]["exitCode"].as_i64().unwrap(),
        0,
        "ws 内写成功但越界 touch 必须失败（同命令两效应）"
    );
    assert!(dir.join("ws/inside.txt").exists(), "ws 内写应成");
    assert!(!dir.join("outside.txt").exists(), "越界零落盘");
    srv.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

/// PathBuf 使用面占位（防 unused import 告警——部分 cfg 臂未用）。
#[allow(dead_code)]
fn _path_use(_: &PathBuf) {}
