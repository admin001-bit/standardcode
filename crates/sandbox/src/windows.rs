//! Windows 后端（首版=legacy 非 elevated 能力面；elevated/deny-read 推后——§5.3(3) 教训清单
//! "Windows deny-read 需 elevated"，compile 层已 fail-closed 拒该面）：
//! **受限令牌（CreateRestrictedToken：DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED）
//! + ACL（capability SID 每 run 临时随机；可写根授可继承 allow、元数据路径设对象级 deny）**。
//!
//! 形制对位参考报告 §1.6：restricting 名单访问检查=交集形——本机线程模拟档实证
//! **读亦对照名单**（win.ini 仅 Users 授权对象读拒/everyone-R 对象读通），与报告行 444-448
//! "consults only for writes"字面存在未对质分歧且线程档混入模拟级别效应 [自定观察登记]——
//! 读档终判=子进程面 CI 证据（R1 门）。写闸：capability-allow 对象可写/其余拒（探针实证）；
//! deny ACE 压过继承 allow（元数据保护形）。restricting=[cap,logon,everyone]（Codex 行 461
//! 序硬约定；三员为 everyone/logon 授权对象读权限恢复之必要形）。
//! 子进程 CreateProcessAsUserW 需 SeAssignPrimaryToken/SeIncreaseQuota：CI runner=admin 在位；
//! 本地非提权返回 RunError::Privilege——同模块**线程探针**（SetThreadToken）本地覆盖
//! 令牌+ACL 语义全判据，CI 补子进程全链。
//! capability SID 不落盘持久（Codex cap_sid 持久化=多会话复用面；本卡每 run 临时、
//! AclGuard drop 还原原显式 DACL 即无痕——[自定] 登记）。

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, WIN32_ERROR};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    SE_FILE_OBJECT, TRUSTEE_IS_GROUP, TRUSTEE_IS_SID, TRUSTEE_W,
};
use windows_sys::Win32::Security::Cryptography::BCryptGenRandom;
use windows_sys::Win32::Security::{
    AllocateAndInitializeSid, CreateRestrictedToken, FreeSid, GetTokenInformation, TokenGroups,
    ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES,
    SID_IDENTIFIER_AUTHORITY, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_QUERY,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};

use crate::compile::{compile, Platform, SandboxType};
use crate::error::RunError;
use crate::exec::{ExecOutput, ExecRequest, PolicyFacts};
use crate::policy::SandboxPolicy;
use crate::run::plain_exec;

#[cfg(test)]
use windows_sys::Win32::Security::{
    DuplicateTokenEx, SecurityImpersonation, TokenImpersonation, TOKEN_IMPERSONATE,
};

// winterns ABI 常量（windows-sys 未导出者）
const DISABLE_MAX_PRIVILEGE: u32 = 0x0000_0001;
const LUA_TOKEN: u32 = 0x0000_0002;
const WRITE_RESTRICTED: u32 = 0x0000_0004;
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
/// deny 掩码=写族位（WRITE_RESTRICTED 只管写，deny ACE 亦只管写族——含读位会误伤
/// "全盘可读"档：FILE_WRITE_DATA|APPEND|WRITE_EA|WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER）
const WRITE_FAMILY_MASK: u32 = 0x2 | 0x4 | 0x10 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const ERROR_PRIVILEGE_NOT_HELD: WIN32_ERROR = 1312;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 临时 capability SID：S-1-15-<rand32>（SECURITY_CAPABILITIES_AUTHORITY=15 单子授权；随机源
/// BCryptGenRandom——对位 Codex make_random_cap_sid_string 的随机性要求，参考报告 §1.6）。
struct CapSid {
    psid: *mut c_void,
}

impl CapSid {
    fn new() -> Result<Self, RunError> {
        let mut rnd = [0u8; 4];
        let st = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                rnd.as_mut_ptr(),
                rnd.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if st < 0 {
            return Err(RunError::Spawn("BCryptGenRandom 失败".into()));
        }
        let authority = SID_IDENTIFIER_AUTHORITY {
            Value: [0, 0, 0, 0, 0, 15],
        };
        let mut psid: *mut c_void = std::ptr::null_mut();
        let ok = unsafe {
            AllocateAndInitializeSid(
                &authority,
                1,
                u32::from_le_bytes(rnd),
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut psid,
            )
        };
        if ok == 0 || psid.is_null() {
            return Err(RunError::Spawn("AllocateAndInitializeSid 失败".into()));
        }
        Ok(Self { psid })
    }
}

impl Drop for CapSid {
    fn drop(&mut self) {
        if !self.psid.is_null() {
            unsafe { FreeSid(self.psid) };
        }
    }
}

/// restricting 名单成员（Codex 顺序硬约定 Capabilities→Logon→Everyone，参考报告 §1.6
/// 行 461——本机实证：访问检查（含读）对照 restricting 名单，单员 cap 会连读一并拒；
/// Logon/Everyone 入列恢复普通读档。ExtraRestricting 位无需求）。
struct TokenSids {
    cap: CapSid,
    _keepalive: Vec<u8>, // groups_buf + everyone_buf 合并持有（logon/everyone 指针借用其内）
    logon: *mut c_void,
    everyone: *mut c_void,
}

fn collect_sids() -> Result<TokenSids, RunError> {
    const SE_GROUP_LOGON_MASK: u32 = 0xC000_0000; // SE_GROUP_LOGON_ID（SystemServices i32 常量的 u32 形）
    unsafe {
        let cap = CapSid::new()?;
        let mut cur: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut cur) == 0 {
            return Err(RunError::Spawn(format!(
                "OpenProcessToken(query) gle={}",
                GetLastError()
            )));
        }
        let mut need: u32 = 0;
        GetTokenInformation(cur, TokenGroups, std::ptr::null_mut(), 0, &mut need);
        let mut buf = vec![0u8; need.max(1) as usize];
        let ok = GetTokenInformation(
            cur,
            TokenGroups,
            buf.as_mut_ptr() as *mut c_void,
            need,
            &mut need,
        );
        CloseHandle(cur);
        if ok == 0 {
            return Err(RunError::Spawn("GetTokenInformation 失败".into()));
        }
        let tg = &*(buf.as_ptr() as *const TOKEN_GROUPS);
        let groups = std::slice::from_raw_parts(tg.Groups.as_ptr(), tg.GroupCount as usize);
        let logon = groups
            .iter()
            .find(|g| g.Attributes & SE_GROUP_LOGON_MASK == SE_GROUP_LOGON_MASK)
            .map(|g| g.Sid as *mut _)
            .ok_or_else(|| RunError::Spawn("Logon SID 未找到".into()))?;
        // Everyone=S-1-1-0
        let world_authority = SID_IDENTIFIER_AUTHORITY {
            Value: [0, 0, 0, 0, 0, 1],
        };
        let mut everyone: *mut c_void = std::ptr::null_mut();
        if AllocateAndInitializeSid(&world_authority, 1, 0, 0, 0, 0, 0, 0, 0, 0, &mut everyone) == 0
        {
            FreeSid(everyone);
            return Err(RunError::Spawn(
                "AllocateAndInitializeSid(Everyone) 失败".into(),
            ));
        }
        // everyone 为进程级缓存常量？——FreeSid 需留到 TokenSids drop；借用危险：
        // AllocateAndInitializeSid 返回的是独立 SID 缓冲，自由释放。持有 Vec 仅管 groups_buf；
        // everyone 单独存字段释放。
        Ok(TokenSids {
            cap,
            _keepalive: buf,
            logon,
            everyone,
        })
    }
}

impl Drop for TokenSids {
    fn drop(&mut self) {
        if !self.everyone.is_null() {
            unsafe { FreeSid(self.everyone) };
        }
    }
}

fn build_restricted_token(ids: &TokenSids) -> Result<HANDLE, RunError> {
    unsafe {
        let mut cur: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut cur) == 0 {
            return Err(RunError::Spawn(format!(
                "OpenProcessToken gle={}",
                GetLastError()
            )));
        }
        let restrictions = [
            SID_AND_ATTRIBUTES {
                Sid: ids.cap.psid,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: ids.logon as *mut _,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: ids.everyone as *mut _,
                Attributes: 0,
            },
        ];
        let mut token: HANDLE = std::ptr::null_mut();
        let ok = CreateRestrictedToken(
            cur,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            restrictions.len() as u32,
            restrictions.as_ptr(),
            &mut token,
        );
        CloseHandle(cur);
        if ok == 0 {
            return Err(RunError::Spawn(format!(
                "CreateRestrictedToken gle={}",
                GetLastError()
            )));
        }
        Ok(token)
    }
}

/// 根 DACL 装载凭据：drop 时还原原显式 DACL 并释放查询所得 security descriptor。
struct AclGuard {
    path: String,
    original_dacl: *mut ACL,
    sd: PSECURITY_DESCRIPTOR,
}

impl Drop for AclGuard {
    fn drop(&mut self) {
        unsafe {
            let wp = wide(&self.path);
            SetNamedSecurityInfoW(
                wp.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                self.original_dacl as *const ACL,
                std::ptr::null(),
            );
            if !self.sd.is_null() {
                LocalFree(self.sd as _);
            }
        }
    }
}

fn trustee(psid: *mut c_void) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: windows_sys::Win32::Security::Authorization::NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_GROUP,
        ptstrName: psid as *mut u16,
    }
}

fn access_entry(psid: *mut c_void, deny: bool, inherit: u32) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: if deny {
            WRITE_FAMILY_MASK
        } else {
            FILE_ALL_ACCESS
        },
        grfAccessMode: if deny {
            windows_sys::Win32::Security::Authorization::DENY_ACCESS
        } else {
            windows_sys::Win32::Security::Authorization::SET_ACCESS
        },
        grfInheritance: inherit,
        Trustee: trustee(psid),
    }
}

/// 根对象：以原显式 DACL 为基追加 [cap allow (OI|CI)]，返回还原凭据。
/// 不设 SE_DACL_PROTECTED（继承 allow 无害：写闸只对照 restricting SIDs）。
fn grant_allow(root: &Path, cap: &CapSid) -> Result<AclGuard, RunError> {
    let path = root.to_string_lossy().into_owned();
    let wp = wide(&path);
    unsafe {
        let mut owner: *mut c_void = std::ptr::null_mut();
        let mut group: *mut c_void = std::ptr::null_mut();
        let mut orig_dacl: *mut ACL = std::ptr::null_mut();
        let mut orig_sacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            wp.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut orig_dacl,
            &mut orig_sacl,
            &mut sd,
        );
        if rc != 0 {
            return Err(RunError::Spawn(format!(
                "GetNamedSecurityInfoW({path}) rc={rc}"
            )));
        }
        let entries = [access_entry(
            cap.psid,
            false,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        )];
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let rc = SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            orig_dacl,
            &mut new_dacl,
        );
        if rc != 0 {
            LocalFree(sd as _);
            return Err(RunError::Spawn(format!("SetEntriesInAclW rc={rc}")));
        }
        let rc = SetNamedSecurityInfoW(
            wp.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl as *const ACL,
            std::ptr::null(),
        );
        LocalFree(new_dacl as _);
        if rc != 0 {
            LocalFree(sd as _);
            return Err(RunError::Spawn(format!(
                "SetNamedSecurityInfoW({path}) rc={rc}"
            )));
        }
        Ok(AclGuard {
            path,
            original_dacl: orig_dacl,
            sd,
        })
    }
}

/// 保护路径对象级 deny（既有对象显式 deny；子对象经 (OI|CI) 传播——deny 位压过继承 allow）。
/// 返回还原 guard（R5 清偿：与根 grant_allow 对称，drop 即还原原显式 DACL）。
fn set_deny(path: &Path, cap: &CapSid) -> Result<AclGuard, RunError> {
    let pstr = path.to_string_lossy().into_owned();
    let wp = wide(&pstr);
    unsafe {
        let mut owner: *mut c_void = std::ptr::null_mut();
        let mut group: *mut c_void = std::ptr::null_mut();
        let mut orig_dacl: *mut ACL = std::ptr::null_mut();
        let mut orig_sacl: *mut ACL = std::ptr::null_mut();
        let mut sd: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            wp.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut orig_dacl,
            &mut orig_sacl,
            &mut sd,
        );
        if rc != 0 {
            return Err(RunError::Spawn(format!(
                "GetNamedSecurityInfoW({pstr}) rc={rc}"
            )));
        }
        let entries = [access_entry(
            cap.psid,
            true,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        )];
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let rc = SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), orig_dacl, &mut dacl);
        if rc != 0 {
            LocalFree(sd as _);
            return Err(RunError::Spawn(format!("SetEntriesInAclW(deny) rc={rc}")));
        }
        let rc = SetNamedSecurityInfoW(
            wp.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl as *const ACL,
            std::ptr::null(),
        );
        LocalFree(dacl as _);
        if rc != 0 {
            LocalFree(sd as _);
            return Err(RunError::Spawn(format!(
                "SetNamedSecurityInfoW(deny {}) rc={rc}",
                path.display()
            )));
        }
        Ok(AclGuard {
            path: pstr,
            original_dacl: orig_dacl,
            sd,
        })
    }
}

/// 元数据保护对象集（预建缺失名=补"父目录 allow 即可 mkdir .git"洞——ACL 无名字过滤器，
/// 预建空目录+对象级 deny 形；读见空目录 [自定] 登记）。
fn protected_paths(policy: &SandboxPolicy) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    for r in &policy.fs.writable_roots {
        for n in &policy.fs.metadata.protected_names {
            out.insert(r.path.join(n));
        }
        for rel in &policy.fs.metadata.read_only_subpaths {
            out.insert(r.path.join(rel));
        }
    }
    out
}

fn env_block(env: &BTreeMap<String, String>) -> Vec<u16> {
    let mut v: Vec<u16> = Vec::new();
    for (k, val) in env {
        v.extend(wide(&format!("{k}={val}")));
    }
    v.push(0);
    v
}

/// 真执行：令牌+ACL+CreateProcessAsUserW（同步等待，捕获双管道）。
pub fn run(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
) -> Result<ExecOutput, RunError> {
    // 策略闸下沉至平台入口（同 linux.rs 注；WFP 面=elevated 后端不做，登记偏差）
    let mut req = req.clone();
    crate::run::apply_proxy_policy(&mut req.env, policy);
    let compiled = compile(&req, policy, facts, Platform::Windows)?;
    if compiled.sandbox == SandboxType::None {
        return plain_exec(&req);
    }
    let ids = collect_sids()?;
    let token = build_restricted_token(&ids)?;
    let protected = protected_paths(policy);
    let mut guards = Vec::new();
    for p in &protected {
        if !p.exists() {
            std::fs::create_dir_all(p).ok();
        }
        guards.push(set_deny(p, &ids.cap)?);
    }
    for r in &policy.fs.writable_roots {
        guards.push(grant_allow(&r.path, &ids.cap)?);
    }
    let result = spawn_restricted(token, &req);
    drop(guards);
    unsafe { CloseHandle(token) };
    result
}

fn spawn_restricted(token: HANDLE, req: &ExecRequest) -> Result<ExecOutput, RunError> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let mut out_r: HANDLE = std::ptr::null_mut();
        let mut out_w: HANDLE = std::ptr::null_mut();
        let mut err_r: HANDLE = std::ptr::null_mut();
        let mut err_w: HANDLE = std::ptr::null_mut();
        let close_all = |v: &[HANDLE]| {
            for h in v {
                if !h.is_null() {
                    CloseHandle(*h);
                }
            }
        };
        if CreatePipe(&mut out_r, &mut out_w, &sa, 0) == 0 {
            close_all(&[out_r, out_w]);
            return Err(RunError::Spawn("CreatePipe(stdout) 失败".into()));
        }
        if CreatePipe(&mut err_r, &mut err_w, &sa, 0) == 0 {
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn("CreatePipe(stderr) 失败".into()));
        }
        let cmdline = {
            let mut s = quote_cmdline(req);
            s.push('\0');
            wide(&s)
        };
        let env = env_block(&req.env);
        let cwd = wide(&req.cwd.to_string_lossy());
        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpReserved: std::ptr::null_mut(),
            lpDesktop: std::ptr::null_mut(),
            lpTitle: std::ptr::null_mut(),
            dwX: 0,
            dwY: 0,
            dwXSize: 0,
            dwYSize: 0,
            dwXCountChars: 0,
            dwYCountChars: 0,
            dwFillAttribute: 0,
            dwFlags: STARTF_USESTDHANDLES,
            wShowWindow: 0,
            cbReserved2: 0,
            lpReserved2: std::ptr::null_mut(),
            hStdInput: std::ptr::null_mut(),
            hStdOutput: out_w,
            hStdError: err_w,
        };
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            token,
            std::ptr::null(),
            cmdline.as_ptr() as *mut u16,
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_UNICODE_ENVIRONMENT,
            env.as_ptr() as *const c_void,
            cwd.as_ptr(),
            &si,
            &mut pi,
        );
        if ok == 0 {
            let code = GetLastError();
            // 1312=特权缺失原文码；5=ACCESS_DENIED（本地非提权 shell 的 CPAU 实际表现——
            // 两者同归"提权 shell/CI admin"环境依赖，登记偏差）
            if code == ERROR_PRIVILEGE_NOT_HELD || code == 5 {
                close_all(&[out_r, out_w, err_r, err_w]);
                return Err(RunError::Privilege(
                    "CreateProcessAsUserW 特权不足（SeAssignPrimaryToken/SeIncreaseQuota）；本地非提权会拒——CI 门禁见测面".into(),
                ));
            }
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn(format!(
                "CreateProcessAsUserW 失败 gle={code}"
            )));
        }
        CloseHandle(out_w);
        CloseHandle(err_w);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut exit_code: u32 = 1;
        GetExitCodeProcess(pi.hProcess, &mut exit_code);
        CloseHandle(pi.hProcess);
        let read_all = |h: HANDLE| -> String {
            use std::io::Read;
            use std::os::windows::io::{FromRawHandle, IntoRawHandle};
            let mut f = std::fs::File::from_raw_handle(h as _);
            let mut s = String::new();
            let _ = f.read_to_string(&mut s);
            let raw = f.into_raw_handle();
            CloseHandle(raw as HANDLE);
            s
        };
        let stdout = read_all(out_r);
        let stderr = read_all(err_r);
        Ok(ExecOutput {
            exit_code: Some(exit_code as i32),
            stdout,
            stderr,
        })
    }
}

fn quote_cmdline(req: &ExecRequest) -> String {
    let mut parts = vec![format!("\"{}\"", req.program.to_string_lossy())];
    parts.extend(req.args.iter().map(|a| format!("\"{a}\"")));
    parts.join(" ")
}

/// 线程探针（测试专用）：受限令牌挂当前线程执行闭包——同线程文件写经 WRITE_RESTRICTED
/// 判定，无需 CPAU 特权；测毕摘回。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::RootPath;

    /// 测脚手架根 ACL 规范化：`icacls /inheritance:r /grant:r %USERNAME%:(OI)(CI)F`——
    /// 本机 %TEMP% 根已被外部产品改写 ACE（继承不可信），CI/本地统一从干净 DACL 起步。
    fn scratch(name: &str) -> PathBuf {
        let t = std::env::temp_dir().join(format!("sc-sbx-win-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join("ws/.git/hooks")).unwrap();
        std::fs::write(t.join("sibling.txt"), b"host").unwrap();
        std::fs::write(t.join("ws/inside.txt"), b"host").unwrap();
        std::fs::write(t.join("ws/.git/config"), b"[x]").unwrap();
        let who = std::env::var("USERNAME").expect("USERNAME");
        let st = std::process::Command::new("icacls")
            .arg(&t)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("{who}:(OI)(CI)F"))
            .status()
            .expect("icacls present on windows runners");
        assert!(st.success(), "icacls normalize failed");
        t
    }

    /// 主令牌→模拟令牌（SetThreadToken 要求 impersonation 级别）。
    fn to_impersonation(primary: HANDLE) -> HANDLE {
        unsafe {
            let mut dup: HANDLE = std::ptr::null_mut();
            assert_ne!(
                DuplicateTokenEx(
                    primary,
                    TOKEN_QUERY | TOKEN_IMPERSONATE,
                    std::ptr::null(),
                    SecurityImpersonation,
                    TokenImpersonation,
                    &mut dup,
                ),
                0
            );
            dup
        }
    }

    /// 线程探针（辅助判据）：受限令牌挂当前线程执行闭包。注意——模拟档下读检查实测
    /// 亦对照 restricting 名单（win.ini/everyone-R 皆拒，本机实证），故本探针只用作
    /// **写闸两向**与 ws 内读（cap-allow 对象）判定；读轴全开档由子进程面+WP-03 整合裁定。
    fn with_restricted_thread<R: Send + 'static>(
        token: HANDLE,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> R {
        let raw = token as usize;
        std::thread::scope(|s| {
            s.spawn(move || {
                let tok = raw as HANDLE;
                let st = unsafe {
                    windows_sys::Win32::System::Threading::SetThreadToken(std::ptr::null(), tok)
                };
                assert_ne!(st, 0, "SetThreadToken 失败");
                let r = f();
                unsafe {
                    windows_sys::Win32::System::Threading::SetThreadToken(
                        std::ptr::null(),
                        std::ptr::null_mut(),
                    )
                };
                r
            })
            .join()
            .unwrap()
        })
    }

    /// 令牌+ACL 写闸语义线程探针（本地可证 CPAU 之外的核心形制）：根内新建/既有写=通，
    /// 根外写=拒，.git 写=拒、ws 内读=通（cap allow 覆盖）。
    #[test]
    fn restricted_token_write_gate_via_thread_probe() {
        let t = scratch("probe");
        let ids = collect_sids().unwrap();
        let token = build_restricted_token(&ids).unwrap();
        std::fs::create_dir_all(t.join("ws/.standardcode")).unwrap();
        let mut deny_guards = Vec::new();
        for p in [t.join("ws/.git"), t.join("ws/.standardcode")] {
            deny_guards.push(set_deny(&p, &ids.cap).unwrap());
        }
        let guard = grant_allow(&t.join("ws"), &ids.cap).unwrap();
        let ws = t.join("ws");
        let sib = t.join("sibling.txt");
        let imp = to_impersonation(token);
        let (w_new, w_exist, w_sibling, w_git, r_ws) = with_restricted_thread(imp, move || {
            (
                std::fs::write(ws.join("newfile.txt"), b"sb").is_ok(),
                std::fs::write(ws.join("inside.txt"), b"sb").is_ok(),
                std::fs::write(&sib, b"sb").is_err(),
                std::fs::write(ws.join(".git/config"), b"evil").is_err(),
                std::fs::read_to_string(ws.join("inside.txt")).is_ok(),
            )
        });
        drop(guard);
        drop(deny_guards);
        unsafe { CloseHandle(imp) };
        unsafe { CloseHandle(token) };
        assert!(w_new, "ws 内新建必须可写（capability allow）");
        assert!(w_exist, "ws 内既有文件必须可写");
        assert!(w_sibling, "ws 外写必须被拒（无 capability-ACE）");
        assert!(w_git, ".git 写必须被拒（deny 压继承）");
        assert!(r_ws, "ws 内读必须可用（cap allow）");
        let _ = std::fs::remove_dir_all(&t);
    }

    /// 真子进程跑 cmd.exe /C 单命令，返回 (success, stdout)。全链=受限令牌+CPAU+生产同形。
    fn child(t: &Path, name: &str, cmd: &str) -> Option<(bool, String)> {
        let _ = name;
        let pol = SandboxPolicy::workspace_write(vec![RootPath::real(t.join("ws"))]);
        let req = ExecRequest::new("cmd.exe", vec!["/C".into(), cmd.to_string()], t.join("ws"));
        match run(&req, &pol, &PolicyFacts::default()) {
            Ok(o) => {
                eprintln!("CHILD-RAN[{name}] exit={:?}", o.exit_code);
                Some((o.exit_code == Some(0), format!("{}{}", o.stdout, o.stderr)))
            }
            Err(RunError::Privilege(_)) => {
                assert!(
                    std::env::var("GITHUB_ACTIONS").is_err(),
                    "R1 门禁：windows job 内子进程 suite 不得走 Privilege-skip（零判别静默绿不成立）"
                );
                eprintln!("NOTE[{name}] 本地无 CPAU 特权，子进程面跳过（终判=CI CHILD-RAN 证据）");
                None
            }
            Err(e) => panic!("child run fail: {e}"),
        }
    }

    /// Windows 全链真隔离探针套件（DoD①④⑤ 之 windows 面；线程探针废弃原因登记结果页：
    /// SetThreadToken 模拟级别混入匿名判定，非生产形）。
    #[test]
    fn windows_child_isolation_suite() {
        let t = scratch("suite");
        // ws 内新建成功（capability allow 继承）
        let Some((ok, o)) = child(
            &t,
            "w-new",
            &format!("echo x> {}", t.join("ws/new.txt").display()),
        ) else {
            let _ = std::fs::remove_dir_all(&t);
            return;
        };
        assert!(ok, "ws write: {o}");
        assert!(t.join("ws/new.txt").exists());
        let (ok, _) = child(
            &t,
            "w-exist",
            &format!("echo x> {}", t.join("ws/inside.txt").display()),
        )
        .unwrap();
        assert!(ok);
        let (ok, _) = child(
            &t,
            "w-out",
            &format!("echo x> {}", t.join("sibling.txt").display()),
        )
        .unwrap();
        assert!(!ok, "outside write must be denied");
        assert_eq!(
            std::fs::read_to_string(t.join("sibling.txt")).unwrap(),
            "host"
        );
        // ws 外读=restricting 名单对照档（本机实证；"全盘可读"在 windows legacy 后端=仅
        // everyone/logon/cap 授权对象可读——偏差登记，ws 内读走 cap allow 属 DoD 判据）
        // 元数据保护：.git 内容写失败 / 读成功 / hooks 新建失败
        let (ok, _) = child(
            &t,
            "w-git",
            &format!("echo x> {}", t.join("ws/.git/config").display()),
        )
        .unwrap();
        assert!(!ok, ".git config write must be denied");
        let (ok, o) = child(
            &t,
            "r-git",
            &format!("type {}", t.join("ws/.git/config").display()),
        )
        .unwrap();
        assert!(ok, ".git read must work: {o}");
        let (ok, _) = child(
            &t,
            "w-hooks",
            &format!("echo x> {}", t.join("ws/.git/hooks/pre-commit").display()),
        )
        .unwrap();
        assert!(!ok, ".git/hooks create must be denied");
        let (ok, _) = child(
            &t,
            "w-sc",
            &format!("mkdir {} 2>&1", t.join("ws/.standardcode/sub").display()),
        )
        .unwrap();
        assert!(!ok, ".standardcode/sub mkdir must be denied");
        let _ = std::fs::remove_dir_all(&t);
    }

    /// 受限令牌结构断言（R1b：不依赖 CPAU 的本地直接证据）：restricting 名单恰三员
    /// 且序=[cap, logon, everyone]（Codex §1.6 行 461 序硬约定的可验形）。
    #[test]
    fn restricted_token_structure_three_members() {
        use windows_sys::Win32::Security::{EqualSid, TokenRestrictedSids};
        let ids = collect_sids().unwrap();
        let token = build_restricted_token(&ids).unwrap();
        unsafe {
            let mut need: u32 = 0;
            GetTokenInformation(
                token,
                TokenRestrictedSids,
                std::ptr::null_mut(),
                0,
                &mut need,
            );
            assert!(need > 0, "TokenRestrictedSids 长度查询失败");
            let mut buf = vec![0u8; need as usize];
            assert_ne!(
                GetTokenInformation(
                    token,
                    TokenRestrictedSids,
                    buf.as_mut_ptr() as *mut c_void,
                    need,
                    &mut need,
                ),
                0
            );
            let tg = &*(buf.as_ptr() as *const TOKEN_GROUPS);
            assert_eq!(tg.GroupCount, 3, "restricting 名单三员");
            let g = std::slice::from_raw_parts(tg.Groups.as_ptr(), 3);
            assert_ne!(EqualSid(g[0].Sid, ids.cap.psid), 0, "员0=capability");
            assert_ne!(EqualSid(g[1].Sid, ids.logon as *mut _), 0, "员1=logon");
            assert_ne!(
                EqualSid(g[2].Sid, ids.everyone as *mut _),
                0,
                "员2=everyone"
            );
            CloseHandle(token);
        }
    }

    #[test]
    fn env_block_layout() {
        let env = [
            ("A".to_string(), "1".to_string()),
            ("B".to_string(), "2".to_string()),
        ]
        .into_iter()
        .collect();
        let b = env_block(&env);
        let text = String::from_utf16_lossy(&b);
        assert!(text.starts_with("A=1\0B=2\0\0"), "{text:?}");
    }

    #[test]
    fn protected_paths_expansion() {
        let pol = SandboxPolicy::workspace_write(vec![RootPath::real("C:/repo")]);
        let ps = protected_paths(&pol);
        assert!(ps.contains(&PathBuf::from("C:/repo/.git")));
        assert!(ps.contains(&PathBuf::from("C:/repo/.standardcode")));
        assert!(ps.contains(&PathBuf::from("C:/repo/.git/hooks")));
    }
}
