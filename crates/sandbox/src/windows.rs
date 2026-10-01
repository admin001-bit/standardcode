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
//! 子进程 CreateProcessAsUserW 需 SeAssignPrimaryToken/SeIncreaseQuota：实证 GH runner 与本地
//! Medium IL 皆无此特权（run 35051971812 R1 门禁 panic）——子进程 suite 曾 #[ignore]（BLK-04=①）；
//! 同模块**线程探针**（SetThreadToken）本地覆盖写闸双向与 ACL 语义判据，子进程全链交
//! 提权环境 `--ignored` 补跑（CHILD-RAN 后补形制）/WP-03 宿主接线首触实机。
//! 【勘误 2026-09-29 F22/F25】"CPAU 特权依赖"前提证伪：历史 panic/错误帧真因=句柄掩码缺
//! TOKEN_ASSIGN_PRIMARY＋CreateRestrictedToken 旗标错位（真 WRITE_RESTRICTED 从未传）——修复后
//! **无特权环境即可执行**（本机非提权实测 CHILD-RAN 全绿）；suite 已去 #[ignore] 入常规门。
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
    SID_IDENTIFIER_AUTHORITY, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_QUERY,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    STARTUPINFOW,
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
// F25（2026-09-29 实测订正）：原手写 LUA_TOKEN=0x2、WRITE_RESTRICTED=0x4 皆错位——
// 真值见 windows-sys Win32::Security：SANDBOX_INERT=2、LUA_TOKEN=4、WRITE_RESTRICTED=8。
// 错位后果=实际只传了 DMP|SANDBOX_INERT|LUA，**真 WRITE_RESTRICTED 从未传过**：受限令牌
// 对**读**也执行 restrict-SID 交集（write-restricted 才豁免读）→ 子进程读 System32 DLL 被拒
// → 全部子命令 0xC0000135/exit=1（whoami/cmd 无一幸免；ws 因 cap SID 显式 grant 未暴露——
// 线程探针只碰 ws 故 CI 常绿）。修＝按真值传 DMP|LUA|WRITE_RESTRICTED。
const LUA_TOKEN: u32 = 0x0000_0004;
const WRITE_RESTRICTED: u32 = 0x0000_0008;
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
/// deny 掩码=写族位（WRITE_RESTRICTED 只管写，deny ACE 亦只管写族——含读位会误伤
/// "全盘可读"档：FILE_WRITE_DATA|APPEND|WRITE_EA|WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER）
const WRITE_FAMILY_MASK: u32 = 0x2 | 0x4 | 0x10 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
/// F23（2026-09-29 实测订正）：原手写 1312 实为 ERROR_NO_SUCH_LOGON_SESSION；真
/// ERROR_PRIVILEGE_NOT_HELD=1314（windows-sys Win32::Foundation 同值；Win32Exception(1314)
/// =「客户端没有所需的特权」亲测）——原值令真实特权缺失永不命中本分支。
const ERROR_PRIVILEGE_NOT_HELD: WIN32_ERROR = 1314;
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
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut cur,
        ) == 0
        {
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
    // F24（2026-09-29 实测）：API 要求块双 NUL 终止——空 map 此前只落单个 0，
    // CreateProcessAsUserW 读过界，结果随堆运气在 gle=87 与 gle=0 间漂移
    // （同码修复两跑不同果的实测解释；C# 复刻 2 字节空块恒 gle=0 对照）。
    if env.is_empty() {
        v.push(0);
    }
    v
}

/// S8-6（全仓审查 2026-10-01）：ACL 全局互斥——「快照-整段替换-还原」（AclGuard）是进程级共享
/// 状态，而 serve 每请求独立线程并发执行：交织时 B 的快照捕获 A 的中间态、A 还原抹掉 B 的
/// grant（在飞命令随机全拒）、B 还原沉积 A 的残留 ACE（终致 SetEntriesInAclW 失败）。
/// 全程串行化（apply→spawn 等待→还原）拿正确性换吞吐 [自定]；毒丸恢复=panic 后仍可继续。
static ACL_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 真执行：令牌+ACL+CreateProcessAsUserW（同步等待，捕获双管道）。返回 (子进程 pid, 产物)。
pub fn run(
    req: &ExecRequest,
    policy: &SandboxPolicy,
    facts: &PolicyFacts,
) -> Result<(u32, ExecOutput), RunError> {
    // 策略闸下沉至平台入口（同 linux.rs 注；WFP 面=elevated 后端不做，登记偏差）
    let mut req = req.clone();
    crate::run::apply_proxy_policy(&mut req.env, policy);
    let compiled = compile(&req, policy, facts, Platform::Windows)?;
    if compiled.sandbox == SandboxType::None {
        return plain_exec(&req);
    }
    // S8-6：ACL 临界区——覆盖 collect→set_deny/grant_allow→spawn 等待→drop(guards) 还原全程
    //（声明先于 guards ⇒ 作用域结束时 guards 先还原、锁最后释放，顺序正确）。
    let _acl_gate = ACL_GATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

fn spawn_restricted(token: HANDLE, req: &ExecRequest) -> Result<(u32, ExecOutput), RunError> {
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
        // S8-3（全仓审查 2026-10-01）：句柄继承白名单——原裸 bInheritHandles=1 无名单：请求 A 的
        // 管道可被请求 B 的沙箱命令继承（跨请求读/篡改他命令 stdout＝输出投毒），宿主 JSON IPC
        // 管道句柄亦可泄入沙箱命令绕 ACL 读写帧。经 STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_HANDLE_LIST
        // 把继承集收敛为**仅本请求的两个写端**。
        let mut attr_size: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size); // 期望 false+ERROR_INSUFFICIENT_BUFFER，回填 size
        if attr_size == 0 {
            let gle = GetLastError();
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn(format!(
                "InitializeProcThreadAttributeList(sizing) 失败 gle={gle}"
            )));
        }
        let attr_layout =
            match std::alloc::Layout::from_size_align(attr_size, std::mem::align_of::<usize>()) {
                Ok(l) => l,
                Err(_) => {
                    close_all(&[out_r, out_w, err_r, err_w]);
                    return Err(RunError::Spawn("attribute list layout 不可表示".into()));
                }
            };
        let attr_ptr = std::alloc::alloc(attr_layout);
        if attr_ptr.is_null() {
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn("attribute list 分配失败".into()));
        }
        /// RAII：CreateProcess 完成（含其后早退）即析构属性表——防泄漏/悬垂 attribute list。
        struct AttrListGuard(*mut u8, std::alloc::Layout);
        impl Drop for AttrListGuard {
            fn drop(&mut self) {
                unsafe {
                    DeleteProcThreadAttributeList(self.0 as _);
                    std::alloc::dealloc(self.0, self.1);
                }
            }
        }
        let _attr = AttrListGuard(attr_ptr, attr_layout);
        if InitializeProcThreadAttributeList(attr_ptr as _, 1, 0, &mut attr_size) == 0 {
            let gle = GetLastError();
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn(format!(
                "InitializeProcThreadAttributeList 失败 gle={gle}"
            )));
        }
        let inherit_list: [HANDLE; 2] = [out_w, err_w];
        if UpdateProcThreadAttribute(
            attr_ptr as _,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherit_list.as_ptr() as *const c_void,
            std::mem::size_of::<HANDLE>() * 2,
            std::ptr::null_mut(),
            std::ptr::null(),
        ) == 0
        {
            let gle = GetLastError();
            close_all(&[out_r, out_w, err_r, err_w]);
            return Err(RunError::Spawn(format!(
                "UpdateProcThreadAttribute 失败 gle={gle}"
            )));
        }
        let si = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
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
            },
            lpAttributeList: attr_ptr as _,
        };
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            token,
            std::ptr::null(),
            cmdline.as_ptr() as *mut u16,
            std::ptr::null(),
            std::ptr::null(),
            1, // bInheritHandles：TRUE＋HANDLE_LIST 属性＝名单外句柄一律不继承
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env.as_ptr() as *const c_void,
            cwd.as_ptr(),
            &si.StartupInfo,
            &mut pi,
        );
        if ok == 0 {
            let code = GetLastError();
            // F22/F23（2026-09-29 实测订正）：1314=真特权缺失（原手写 1312 实为
            // NO_SUCH_LOGON_SESSION，见常量处 F23）；5=ACCESS_DENIED 曾被误归特权——
            // 真因是 build_restricted_token 句柄掩码缺 TOKEN_ASSIGN_PRIMARY（F22 修复后
            // 本机非提权实测 spawn 成功）；5 现保留作防御性归类。
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
            // F27（2026-09-29 实测）：原 read_to_string 遇非 UTF-8 字节（中文 Windows 下 cmd 的
            // CP936/GBK 输出——ver/dir-full/错误提示等）报 InvalidData 且 std 把本次缓冲截回
            // 入口长度 → **整段输出静默归零**（合并命令连 ASCII 段一并丢）；plain 臂
            // （run.rs plain_exec）用 from_utf8_lossy 无此病。改与 plain 同口径：读字节 + lossy。
            let mut buf = Vec::new();
            let _ = f.read_to_end(&mut buf);
            let raw = f.into_raw_handle();
            CloseHandle(raw as HANDLE);
            String::from_utf8_lossy(&buf).into_owned()
        };
        let stdout = read_all(out_r);
        let stderr = read_all(err_r);
        Ok((
            pi.dwProcessId,
            ExecOutput {
                exit_code: Some(exit_code as i32),
                stdout,
                stderr,
            },
        ))
    }
}

fn quote_cmdline(req: &ExecRequest) -> String {
    // F26（2026-09-29 实测订正）：原「无差别给每个参数包引号」——cmd.exe **不认带引号的开关**
    // （`"/C"` 被误解析：实测报"文件名、目录名或卷标语法不正确"/`'"echo hi' 不是内部或外部命令`、
    // exit=1 零落盘；裸开关形 exit=0 落盘）。且 Windows 侧宿主（bash.ts）对命令体已按 verbatim
    // 预包装引号（`"cmd"`），二次包裹同样致坏。现形制＝MSVCRT 常规三则：
    //   ①入参已带成对引号 → 原样透传（宿主预包装，不二次包裹）；②需转义形（空白/内部引号/尾反斜杠/
    //     空串）→ 包引号并按 MSVCRT 规则转义；③其余（含 `/d` `/C` 类开关、裸名、单词路径）→ 不包。
    // S8-5（全仓审查 2026-10-01）：原②只查空白——参数含内部 `"`（`x"y z`→`"x"y z"` 按
    // CommandLineToArgvW 拆成两参）或尾部反斜杠（`C:\p\` 收尾引号被 `\"` 吞）时拆词错乱；补
    // 引号内转义（引号前反斜杠 2n+1）与结尾反斜杠加倍（2n）的标准 MSVCRT quoting。
    let quote = |a: &str| -> String {
        if a.len() >= 2 && a.starts_with('"') && a.ends_with('"') {
            a.to_string()
        } else if a.is_empty() {
            "\"\"".to_string()
        } else if a.contains(' ') || a.contains('\t') || a.contains('"') || a.ends_with('\\') {
            let mut out = String::from("\"");
            let mut backslashes = 0usize;
            for ch in a.chars() {
                match ch {
                    '\\' => backslashes += 1,
                    '"' => {
                        out.push_str(&"\\".repeat(backslashes * 2 + 1));
                        out.push('"');
                        backslashes = 0;
                    }
                    _ => {
                        if backslashes > 0 {
                            out.push_str(&"\\".repeat(backslashes));
                            backslashes = 0;
                        }
                        out.push(ch);
                    }
                }
            }
            if backslashes > 0 {
                out.push_str(&"\\".repeat(backslashes * 2)); // 结尾反斜杠（收尾引号前）加倍
            }
            out.push('"');
            out
        } else {
            a.to_string()
        }
    };
    let mut parts = vec![quote(&req.program.to_string_lossy())];
    parts.extend(req.args.iter().map(|a| quote(a)));
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
    /// 亦对照 restricting 名单（本机实证两观察：win.ini Users-only 拒 / 显式 everyone-R 通），故本探针只用作
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
        // ACL 直查三段前置断言（无特权硬校验面）
        assert!(
            dacl_has_ace(&t.join("ws"), ids.cap.psid, false, FILE_ALL_ACCESS),
            "grant ACE missing"
        );
        assert!(
            dacl_has_ace(&t.join("ws/.git"), ids.cap.psid, true, WRITE_FAMILY_MASK),
            "deny ACE missing"
        );
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
        // 还原断言：guard drop 后 cap ACE 消失（grant/deny 对称）
        assert!(
            !dacl_has_ace(&t.join("ws"), ids.cap.psid, false, FILE_ALL_ACCESS),
            "grant ACE must be restored away"
        );
        assert!(
            !dacl_has_ace(&t.join("ws/.git"), ids.cap.psid, true, WRITE_FAMILY_MASK),
            "deny ACE must be restored away"
        );
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
        let mut req = ExecRequest::new("cmd.exe", vec!["/C".into(), cmd.to_string()], t.join("ws"));
        // 镜像生产面（TS 侧恒传 sanitize 后的进程 env）：空 env 下子进程 cmd 无
        // SystemRoot/ComSpec 等基本变量（实测 exit=1 空输出）——原空 env 属测试构造失真。
        req.env = std::env::vars().collect();
        match run(&req, &pol, &PolicyFacts::default()) {
            Ok((_pid, o)) => {
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

    /// S8-6（全仓审查 2026-10-01）：run() 全程持 ACL_GATE——手动占锁后并发 run 必须阻塞
    ///（原无互斥：serve 每请求一线程，AclGuard「快照-整段替换-还原」交织互踩——中途抹他人
    /// grant=命令随机全拒、残留 ACE 沉积）。判别形：占锁 500ms 内 run 不得完成。
    #[test]
    fn s8_6_run_serialized_on_acl_gate() {
        let t = scratch("s86");
        let held = super::ACL_GATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let t2 = t.clone();
        let h = std::thread::spawn(move || {
            let pol = SandboxPolicy::workspace_write(vec![RootPath::real(t2.join("ws"))]);
            let mut req = ExecRequest::new(
                "cmd.exe",
                vec!["/C".into(), "echo ok".into()],
                t2.join("ws"),
            );
            req.env = std::env::vars().collect();
            run(&req, &pol, &PolicyFacts::default())
        });
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(
            !h.is_finished(),
            "run 未被 ACL_GATE 串行化（并发 ACL 互踩回归）"
        );
        drop(held);
        let r = h.join().expect("worker");
        assert!(r.is_ok(), "gate 释放后 run 应成功: {r:?}");
        let _ = std::fs::remove_dir_all(&t);
    }

    /// Windows 全链真隔离探针套件（DoD①④⑤ 之 windows 面；线程探针废弃原因登记结果页：
    /// SetThreadToken 模拟级别混入匿名判定，非生产形）。
    /// 原 BLK-04"CPAU=提权环境依赖"前提经 F22/F25 证伪（真因=句柄掩码/旗标缺陷非特权缺失；
    /// 【勘误 2026-09-29】）——修复后无特权环境即实跑，suite 去 #[ignore] 入常规测试门；
    /// child() 内 R1 门禁保留：若真特权缺失（1314/5）在 CI 出现仍 panic（fail-closed 不静默）。
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
            &format!(
                "type {}",
                t.join("ws").join(".git").join("config").display()
            ),
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
        // F27 回归：本地化（CP936/GBK）输出不得整体丢弃——ver 输出含非 ASCII 字节，
        // read_to_string 遇之截断归零（本机中文 Windows 下修复前 o 为 ""）。ASCII 机器（CI
        // en-US）上为恒绿的无害面，中文环境为判别针。
        let Some((_, o)) = child(&t, "ver-capture", "ver") else {
            let _ = std::fs::remove_dir_all(&t);
            return;
        };
        assert!(o.contains("Microsoft"), "本地化输出被丢弃（F27）: {o:?}");
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

    /// DACL 直查：path 上是否存在 [ace_type 允许(0)/拒绝(1)] 且 trustee=psid 且 mask 匹配的 ACE。
    /// ACL 生效面的无特权硬校验（grant/deny/还原三段断言共用）。
    fn dacl_has_ace(path: &Path, psid: *mut c_void, want_deny: bool, want_mask: u32) -> bool {
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct Acl {
            acl_revision: u8,
            sbz1: u8,
            acl_size: u16,
            ace_count: u16,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct AceHeader {
            ace_type: u8,
            ace_flags: u8,
            size: u16,
        }
        const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
        const ACCESS_DENIED_ACE_TYPE: u8 = 1;
        unsafe {
            let wp = wide(&path.to_string_lossy());
            let mut owner: *mut c_void = std::ptr::null_mut();
            let mut group: *mut c_void = std::ptr::null_mut();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetNamedSecurityInfoW(
                wp.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                &mut owner,
                &mut group,
                &mut dacl,
                &mut std::ptr::null_mut(),
                &mut sd,
            );
            if rc != 0 || dacl.is_null() {
                if !sd.is_null() {
                    LocalFree(sd as _);
                }
                return false;
            }
            let hdr = &*(dacl as *const Acl);
            // ACL 头 6 字节按 4 字节对齐，首个 ACE 自偏移 8 起（winnt.h 语义）
            let mut off: u16 = 8;
            let want_type = if want_deny {
                ACCESS_DENIED_ACE_TYPE
            } else {
                ACCESS_ALLOWED_ACE_TYPE
            };
            let mut found = false;
            for _ in 0..hdr.ace_count {
                let base = (dacl as *mut u8).add(off as usize);
                let ah = &*(base as *const AceHeader);
                if ah.ace_type == want_type {
                    // ACCESS_ALLOWED/DENY_ACE: Header(4) + Mask(4) + Sid(8+)
                    let mask = (base.add(4) as *const u32).read_unaligned();
                    let sid = base.add(8);
                    if !sid.is_null()
                        && windows_sys::Win32::Security::EqualSid(sid as *mut _, psid) != 0
                        && (mask == want_mask
                            || (want_mask == FILE_ALL_ACCESS && mask & 0x1000_0000 != 0))
                    // SetEntriesInAcl 规整 FILE_ALL_ACCESS→GENERIC_ALL
                    {
                        found = true;
                    }
                }
                if ah.size == 0 {
                    break;
                }
                off += ah.size;
            }
            LocalFree(sd as _);
            found
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
    fn env_block_empty_double_null_f24() {
        // F24：空 map 必须双 NUL（API 契约；单 NUL 会读过界 → gle=87 与 gle=0 随堆运气漂移）。
        let b = env_block(&std::collections::BTreeMap::new());
        assert_eq!(b, vec![0u16, 0]);
    }

    #[test]
    fn quote_cmdline_rules_f26() {
        // F26：开关不包引号（cmd.exe 不认 "/C"）；宿主预包装的成对引号原样透传；空白才包裹。
        let mk = |program: &str, args: &[&str]| {
            quote_cmdline(&ExecRequest::new(
                program,
                args.iter().map(|s| s.to_string()).collect(),
                "C:/x",
            ))
        };
        assert_eq!(
            mk("cmd.exe", &["/C", "echo hi> a.txt"]),
            r#"cmd.exe /C "echo hi> a.txt""#
        );
        assert_eq!(
            mk("cmd.exe", &["/d", "/s", "/c", r#""echo x> y.txt""#]),
            r#"cmd.exe /d /s /c "echo x> y.txt""#
        );
        assert_eq!(mk("whoami.exe", &[]), "whoami.exe");
        assert_eq!(mk("p.exe", &[""]), r#"p.exe """#);
    }

    /// S8-5：真拆词验证——用系统 CommandLineToArgvW（MSVCRT 规则的权威实现）回读 quote_cmdline 产物。
    fn parse_via_argv0(cmdline: &str) -> Vec<String> {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        let mut wide: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut argc = 0i32;
            let argv = windows_sys::Win32::UI::Shell::CommandLineToArgvW(wide.as_ptr(), &mut argc);
            assert!(!argv.is_null());
            let out = (0..argc)
                .map(|i| {
                    let p = *argv.add(i as usize);
                    let mut len = 0usize;
                    while *p.add(len) != 0 {
                        len += 1;
                    }
                    OsString::from_wide(std::slice::from_raw_parts(p, len))
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            windows_sys::Win32::Foundation::LocalFree(argv as *mut _);
            wide.clear(); // keep alive until parse done
            out
        }
    }

    #[test]
    fn quote_cmdline_s8_5_msvcrt_roundtrip() {
        // S8-5（全仓审查 2026-10-01）：含内部引号/尾反斜杠/空白的参数经系统解析器回读后逐字相等——
        // 原形（只包不转义）在这些输入下拆词错乱（`x"y z` 拆成两参）。
        let mk = |program: &str, args: &[&str]| {
            quote_cmdline(&ExecRequest::new(
                program,
                args.iter().map(|s| s.to_string()).collect(),
                "C:/x",
            ))
        };
        for arg in [
            r#"x"y z"#,              // 内部引号+空白（原拆两参）
            r#"plain"quote"#,        // 内部引号无空白（原裸引号错乱）
            r#"C:\dir with space\"#, // 尾反斜杠+空白（收尾引号被吞）
            r#"C:\plain\"#,          // 尾反斜杠无空白
            "no-escape-needed",      // 无需转义形零扰动
            "",                      // 空串
            r#"pre"wrapped"#,        // 非成对预包（含引号但首尾非成对）→ 转义包裹
        ] {
            let line = mk("prog.exe", &[arg]);
            let parsed = parse_via_argv0(&line);
            assert_eq!(
                &parsed[1..],
                &[arg.to_string()],
                "roundtrip failed for {arg:?} via {line:?}"
            );
        }
        // 成对预包透传（F26 宿主形）+ 开关不包（F26）保持
        assert_eq!(
            mk("cmd.exe", &["/d", "/s", "/c", r#""echo x> y.txt""#]),
            r#"cmd.exe /d /s /c "echo x> y.txt""#
        );
        assert_eq!(
            parse_via_argv0(&mk("cmd.exe", &["/C", "echo hi"])),
            vec![
                "cmd.exe".to_string(),
                "/C".to_string(),
                "echo hi".to_string()
            ]
        );
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
