//! WP-03 宿主接线层：stdio 帧协议服务器端（ARCH-008 行 206：TS 宿主 ↔ Rust 沙箱执行器
//! **只允许 stdio JSON，禁 FFI**；帧层=WP-01 `ipc.rs` 复用）。方法面（WP-01 帧层注预告
//! "方法面在 WP-03 宿主接线时定义消费"）[自定]：
//! - `run` params={exec:ExecRequest, policy:SandboxPolicy(wire canonical JSON)} →
//!   平台真沙箱执行（[自定] 同步 one-shot：子进程生命周期全在 backend.spawn 内完成，
//!   stdout/stderr 以 event 帧分块回传（≤64KB/帧，帧闸内全量保真=沙箱层零截断，DoD⑤ 面）），
//!   终帧 response{id, result:{exitCode}}。
//! - `fsWrite` params={path, content(utf8 字符串，与宿主写工具层同语义 [自定]——任意字节
//!   非目标), policy} → 内容经**临时文件**通道（沙箱内子进程可读位：linux/mac /tmp ro-bind/
//!   file-read* 可见、windows temp=roster logon 可读；windows-sys 0.59 不导出
//!   SetHandleInformation，stdin 继承管道写端去继承形不可达——临时文件=等价内容通道且免
//!   双流死锁面，[自定] 登记）注入 `--fs-write` 沙箱内写入（=DoD②"文件写经沙箱"载体）。
//! - `abort` 不支持（[自定] 首版）：中断语义=宿主 kill server——Linux/macOS 由
//!   `--die-with-parent`（bwrap 臂）兜底父亡子亡，Windows 子进程回收=实机回归清单同源。
//!
//! fail-closed 三面（B-12/DoD⑥）：坏帧=终止通道（不跳帧续读）；握手不符=终止；执行层
//! Err=error 帧（宿主必须呈现为执行失败、不得回退未沙箱执行——宿主侧义务，server 永不自行放行）。
//! 并发="池"首形 [自定]：一会话一 server 进程（装配期 lazy 拉起、多请求复用），请求级
//! thread-per-request；teardown=stdin EOF 正常退出（生产 join=false 立即死，子进程 OS 面
//! 回收；测试 join=true 收帧无竞态——[自定] 载体差异）。

use std::collections::BTreeSet;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::RunError;
use crate::exec::ExecRequest;
use crate::ipc::{Frame, FrameCodec, FrameKind};
use crate::policy::{SandboxBackend, SandboxPolicy, SandboxedChild};
use crate::run::run_with_self_exe;

/// event 帧分块上限（字节；64KB 远小于 16MB 帧闸，留信封余量——[自定] 常量）。
pub(crate) const EVENT_CHUNK_BYTES: usize = 64 * 1024;

/// 真平台后端（§5.3(3) 行 258-264 trait 三方法之 WP-03 实装；WP-02 未解决②清偿）。
pub struct NativeBackend {
    pub self_exe: PathBuf,
}

impl SandboxBackend for NativeBackend {
    /// [自定] 同步 one-shot 形：拉起+wait+产物收集一体完成，`SandboxedChild.output` 携结果，
    /// pid 为已退出处之登记值（中断面不走句柄=abort 不支持的同一决策，见模块头）。
    fn spawn(&self, req: &ExecRequest, policy: &SandboxPolicy) -> Result<SandboxedChild, RunError> {
        let facts = probe_facts(policy);
        let (pid, output) = run_with_self_exe(req, policy, &facts, &self.self_exe)?;
        Ok(SandboxedChild {
            pid,
            output: Some(output),
        })
    }

    /// 会话级前置动作钩子位。首版三平台均 no-op [自定]：策略强制全部由请求级
    /// compile argv/令牌形承担（Linux/macOS 无会话态；Windows 对象级 ACL 授予随 run()
    /// per-request 建立并 AclGuard 还原——持久会话级 grant=M5+ 观察项，登记供 V 判）。
    fn apply_policy(&self, _policy: &SandboxPolicy) -> Result<(), RunError> {
        Ok(())
    }

    /// one-shot：wait 已在 spawn 内完成；teardown=资源回收断言位（幂等；fsWrite 临时文件
    /// 清理由 handle_fs_write 的 finally 形负责）。
    fn teardown(&self, _child: SandboxedChild) -> Result<(), RunError> {
        Ok(())
    }
}

/// 就地探测宿主注入事实（WP-01 偏差④"facts 注入载体"之宿主半）：存在集=carveouts 路径
/// 及各根之元数据保护名/read-only 子路径（与 compile 的 mask 消费面对位——形状错配=
/// 遮蔽多给/少给的源头，V 逐路径核对）。elevated 恒 false [自定 承 WP-02 偏差①]：
/// legacy 后端 deny-read 能力闸保持 fail-closed 保守形；提权环境=elevated 路线回归项。
pub fn probe_facts(policy: &SandboxPolicy) -> crate::exec::PolicyFacts {
    let mut exists = BTreeSet::new();
    let mut probe = |p: &PathBuf| {
        if std::path::Path::new(p).exists() {
            exists.insert(p.clone());
        }
    };
    for (p, _) in &policy.fs.carveouts {
        probe(p);
    }
    for r in &policy.fs.writable_roots {
        for name in &policy.fs.metadata.protected_names {
            probe(&r.path.join(name));
        }
        for rel in &policy.fs.metadata.read_only_subpaths {
            probe(&r.path.join(rel));
        }
    }
    crate::exec::PolicyFacts {
        exists,
        elevated: false,
    }
}

/// 字符串按 ≤cap 字节切块（UTF-8 char 边界安全——event 帧 JSON 编码要求完整字符）。
pub(crate) fn split_chunks(s: &str, cap: usize) -> Vec<String> {
    if s.len() <= cap {
        return if s.is_empty() {
            vec![]
        } else {
            vec![s.to_string()]
        };
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if cur.len() + ch.len_utf8() > cap && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `run` 方法参数（ExecRequest+SandboxPolicy 皆 serde 形，与 windows wire 同源 schema）。
#[derive(Debug, Deserialize)]
struct RunParams {
    exec: ExecRequest,
    policy: SandboxPolicy,
}

/// `fsWrite` 方法参数。content=utf8 字符串（宿主写工具层同语义 [自定]）。
#[derive(Debug, Deserialize)]
struct FsWriteParams {
    path: String,
    content: String,
    policy: SandboxPolicy,
}

type Out = Arc<Mutex<BufWriter<Box<dyn Write + Send>>>>;

fn send(out: &Out, frame: Frame) {
    let bytes = match crate::ipc::FrameCodec::encode(&frame) {
        Ok(b) => b,
        Err(e) => {
            // 本地编码失败（非宿主输入面）：协议事故级，尽力上报一行纯文本后放弃该帧。
            eprintln!("frame encode failed: {e}");
            return;
        }
    };
    let mut g = match out.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    // encode 自带 `\n` 定界（ipc.rs 行 169-172），不重复推入。
    let _ = g.write_all(&bytes).and_then(|()| g.flush());
}

fn failure(out: &Out, id: u64, err: &RunError) {
    let code = match err {
        RunError::Compile(_) => "compile_rejected",
        RunError::Spawn(_) => "spawn_failed",
        RunError::Inner(_) => "inner_error",
        RunError::Io(_) => "io_error",
        RunError::Privilege(_) => "privilege_missing",
    };
    send(out, Frame::failure(id, code, &err.to_string()));
}

/// 子进程输出→event 帧（run/fsWrite 共用）。
fn emit_output(out: &Out, id: u64, o: &crate::exec::ExecOutput) {
    for (stream, text) in [("stdout", &o.stdout), ("stderr", &o.stderr)] {
        for chunk in split_chunks(text, EVENT_CHUNK_BYTES) {
            send(
                out,
                Frame::event(
                    "output",
                    json!({"reqId": id, "stream": stream, "data": chunk}),
                ),
            );
        }
    }
}

fn dispatch_request(
    backend: Arc<NativeBackend>,
    out: Out,
    threads: &Arc<Mutex<Vec<std::thread::JoinHandle<()>>>>,
    id: u64,
    payload: Value,
) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    let inner = payload.get("params").cloned().unwrap_or(Value::Null);
    let (b, o) = (Arc::clone(&backend), Arc::clone(&out));
    let handle = match method {
        "run" => std::thread::spawn(move || handle_run(b, o, id, inner)),
        "fsWrite" => std::thread::spawn(move || handle_fs_write(b, o, id, inner)),
        other => {
            send(
                &out,
                Frame::failure(id, "unknown_method", &format!("unknown method: {other}")),
            );
            return;
        }
    };
    threads.lock().unwrap().push(handle);
}

fn handle_run(backend: Arc<NativeBackend>, out: Out, id: u64, inner: Value) {
    let p: RunParams = match serde_json::from_value(inner) {
        Ok(p) => p,
        Err(e) => {
            send(&out, Frame::failure(id, "bad_params", &e.to_string()));
            return;
        }
    };
    if let Err(e) = backend.apply_policy(&p.policy) {
        failure(&out, id, &e);
        return;
    }
    match backend.spawn(&p.exec, &p.policy) {
        Ok(child) => {
            let child_pid = child.pid;
            match &child.output {
                Some(o) => {
                    let exit_code = o.exit_code;
                    emit_output(&out, id, o);
                    let _ = backend.teardown(SandboxedChild {
                        pid: child_pid,
                        output: None,
                    });
                    send(&out, Frame::response(id, json!({"exitCode": exit_code})));
                }
                None => send(&out, Frame::failure(id, "inner_error", "后端未产出一象")),
            }
        }
        Err(e) => failure(&out, id, &e),
    }
}

fn handle_fs_write(backend: Arc<NativeBackend>, out: Out, id: u64, inner: Value) {
    let p: FsWriteParams = match serde_json::from_value(inner) {
        Ok(p) => p,
        Err(e) => {
            send(&out, Frame::failure(id, "bad_params", &e.to_string()));
            return;
        }
    };
    // 内容经临时文件注入（模块头理由）；沙箱内子进程读 temp 写目标=策略强制面完整保留。
    let temp =
        std::env::temp_dir().join(format!("standardcode-fsw-{}-{id}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&temp, p.content.as_bytes()) {
        send(
            &out,
            Frame::failure(id, "io_error", &format!("temp write: {e}")),
        );
        return;
    }
    let req = ExecRequest::new(
        backend.self_exe.clone(),
        vec![
            "--fs-write".to_string(),
            p.path.clone(),
            "--from".to_string(),
            temp.to_string_lossy().into_owned(),
        ],
        std::env::temp_dir(),
    );
    let result = backend.spawn(&req, &p.policy);
    let _ = std::fs::remove_file(&temp); // finally 形：成功失败都清
    match result {
        Ok(child) => {
            let exit_code = child.output.as_ref().and_then(|o| o.exit_code);
            if let Some(o) = &child.output {
                emit_output(&out, id, o);
            }
            send(&out, Frame::response(id, json!({"exitCode": exit_code})));
        }
        Err(e) => failure(&out, id, &e),
    }
}

/// 沙箱内写入原语（bin `--fs-write <path> --from <tempfile>`，bin 已剥前两位）：
/// 读 temp 全量→mkdir -p 父目录→写目标（覆盖形=宿主 execWrite 同语义）。纯 std、零特权。
pub fn fs_write_main(args: &[String]) -> i32 {
    let usage = || eprintln!("usage: --fs-write <path> --from <file>");
    if args.len() != 3 || args[1] != "--from" {
        usage();
        return 2;
    }
    let (path, from) = (&args[0], &args[2]);
    let bytes = match std::fs::read(from) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {from}: {e}");
            return 1;
        }
    };
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("mkdir {}: {e}", parent.display());
                return 1;
            }
        }
    }
    if let Err(e) = std::fs::write(&target, bytes) {
        eprintln!("write {path}: {e}");
        return 1;
    }
    0
}

/// 帧协议主循环（生产入口：真 stdio，join_on_eof=false。Stdout 全局锁 Send ✓）。
pub fn serve() -> i32 {
    let stdin = std::io::stdin();
    serve_with(stdin.lock(), Box::new(std::io::stdout()), false)
}

/// 可注入形态（测试载体：内存 stdio+join=true 收帧无竞态）。
pub fn serve_with(input: impl BufRead, output: Box<dyn Write + Send>, join_on_eof: bool) -> i32 {
    serve_with_exe(
        input,
        output,
        join_on_eof,
        std::env::current_exe().expect("current_exe"),
    )
}

fn serve_with_exe(
    input: impl BufRead,
    output: Box<dyn Write + Send>,
    join_on_eof: bool,
    exe: PathBuf,
) -> i32 {
    let out: Out = Arc::new(Mutex::new(BufWriter::new(output)));
    let threads: Arc<Mutex<Vec<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
    // hello 握手（客户端发起；版本不符/非 hello=error 帧后终止通道——fail-closed）。
    let mut lines = input.lines();
    let first = match lines.next() {
        Some(Ok(l)) => l,
        _ => return 0, // 立即 EOF=空会话，正常退出
    };
    let frame = match FrameCodec::decode(first.as_bytes()) {
        Ok(f) => f,
        Err(e) => {
            send(&out, Frame::failure(0, "frame_reject", &e.to_string()));
            return 2;
        }
    };
    if frame.kind != FrameKind::Hello || Frame::check_hello(&frame).is_err() {
        send(
            &out,
            Frame::failure(0, "handshake_rejected", "首帧必须为版本相符的 hello"),
        );
        return 2;
    }
    send(&out, Frame::hello());

    let backend = Arc::new(NativeBackend { self_exe: exe });
    for line in lines {
        let Ok(line) = line else { break };
        let frame = match FrameCodec::decode(line.as_bytes()) {
            Ok(f) => f,
            Err(e) => {
                // 坏帧=终止（不跳帧续读——半途坏流继续=被劫持面，ipc.rs 模块纪律同形）。
                send(&out, Frame::failure(0, "frame_reject", &e.to_string()));
                return 2;
            }
        };
        match frame.kind {
            FrameKind::Hello => send(&out, Frame::hello()),
            FrameKind::Request => {
                let Some(id) = frame.id else {
                    send(&out, Frame::failure(0, "bad_envelope", "request 帧缺 id"));
                    continue;
                };
                match frame.payload {
                    Some(payload) => dispatch_request(
                        Arc::clone(&backend),
                        Arc::clone(&out),
                        &threads,
                        id,
                        payload,
                    ),
                    None => send(
                        &out,
                        Frame::failure(id, "bad_envelope", "request 帧缺 payload"),
                    ),
                }
            }
            other => {
                let id = frame.id.unwrap_or(0);
                send(
                    &out,
                    Frame::failure(
                        id,
                        "bad_envelope",
                        &format!("server 不接受 {other:?} 型入站帧"),
                    ),
                );
            }
        }
    }
    // stdin EOF：宿主断连=会话结束。生产=立即退出（Linux/macOS 沙箱子进程由
    // --die-with-parent/进程组语义兜底；Windows 回收=实机回归清单，BLK-04=① 同源）；
    // 测试=join 收束活跃请求线程（帧序确定可断言）。
    if join_on_eof {
        let handles = std::mem::take(&mut *threads.lock().unwrap());
        for h in handles {
            let _ = h.join();
        }
    }
    let _ = out.lock().map(|mut g| g.flush());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{RootPath, SandboxPolicy};
    use std::io::Cursor;

    fn hello_line() -> String {
        let f = Frame::hello();
        // encode 自带行尾 `\n`（FrameCodec::encode 末两行），勿再追加（双换行=空行坏帧）。
        String::from_utf8(crate::ipc::FrameCodec::encode(&f).unwrap()).unwrap()
    }

    fn request_line(id: u64, method: &str, params: Value) -> String {
        let f = Frame::request(id, method, params);
        String::from_utf8(crate::ipc::FrameCodec::encode(&f).unwrap()).unwrap()
    }

    /// 测试 stdio：内存双向+join 收束（exe=真实 bin，--fs-write 走它）。
    fn serve_rc_and_frames(input: &str) -> (i32, Vec<Value>) {
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // exe 占位不参与本组测试（bad_params/unknown/frame_reject/handshake 皆不触 spawn
        // 面；真 spawn 形=集成测载体 tests/，CARGO_BIN_EXE 只对 integration target 注入）。
        let rc = serve_with_exe(
            Cursor::new(input.as_bytes().to_vec()),
            Box::new(Sink(Arc::clone(&sink))),
            true,
            PathBuf::from("unused-serve-test-exe"),
        );
        let text = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        (
            rc,
            text.lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect(),
        )
    }

    #[test]
    fn split_chunks_respects_char_boundary() {
        let s = "é".repeat(10); // 2 字节/char
        let c = split_chunks(&s, 3);
        assert_eq!(c.len(), 10, "3 字节上限下每块至多 1 char（2≤3<4）");
        assert_eq!(c.concat(), s, "块序拼接=原文（保真断言）");
        assert_eq!(split_chunks("", 10), Vec::<String>::new());
        assert_eq!(split_chunks("abc", 10), vec!["abc".to_string()]);
    }

    #[test]
    fn unknown_method_replies_error_and_session_continues() {
        let input = format!("{}{}", hello_line(), request_line(1, "nope", json!({})));
        let (rc, frames) = serve_rc_and_frames(&input);
        assert_eq!(rc, 0, "非坏帧路径正常结束");
        assert_eq!(frames[0]["kind"], "hello", "握手回应先行");
        assert_eq!(frames[1]["kind"], "error");
        assert_eq!(frames[1]["payload"]["code"], "unknown_method");
        assert_eq!(frames[1]["id"], 1);
    }

    #[test]
    fn bad_frame_terminates_channel() {
        // 握手后坏帧：error(frame_reject) 且通道终止（后续好帧不再处理）。
        let input = format!(
            "{}NOT-JSON\n{}",
            hello_line(),
            request_line(2, "run", json!({}))
        );
        let (rc, frames) = serve_rc_and_frames(&input);
        assert_eq!(rc, 2, "坏帧=非零退出（fail-closed 终止）");
        assert_eq!(frames.len(), 2, "hello 回+一条 error，坏帧后不续读");
        assert_eq!(frames[1]["payload"]["code"], "frame_reject");
    }

    #[test]
    fn handshake_rejects_non_hello_first_frame() {
        let input = request_line(1, "run", json!({}));
        let (rc, frames) = serve_rc_and_frames(&input);
        assert_eq!(rc, 2);
        assert_eq!(frames[0]["payload"]["code"], "handshake_rejected");
    }

    #[test]
    fn fs_write_bad_params_replies_error() {
        // fsWrite 帧经 dispatch 到参数校验面（缺字段 → bad_params error 帧，非 panic）。
        let input = format!(
            "{}{}",
            hello_line(),
            request_line(7, "fsWrite", json!({"nope": 1}))
        );
        let (rc, frames) = serve_rc_and_frames(&input);
        assert_eq!(rc, 0);
        let err = &frames[1];
        assert_eq!(err["payload"]["code"], "bad_params");
        assert_eq!(err["id"], 7);
    }

    #[test]
    fn fs_write_main_writes_with_parent_creation() {
        let t = std::env::temp_dir().join(format!("fsw-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let from = t.join("payload");
        std::fs::write(&from, b"hello-sandbox").unwrap();
        let target = t.join("deep/nested/out.txt");
        let rc = fs_write_main(&[
            target.to_string_lossy().into_owned(),
            "--from".to_string(),
            from.to_string_lossy().into_owned(),
        ]);
        assert_eq!(rc, 0);
        assert_eq!(std::fs::read(&target).unwrap(), b"hello-sandbox");
        // 覆盖形（execWrite 同语义）
        std::fs::write(&from, b"v2").unwrap();
        assert_eq!(
            fs_write_main(&[
                target.to_string_lossy().into_owned(),
                "--from".to_string(),
                from.to_string_lossy().into_owned(),
            ]),
            0
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"v2");
        // 坏形参=usage 退出 2（不 panic）
        assert_eq!(fs_write_main(&["only".to_string()]), 2);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn probe_facts_collects_carveout_and_metadata_shapes() {
        let t = std::env::temp_dir().join(format!("probe-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join(".git")).unwrap(); // 存在=收；.standardcode 不建=不收
        let mut policy = SandboxPolicy::workspace_write(vec![RootPath::real(t.clone())]);
        policy.fs.carveouts.push((
            PathBuf::from("/nonexistent-carveout-zz"),
            crate::policy::Access::ReadOnly,
        ));
        let facts = probe_facts(&policy);
        assert!(facts.exists.contains(&t.join(".git")));
        assert!(!facts.exists.contains(&t.join(".standardcode")));
        assert!(!facts
            .exists
            .contains(&PathBuf::from("/nonexistent-carveout-zz")));
        assert!(!facts.elevated);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn response_error_event_kinds_roundtrip_through_codec() {
        // 服务器出站帧全型经 encode/decode 往返（TS 端镜像解析的判据基线）。
        for f in [
            Frame::hello(),
            Frame::response(3, json!({"exitCode": 0})),
            Frame::failure(4, "privilege_missing", "无特权"),
            Frame::event(
                "output",
                json!({"reqId": 5, "stream": "stdout", "data": "x"}),
            ),
        ] {
            let bytes = crate::ipc::FrameCodec::encode(&f).unwrap();
            assert_eq!(FrameCodec::decode(&bytes).unwrap(), f);
        }
    }
}
