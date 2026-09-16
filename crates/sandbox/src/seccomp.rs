//! cBPF seccomp 过滤器（Linux 阶段 2 装载；形制对位参考报告 §1.5 两模式之 Restricted：
//! 默认 ALLOW + 命中 RET_ERRNO(EPERM)，socket/socketpair 仅 AF_UNIX 放行，ptrace/process_vm/
//! io_uring 无条件拒——`recvfrom` 刻意放行对位 codex"cargo clippy socketpair 子进程管理"注
//! （参考报告 §1.5 行 198-201）。Landlock 不用（教训清单"命名错位"）。
//!
//! [自定] 手拼指令（libc 不导出 BPF_* 宏组）：内核 classic-BPF ABI 常量稳定，逐一定义+单元自证
//! （程序结构断言：首条 arch 校验/末条 RET ALLOW/黑名单 nr 全在 k 集中）。

use std::ffi::c_void;

// classic BPF 指令编码（linux/bpf_common.h ABI）
const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;
// seccomp-ret 码（uapi linux/filter.h）
const SECCOMP_RET_KILL: u32 = 0x0000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const EPERM: u32 = 1;
// seccomp_data 布局偏移（linux/seccomp.h：__u32 nr; __u32 arch; __u64 ip; __u64 args[6]）
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;
#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00bf; // AUDIT_ARCH_AARCH64

fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

fn jmp(k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter {
        code: BPF_JMP | BPF_JEQ | BPF_K,
        jt,
        jf,
        k,
    }
}

fn deny_syscall(p: &mut Vec<libc::sock_filter>, nr: i64) {
    p.push(jmp(nr as u32, 0, 1)); // 命中→下一条；未中→跳过 RET
    p.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
}

/// socket/socketpair 特判块：arg0(domain)==AF_UNIX 放行（跳过块内 RET），其余 RET_ERRNO。
/// 块体 4 指令（JEQ/LD/JEQ/RET）；非目标 syscall 时 jf=3 自下一条起跳 3 条=整块跳过。
fn deny_non_unix_sockets(p: &mut Vec<libc::sock_filter>, nr: i64) {
    p.push(jmp(nr as u32, 0, 3));
    p.push(stmt(
        BPF_LD | BPF_W | BPF_ABS,
        OFF_ARG0, // domain 参数
    ));
    p.push(jmp(libc::AF_UNIX as u32, 1, 0)); // AF_UNIX→跳 RET（继续）；否则落 RET
    p.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
}

/// 构建过滤器程序（net_allow=false 时含 connect/bind 等黑名单——与 bwrap --unshare-net
/// 双闸；true 时仍保留 ptrace/io_uring 拒集）。
pub fn build_program(net_allow: bool) -> Vec<libc::sock_filter> {
    // 0-2: 架构校验（不符=非本程序预期，KILL——对位 seccomp 最佳实践）；3: 载入 nr
    let mut p: Vec<libc::sock_filter> = vec![
        stmt(BPF_LD | BPF_W | BPF_ABS, OFF_ARCH),
        jmp(AUDIT_ARCH, 1, 0), // 匹配→跳过 KILL
        stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL),
        stmt(BPF_LD | BPF_W | BPF_ABS, OFF_NR),
    ];
    // 无条件拒集（跨进程内存读 + io_uring 旁路面，参考报告 §1.5 行 179-184）
    deny_syscall(&mut p, libc::SYS_ptrace);
    deny_syscall(&mut p, libc::SYS_process_vm_readv);
    deny_syscall(&mut p, libc::SYS_process_vm_writev);
    deny_syscall(&mut p, libc::SYS_io_uring_setup);
    deny_syscall(&mut p, libc::SYS_io_uring_enter);
    deny_syscall(&mut p, libc::SYS_io_uring_register);
    // socket 族：AF_UNIX-only
    deny_non_unix_sockets(&mut p, libc::SYS_socket);
    deny_non_unix_sockets(&mut p, libc::SYS_socketpair);
    if !net_allow {
        for nr in [
            libc::SYS_connect,
            libc::SYS_accept,
            libc::SYS_accept4,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_shutdown,
            libc::SYS_sendto,
            libc::SYS_sendmsg,
            libc::SYS_recvmsg,
            libc::SYS_sendmmsg,
            libc::SYS_recvmmsg,
            libc::SYS_getpeername,
            libc::SYS_getsockname,
        ] {
            deny_syscall(&mut p, nr);
        }
    }
    // 末：默认 ALLOW（参考报告 §1.5"默认 Allow，命中规则返回 EPERM"）
    p.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    p
}

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            b'=' => Some(0),
            _ => None,
        }
    }
    let raw = s.as_bytes();
    if !raw.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    for chunk in raw.chunks(4) {
        let n = (val(chunk[0])? << 18)
            | (val(chunk[1])? << 12)
            | (val(chunk[2])? << 6)
            | val(chunk[3])?;
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// 程序 → 字节流（每指令 8 字节：code LE / jt / jf / pad×2 / k LE——显式布局免 padding 歧义）。
pub fn encode_program(p: &[libc::sock_filter]) -> String {
    let mut bytes = Vec::with_capacity(p.len() * 8);
    for f in p {
        // 内存布局 u16+u8+u8+u32=8 字节（u32 自然对齐于偏移 4，无填充缺口）
        bytes.extend_from_slice(&f.code.to_le_bytes());
        bytes.push(f.jt);
        bytes.push(f.jf);
        bytes.extend_from_slice(&f.k.to_le_bytes());
    }
    b64_encode(&bytes)
}

pub fn decode_program(s: &str) -> Option<Vec<libc::sock_filter>> {
    let bytes = b64_decode(s)?;
    if !bytes.len().is_multiple_of(8) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 8);
    for c in bytes.as_chunks::<8>().0 {
        out.push(libc::sock_filter {
            code: u16::from_le_bytes([c[0], c[1]]),
            jt: c[2],
            jf: c[3],
            k: u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
        });
    }
    // (布局与 encode_program 严格一致)
    Some(out)
}

/// 装载（阶段 2）：prctl(NO_NEW_PRIVS) → seccomp(SET_MODE_FILTER)。失败=Err（调用方
/// fail-closed 退出，绝不带半装状态 exec）。
pub fn install(prog: &[libc::sock_filter]) -> Result<(), String> {
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(format!(
            "prctl(PR_SET_NO_NEW_PRIVS): {}",
            std::io::Error::last_os_error()
        ));
    }
    let fprog = libc::sock_fprog {
        len: prog.len() as u16,
        filter: prog.as_ptr() as *mut libc::sock_filter,
    };
    // SECCOMP_SET_MODE_FILTER=1（libc 老版本缺常量则字面量，ABI 稳定）
    let rc = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            1u32,
            0u32,
            &fprog as *const libc::sock_fprog as *const c_void,
        )
    };
    if rc != 0 {
        return Err(format!(
            "seccomp(SET_MODE_FILTER): {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_structure_invariants() {
        for net in [true, false] {
            let p = build_program(net);
            assert_eq!(p[0].code, BPF_LD | BPF_W | BPF_ABS);
            assert_eq!(p[0].k, OFF_ARCH);
            assert_eq!(p[2].code, BPF_RET | BPF_K);
            assert_eq!(p[2].k, SECCOMP_RET_KILL);
            assert_eq!(p[3].k, OFF_NR);
            let last = p.last().unwrap();
            assert_eq!(last.code, BPF_RET | BPF_K);
            assert_eq!(last.k, SECCOMP_RET_ALLOW);
        }
    }

    #[test]
    fn net_denied_list_present_absent_when_allowed() {
        let ks: Vec<u32> = build_program(false).iter().map(|f| f.k).collect();
        assert!(ks.contains(&(libc::SYS_connect as u32)));
        assert!(ks.contains(&(libc::SYS_bind as u32)));
        let ka: Vec<u32> = build_program(true).iter().map(|f| f.k).collect();
        assert!(!ka.contains(&(libc::SYS_connect as u32)));
        // 无条件拒集两形都在（ptrace/io_uring/AF_UNIX-only socket）
        for k in [
            libc::SYS_ptrace as u32,
            libc::SYS_io_uring_setup as u32,
            libc::SYS_socket as u32,
        ] {
            assert!(ks.contains(&k) && ka.contains(&k), "missing {k}");
        }
        // recvfrom 刻意放行（codex socketpair/clippy 例外，参考报告 §1.5）
        assert!(!ks.contains(&(libc::SYS_recvfrom as u32)));
        assert!(!ka.contains(&(libc::SYS_recvfrom as u32)));
    }

    #[test]
    fn b64_roundtrip_and_pad() {
        let p = build_program(false);
        let s = encode_program(&p);
        let d = decode_program(&s).expect("roundtrip");
        assert_eq!(d.len(), p.len());
        for (a, e) in d.iter().zip(p.iter()) {
            assert_eq!((a.code, a.jt, a.jf, a.k), (e.code, e.jt, e.jf, e.k));
        }
        // 手工向量（RFC4648 标准例）
        assert_eq!(b64_encode(b"abc"), "YWJj");
        assert_eq!(b64_encode(b"a"), "YQ==");
        assert_eq!(b64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(b64_decode("YQ==").unwrap(), b"a");
        assert!(decode_program("!!!").is_none());
    }

    #[test]
    fn jump_offsets_self_consistent() {
        // socket 块：非 socket 时自下一条起 jf=3 跳过 [LD,JEQ,RET] 三条=落到下一条检查
        let p = build_program(false);
        let idx = p
            .iter()
            .position(|f| f.code == (BPF_JMP | BPF_JEQ | BPF_K) && f.k == libc::SYS_socket as u32)
            .unwrap();
        assert_eq!(p[idx].jf, 3);
        assert_eq!(p[idx + 1].k, OFF_ARG0);
        assert_eq!(p[idx + 2].k, libc::AF_UNIX as u32);
        assert_eq!(p[idx + 2].jt, 1);
        assert_eq!(p[idx + 3].code, BPF_RET | BPF_K);
        // 跳过后落在下一条指令（socketpair 检查）
        assert_eq!(p[idx + 4].k, libc::SYS_socketpair as u32);
    }
}
