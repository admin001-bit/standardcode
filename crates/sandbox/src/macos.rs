//! macOS 后端：WP-01 运行时生成 SBPL → `/usr/bin/sandbox-exec -p <profile> -D… -- cmd`
//! 真执行（仅信 /usr/bin 位——PATH 注入防线，参考报告 §1.4 行 56 注原文理由）。
//! 两阶段不需要：seatbelt 由 execve 装载器施加，无先后依赖。
//! 本机（Windows 开发环境）无法真跑=CI macos-latest 实跑（DoD③/⑥ 判据载体）。

use std::process::Stdio;

use crate::compile::{compile, Platform, SandboxType};
use crate::error::RunError;
use crate::exec::{ExecOutput, ExecRequest, PolicyFacts};
use crate::policy::SandboxPolicy;
use crate::run::plain_exec;

/// 顶层别名前缀重写（仅 /tmp /var /etc 三形，含带尾斜杠子路径；纯词法，不触盘）。
fn dealias(s: &str) -> String {
    // -D 参数形：只重写 =号后的值（命令内路径无需重写——内核解析自然对齐 /private）
    if let Some((head, val)) = s.split_once('=') {
        if head.starts_with("-D") {
            return format!("{head}={}", dealias(val));
        }
    }
    for (from, to) in [
        ("/tmp", "/private/tmp"),
        ("/var", "/private/var"),
        ("/etc", "/private/etc"),
    ] {
        if s == from {
            return to.to_string();
        }
        let pre = format!("{from}/");
        if let Some(rest) = s.strip_prefix(&pre) {
            return format!("{to}/{rest}");
        }
    }
    s.to_string()
}

pub fn run(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
) -> Result<ExecOutput, RunError> {
    // 策略闸下沉至平台入口（同 linux.rs 注）
    let mut req = req.clone();
    crate::run::apply_proxy_policy(&mut req.env, policy);
    let compiled = compile(&req, policy, facts, Platform::MacOS)?;
    if compiled.sandbox == SandboxType::None {
        return plain_exec(&req);
    }
    // 顶层系统别名解析（§5.3(3) 教训清单同族：mac /tmp /var /etc 为 /private 之符号链接，
    // CI temp_dir=/var/folders/…；SBPL subpath 比对发生在内核解析后=实路径，参数须同形——
    // 仅重写顶层别名前缀，深链接不解析不跟从〔codex normalize_writable_root 同向，报告 §1.4〕）。
    let argv: Vec<String> = compiled.argv.iter().map(|a| dealias(a.as_str())).collect();
    let out = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(&req.cwd)
        .env_clear()
        .envs(&req.env)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| RunError::Spawn(format!("sandbox-exec 拉起失败（fail-closed）: {e}")))?;
    Ok(ExecOutput {
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(all(test, target_os = "macos"))]
mod integration {
    use super::*;
    use crate::policy::{RootPath, SandboxPolicy};

    #[test]
    fn dealias_top_level_aliases_only() {
        assert_eq!(dealias("/var/folders/x/ws"), "/private/var/folders/x/ws");
        assert_eq!(dealias("/tmp"), "/private/tmp");
        assert_eq!(dealias("/etc/hosts"), "/private/etc/hosts");
        // 深链接位与已实路径不动
        assert_eq!(dealias("/private/var/x"), "/private/var/x");
        assert_eq!(dealias("/usr/bin/sandbox-exec"), "/usr/bin/sandbox-exec");
        assert_eq!(dealias("/varfoo/x"), "/varfoo/x");
        assert_eq!(
            dealias("-DWR0=/var/folders/w/ws"),
            "-DWR0=/private/var/folders/w/ws"
        );
        assert_eq!(dealias("-DWR0=/private/var/x"), "-DWR0=/private/var/x");
    }

    #[test]
    fn mac_real_isolation() {
        let t = std::env::temp_dir().join(format!("sc-sbx-mac-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join("ws/.git/hooks")).unwrap();
        std::fs::create_dir_all(t.join("ws/.standardcode")).unwrap();
        std::fs::write(t.join("ws/.standardcode/settings.json"), b"keep").unwrap();
        let facts = PolicyFacts::exists([
            t.join("ws/.git"),
            t.join("ws/.git/hooks"),
            t.join("ws/.standardcode"),
        ]);
        let pol = SandboxPolicy::workspace_write(vec![RootPath::real(t.join("ws"))]);
        let run_sh = |cmd: &str| {
            run(
                &ExecRequest::new("/bin/sh", vec!["-c".into(), cmd.to_string()], t.join("ws")),
                &pol,
                &facts,
            )
            .expect("sandbox-exec run")
        };
        // 工作区内写 OK
        let o = run_sh(&format!("touch {}/ws/ok", t.display()));
        assert_eq!(o.exit_code, Some(0), "in-root: {}", o.stderr);
        assert!(t.join("ws/ok").exists());
        // 工作区外写被拒（Operation not permitted=seatbelt deny）
        let o = run_sh(&format!("touch {}/outside", t.display()));
        assert_ne!(o.exit_code, Some(0), "outside write must fail");
        assert!((o.stdout + &o.stderr).contains("Operation not permitted"));
        assert!(!t.join("outside").exists());
        // 读保留
        let o = run_sh(&format!(
            "cat {}/ws/.standardcode/settings.json",
            t.display()
        ));
        assert_eq!(o.exit_code, Some(0), "read: {}", o.stdout);
        // 元数据默认禁写（PD 双保险 literal create/unlink 禁 + deny file-write* 经继承节缺失——
        // .standardcode 存在且无根内 allow 覆盖其写？allow file-write* subpath WR0=/ws 覆盖之，
        // 由 PD literal create + RO0(.git/hooks) 补位——.standardcode 本体写=PD 两行拦 create/
        // unlink，但已存在文件的 write 修改（non-create）呢？→(deny file-write-create/unlink)
        // 不拦 write 内容！见下断言若红=SBPL 节需补 (deny file-write* (literal PD))——
        // 设计修正机会：PD 节应含 file-write* literal deny。）
        let o = run_sh(&format!(
            "echo x >> {}/ws/.standardcode/settings.json",
            t.display()
        ));
        assert_ne!(
            o.exit_code,
            Some(0),
            "protected content write must fail: {}",
            o.stdout
        );
        assert_eq!(
            std::fs::read(t.join("ws/.standardcode/settings.json")).unwrap(),
            b"keep"
        );
        // 新建受保护名被拒（PD create 禁）
        let o = run_sh(&format!("touch {}/ws/.git", t.display()));
        assert_ne!(o.exit_code, Some(0), "protected create must fail");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn mac_network_denied_by_default() {
        let t = std::env::temp_dir().join(format!("sc-sbx-macnet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let pol = SandboxPolicy::workspace_write(vec![RootPath::real(&t)]);
        // deny：nc 连 loopback 应失败（deny default 无 network allow）
        let o = run(
            &ExecRequest::new(
                "/usr/bin/nc",
                vec!["-z".into(), "127.0.0.1".into(), "9".into()],
                t.clone(),
            ),
            &pol,
            &PolicyFacts::default(),
        )
        .expect("run");
        assert_ne!(o.exit_code, Some(0), "net must be cut");
        let _ = std::fs::remove_dir_all(&t);
    }
}
