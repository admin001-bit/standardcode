//! `standardcode-sandbox` 可执行入口。
//!
//! 子命令面：
//! - （默认/无参）usage。
//! - `--inner-seccomp --filter-b64 <b64> -- <program> [args…]`：**Linux 阶段 2**——bwrap
//!   命名空间内被自身调用（两阶段设计，参考报告 §1.5：seccomp 必须在文件系统视图建立之后安装）。
//!   装过滤器前先 capabilities 清零断言 fail-hard（§5.3(3) 行 266）。
//! - `--probe-socket`：测试探针（真跑 socket(AF_INET)/AF_UNIX 并打印结果，退出码=AF_INET 成败），
//!   供集成测作为沙箱内程序，零外部依赖。
//! - `--serve`：**WP-03 帧协议服务器端**（stdio JSON v5；run/fsWrite 方法面见 serve.rs——
//!   ARCH-008：TS 宿主唯一通道，一会话一进程多请求复用）。
//! - `--fs-write <path> --from <file>`：沙箱内写入原语（fsWrite 方法=策略化的自身调用）。

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = dispatch(&args);
    std::process::exit(code);
}

fn dispatch(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        #[cfg(target_os = "linux")]
        Some("--inner-seccomp") => standardcode_sandbox::linux::inner_main(&args[1..]),
        #[cfg(target_os = "linux")]
        Some("--probe-socket") => standardcode_sandbox::linux::probe_socket(),
        Some("--serve") => standardcode_sandbox::serve::serve(),
        Some("--fs-write") => standardcode_sandbox::serve::fs_write_main(&args[1..]),
        Some(other) => {
            eprintln!("unknown mode: {other}");
            usage();
            2
        }
        None => {
            usage();
            2
        }
    }
}

fn usage() {
    eprintln!(
        "usage:\n  \
         standardcode-sandbox --inner-seccomp --filter-b64 <b64> -- <program> [args...]\n  \
         standardcode-sandbox --probe-socket\n  \
         standardcode-sandbox --serve\n  \
         standardcode-sandbox --fs-write <path> --from <file>"
    );
}
